/**
 * Deterministic engine-cache probe (no LLM). Mimics the edit patterns of the
 * three multi-turn context modes on one workflow and asserts which operators
 * execute fresh vs complete from cache.
 *
 *   E1 baseline      A->B->C            expect all fresh
 *   E2 identical     A->B->C            expect all cached      (every mode: re-execute)
 *   E3 extend +D     (B->D)             expect only D fresh    (session/v38 pattern)
 *   E4 modify leaf   C'                 expect only C fresh    (QO rewrite pattern)
 *   E5 revert leaf   C                  expect all cached      (QO toggle-back)
 *   E6 modify root   A'                 expect A,B,C fresh     (upstream invalidation)
 *   E7 identical     A'                 expect all cached
 *   E8 subplan A->B  pruned plan        expect all cached      (pruned-turn shape)
 *   E9 idle >30s     identical          expect all cached      (idle-teardown regression)
 *
 * Usage: cd agent-service && bun run benchmark/e2e/cache-probe.ts
 */
import { createWorkflow, executeWorkflowSync, login } from "../../src/api";

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const CUID = Number(process.env.PROBE_CUID ?? "1");
const CSV = process.env.PROBE_CSV ?? "/tmp/cache-probe.csv";

function opLoad(id: string, code: string) {
  return {
    operatorID: id, operatorType: "DataLoading", code,
    inputPorts: [], outputPorts: [{ portID: "output-0", displayName: "", disallowMultiInputs: false, isDynamicPort: false }],
  };
}
function opProc(id: string, code: string) {
  return {
    operatorID: id, operatorType: "DataProcessing", code,
    inputPorts: [{ portID: "input-0", displayName: "input_0", disallowMultiInputs: false, isDynamicPort: false, dependencies: [] }],
    outputPorts: [{ portID: "output-0", displayName: "", disallowMultiInputs: false, isDynamicPort: false }],
  };
}
const link = (from: string, to: string) => ({
  fromOpId: from, fromPortId: { id: 0, internal: false },
  toOpId: to, toPortId: { id: 0, internal: false },
});

const A = (v: number) => opLoad("probe_a", `def load():\n    return pd.read_csv('${CSV}')  # v${v}`);
const B = opProc("probe_b", "def process(probe_a):\n    return probe_a.assign(y=probe_a['x']*2)");
const C = (v: number) => opProc("probe_c", `def process(probe_b):\n    return probe_b.assign(z=probe_b['y']+${v})`);
const D = opProc("probe_d", "def process(probe_b):\n    return probe_b.groupby('g', as_index=False)['y'].sum()");

async function main() {
  const token = await login(USERNAME, PASSWORD);
  const wid = await createWorkflow(token, "cache-probe-" + Date.now(), {
    operators: [], operatorPositions: {}, links: [], commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  } as any);
  console.log("wid", wid);

  const mk = (ops: any[], links: any[], view: string[]) => ({ operators: ops, links, opsToViewResult: view });

  const steps = [
    { name: "E1 baseline",  plan: mk([A(1), B, C(1)], [link("probe_a","probe_b"), link("probe_b","probe_c")], ["probe_c"]),
      expectFresh: ["probe_a","probe_b","probe_c"], expectCached: [] as string[] },
    { name: "E2 identical", plan: mk([A(1), B, C(1)], [link("probe_a","probe_b"), link("probe_b","probe_c")], ["probe_c"]),
      expectFresh: [] as string[], expectCached: ["probe_a","probe_b","probe_c"] },
    { name: "E3 extend +D", plan: mk([A(1), B, C(1), D], [link("probe_a","probe_b"), link("probe_b","probe_c"), link("probe_b","probe_d")], ["probe_d"]),
      expectFresh: ["probe_d"], expectCached: ["probe_a","probe_b"] },
    { name: "E4 modify C",  plan: mk([A(1), B, C(2), D], [link("probe_a","probe_b"), link("probe_b","probe_c"), link("probe_b","probe_d")], ["probe_c"]),
      expectFresh: ["probe_c"], expectCached: ["probe_a","probe_b"] },
    { name: "E5 revert C",  plan: mk([A(1), B, C(1), D], [link("probe_a","probe_b"), link("probe_b","probe_c"), link("probe_b","probe_d")], ["probe_c"]),
      expectFresh: [], expectCached: ["probe_a","probe_b","probe_c"] },
    { name: "E6 modify A",  plan: mk([A(2), B, C(1), D], [link("probe_a","probe_b"), link("probe_b","probe_c"), link("probe_b","probe_d")], ["probe_c"]),
      expectFresh: ["probe_a","probe_b","probe_c"], expectCached: [] },
    { name: "E7 identical", plan: mk([A(2), B, C(1), D], [link("probe_a","probe_b"), link("probe_b","probe_c"), link("probe_b","probe_d")], ["probe_c"]),
      expectFresh: [], expectCached: ["probe_a","probe_b","probe_c"] },
    { name: "E8 subplan A->B", plan: mk([A(2), B], [link("probe_a","probe_b")], ["probe_b"]),
      expectFresh: [], expectCached: ["probe_a","probe_b"] },
    // Regression test for the idle-teardown cache wipe: the workflow lifecycle
    // manager fires 30s after idle and used to invalidate every cache row the
    // workflow produced. Wait past the deadline, then re-execute unchanged.
    { name: "E9 idle >30s then identical", waitSeconds: 45,
      plan: mk([A(2), B, C(1), D], [link("probe_a","probe_b"), link("probe_b","probe_c"), link("probe_b","probe_d")], ["probe_c"]),
      expectFresh: [], expectCached: ["probe_a","probe_b","probe_c"] },
  ];

  // The sync result only carries the VIEWED target op, so per-step assertions
  // check that op's state (Completed = fresh, CompletedFromCache = replayed)
  // plus its rows. The full fresh-vs-skipped set is cross-checked from the
  // master log ("Port materialized" lines carry wid/eid) — see the epilogue.
  let failures = 0;
  for (const s of steps as Array<(typeof steps)[number] & { waitSeconds?: number }>) {
    if (s.waitSeconds) {
      console.log(`(idling ${s.waitSeconds}s to let the lifecycle deadline fire...)`);
      await new Promise(res => setTimeout(res, s.waitSeconds * 1000));
    }
    const r = await executeWorkflowSync(token, wid, s.plan as any, {
      executionName: s.name, timeoutSeconds: 180, computingUnitId: CUID,
    });
    const viewed = (s.plan as any).opsToViewResult[0] as string;
    const info = (r.operators ?? {})[viewed] as any;
    const expectState = (s.expectFresh as string[]).includes(viewed) ? "Completed" : "CompletedFromCache";
    const rows = info?.result?.length ?? 0;
    const ok = r.success && info?.state === expectState && rows > 0;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} ${s.name}: success=${r.success} ${viewed}.state=${info?.state} rows=${rows} (expected ${expectState})${r.errors?.length ? " errors=" + JSON.stringify(r.errors) : ""}`);
  }
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  console.log("probe wid for log/db cross-check:", wid);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
