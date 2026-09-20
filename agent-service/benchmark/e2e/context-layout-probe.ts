/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * LATEST message-layout comparison for the native V2 catalog.
 *
 * Candidate layouts, all "one user message per operator in creation order",
 * differing only in what each operator's message carries and whether the
 * observation lives with it:
 *
 *   today   current opSplit: the observation renders only while the operator
 *           is in the live `observe` list, otherwise the block collapses to
 *           `result not requested` — and `Inputs:`/`Properties:` swap order
 *           between the two paths.
 *   sticky  the operator keeps its most recent observation (or its unrepaired
 *           error) until it is re-executed or redefined. Canonical field order.
 *   split   operator messages hold definitions only; every current observation
 *           moves to one trailing message.
 *   history the operator's message accumulates every revision it has had,
 *           each with the result that revision produced.
 *
 * Observation bytes come from the real frozen `NativeObservation`s, so this
 * compares FRAMINGS of identical content. `today` is reconstructed and checked
 * against the production renderer before any layout is scored.
 *
 *   bun run benchmark/e2e/context-layout-probe.ts
 */

import { AgentMode, ContextMode } from "../../src/types/agent";
import { assembleContext, estimateTokens } from "../../src/agent/util/context-utils";
import { restrictNativeObservation } from "../../src/agent/native/evidence";
import { buildNativeModeSystemPrompt } from "../../src/agent/prompts";
import { fixture, TRAJECTORY } from "./context-cost-probe";
import type { ModelMessage } from "ai";

const RATE = { uncached: 2 / 1e6, cached: 0.2 / 1e6, output: 12 / 1e6 };
const OUTPUT_TOKENS_PER_STEP = 125;
const EVIDENCE = { data: true, flow: true, maxChars: 2000 };

type Layout = "today" | "sticky" | "split" | "history" | "hybrid";

export interface Block {
  id: string;
  type: string;
  inputs: string[];
  properties: string;
  /** Most recent model-facing observation text, or undefined if never observed. */
  observation?: string;
  /** Rows reported by the engine, for the `result not requested` line. */
  rows?: number;
  /** Unrepaired diagnostic: retained until this operator is successfully rewritten. */
  error?: string;
  /** `history` layout: every revision this operator has had, oldest first. */
  revisions: string[];
}

const header = (b: Block) => `### ${b.type.toLowerCase()} operator \`${b.id}\``;
const inputsLine = (b: Block) => `Inputs: ${b.inputs.join(", ") || "none"}`;
const propsLine = (b: Block) => `Properties: ${b.properties}`;

export function renderBlock(b: Block, layout: Layout, observed: boolean): string {
  const lines = [header(b)];
  if (layout === "today") {
    // Reproduce the production field order exactly, including its flip.
    if (observed) {
      if (b.type !== "UDF") lines.push(propsLine(b));
      // formatOperatorAdjacency omits the line entirely for a source operator.
      if (b.inputs.length) lines.push(inputsLine(b));
    } else {
      lines.push(inputsLine(b), propsLine(b));
    }
  } else {
    lines.push(inputsLine(b), propsLine(b));
  }

  if (layout === "history") {
    lines.push(...b.revisions);
    return lines.join("\n");
  }
  if (layout === "split") return lines.join("\n");
  if (layout === "hybrid") {
    // Everything here is a pure function of this operator and the result it
    // produced — never of which step we are on, so the block is stable.
    if (b.error) lines.push(`Result: [ERROR] ${b.error}`);
    else if (b.observation) lines.push(...b.observation.split("\n").slice(0, 2).map(l => "  " + l));
    else if (b.rows !== undefined) lines.push(`Result: executed, ${b.rows} rows`);
    return lines.join("\n");
  }

  const body = layout === "today" ? (observed ? b.observation : undefined) : (b.error ?? b.observation);
  if (b.error && layout !== "today") lines.push(`Result: [ERROR] ${b.error}`);
  else if (body) lines.push("Result:", ...body.split("\n").map(l => "  " + l));
  else if (b.rows !== undefined) lines.push(`Result: executed, ${b.rows} rows; result not requested`);
  else lines.push("Result: unavailable; result not requested");
  return lines.join("\n");
}

function assemble(
  layout: Layout,
  head: string,
  blocks: Block[],
  observed: ReadonlySet<string>,
  receipt: string
): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: head }];
  for (const b of blocks) messages.push({ role: "user", content: renderBlock(b, layout, observed.has(b.id)) });
  if (layout === "split" || layout === "hybrid") {
    const bodies = blocks
      .filter(b => observed.has(b.id) && (b.observation || b.error))
      .map(b => `### \`${b.id}\`\n${b.error ? `[ERROR] ${b.error}` : b.observation}`);
    if (bodies.length) messages.push({ role: "user", content: `# Observations\n\n${bodies.join("\n\n")}` });
  }
  messages.push({ role: "user", content: receipt });
  return messages;
}

const serialize = (m: ModelMessage): string =>
  typeof m.content === "string" ? `${m.role}:${m.content}` : `${m.role}:${JSON.stringify(m.content)}`;

function cachedPrefixTokens(current: ModelMessage[], history: string[][]): number {
  let best = 0;
  for (const prior of history) {
    let tokens = 0;
    for (let i = 0; i < current.length && i < prior.length; i++) {
      const text = serialize(current[i]);
      if (text !== prior[i]) break;
      tokens += estimateTokens(text);
    }
    best = Math.max(best, tokens);
  }
  return best;
}

export async function run(TRAJ: typeof TRAJECTORY, title: string) {
  const f = fixture();
  const system = estimateTokens(
    buildNativeModeSystemPrompt(ContextMode.LATEST, false, "all", {
      batch: true,
      nativeCatalogVersion: "v2",
      messageLayout: "opSplit",
    })
  );
  const deltaSystem = estimateTokens(
    buildNativeModeSystemPrompt(ContextMode.DELTA, false, "all", {
      batch: true,
      nativeCatalogVersion: "v2",
      messageLayout: "native",
    })
  );

  const layouts: Layout[] = ["today", "sticky", "split", "history", "hybrid"];
  const state = new Map<
    Layout,
    { history: string[][]; prompt: number; cached: number; last: number; miss: number[] }
  >(
    layouts.map(l => [l, { history: [], prompt: 0, cached: 0, last: 0, miss: [] as number[] }])
  );
  const delta = { history: [] as string[][], prompt: 0, cached: 0, last: 0 };

  const blocks: Block[] = [];
  const byId = new Map<string, Block>();
  let parityChecked = false;

  for (const [i, step] of TRAJ.entries()) {
    const output: any = await f.record(step.id, step.thought, step.operators, step.observe, step.rejected);
    f.persist(step.id, step.tables, String(100 + i));
    f.storage.captureNativeObservations(step.id, step.observe, EVIDENCE);

    const workflow = f.state.getWorkflowContent();
    // Creation order: the production LATEST renderer uses workflow.operators
    // order for native graphs, which is append-only.
    for (const op of workflow.operators) {
      const v = op.nativeOp!;
      let b = byId.get(op.operatorID);
      if (!b) {
        b = { id: op.operatorID, type: v.type, inputs: [], properties: "", revisions: [] };
        byId.set(b.id, b);
        blocks.push(b);
      }
      b.inputs = [...v.inputs];
      b.properties = JSON.stringify(v.properties);
    }
    // Diagnostics from this batch: a rejected edit leaves the DAG unchanged but
    // the operator carries its failure until a later edit lands.
    for (const entry of output.operators ?? []) {
      const b = byId.get(entry.id);
      if (!b) continue;
      if (entry.status === "error") b.error = String(entry.message).split("\n")[0];
      else b.error = undefined;
    }

    const snapshot = f.storage.getAssociatedSnapshot(step.id);
    const observed = new Set(step.observe);
    for (const b of blocks) {
      const info = f.storage.getOperatorResult(step.id, b.id);
      if (info?.totalRowCount !== undefined) b.rows = info.totalRowCount;
      const frozen = snapshot.nativeObservations?.[b.id];
      if (frozen) {
        b.observation = restrictNativeObservation(frozen, {});
        b.revisions.push(`Revision ${b.revisions.length + 1}: ${propsLine(b)}\nResult:\n  ${b.observation.split("\n").join("\n  ")}`);
      } else if (b.error) {
        b.revisions.push(`Revision ${b.revisions.length + 1}: ${propsLine(b)}\nResult: [ERROR] ${b.error}`);
      }
    }

    const head = `# User Task\n\n${f.steps[0].content}\n\n# Current Dataflow\n## Operators`;
    const receipt = `Last completed action in this task: dataflow completed; observe=${JSON.stringify(step.observe)}.`;

    // Parity gate: the reconstruction of today's layout must carry the same
    // operator bodies the production renderer emits, or nothing below is valid.
    if (!parityChecked) {
      const real = assembleContext(f.steps, f.state, f.storage, ContextMode.LATEST, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "opSplit",
        dataEvidence: true,
        flowEvidence: true,
        maxOperatorResultCharLimit: 2000,
      })
        .map(m => String(m.content))
        .join("\n");
      const mine = assemble("today", head, blocks, observed, receipt)
        .map(m => String(m.content))
        .join("\n");
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      for (const b of blocks) {
        // The trailing receipt is byte-identical across layouts and is compared
        // separately; it is not part of an operator block's parity.
        const grab = (t: string) =>
          norm((t.split(header(b))[1]?.split("\n### ")[0] ?? "").split("Last completed action")[0]);
        if (grab(real) !== grab(mine)) {
          const [x, y] = [grab(real), grab(mine)];
          let d = 0;
          while (d < x.length && d < y.length && x[d] === y[d]) d++;
          console.error(
            `PARITY FAIL on \`${b.id}\` at offset ${d}\n  real: ...${x.slice(Math.max(0, d - 60), d + 140)}\n  mine: ...${y.slice(Math.max(0, d - 60), d + 140)}`
          );
          process.exit(1);
        }
      }
      if (i === TRAJ.length - 1) parityChecked = true;
    }

    for (const layout of layouts) {
      const s = state.get(layout)!;
      const messages = assemble(layout, head, blocks, observed, receipt);
      const rendered = messages.map(serialize);
      const prompt = system + rendered.reduce((n, t) => n + estimateTokens(t), 0);
      const cached = (s.history.length ? system : 0) + cachedPrefixTokens(messages, s.history);
      s.history.push(rendered);
      s.prompt += prompt;
      s.cached += cached;
      s.last = prompt;
      s.miss.push(prompt - cached);
    }

    const dm = assembleContext(f.steps, f.state, f.storage, ContextMode.DELTA, {
      agentMode: AgentMode.NATIVE,
      messageLayout: "native",
      dataEvidence: true,
      flowEvidence: true,
      maxOperatorResultCharLimit: 2000,
    });
    const dr = dm.map(serialize);
    delta.prompt += deltaSystem + dr.reduce((n, t) => n + estimateTokens(t), 0);
    delta.cached += (delta.history.length ? deltaSystem : 0) + cachedPrefixTokens(dm, delta.history);
    delta.last = deltaSystem + dr.reduce((n, t) => n + estimateTokens(t), 0);
    delta.history.push(dr);
  }

  const cost = (prompt: number, cached: number) =>
    (prompt - cached) * RATE.uncached + cached * RATE.cached + OUTPUT_TOKENS_PER_STEP * TRAJ.length * RATE.output;

  const rows = [
    { label: "DELTA / native (baseline)", ...delta },
    ...layouts.map(l => ({ label: `LATEST / ${l}`, ...state.get(l)! })),
  ];
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`\n=== ${title} (${TRAJ.length} steps, 9 operators) ===`);
  console.log(
    `${pad("Layout", 28)} ${pad("prompt tok", 11)} ${pad("cached", 10)} ${pad("uncached", 10)} ${pad("hit%", 7)} ${pad("final step", 11)} ${pad("cost", 10)}`
  );
  console.log("-".repeat(96));
  for (const r of rows) {
    const hit = ((r.cached / r.prompt) * 100).toFixed(1) + "%";
    console.log(
      `${pad(r.label, 28)} ${String(r.prompt).padStart(11)} ${String(r.cached).padStart(10)} ${String(r.prompt - r.cached).padStart(10)} ${pad(hit, 7)} ${String(r.last).padStart(11)} ${("$" + cost(r.prompt, r.cached).toFixed(6)).padStart(10)}`
    );
  }
  const base = cost(delta.prompt, delta.cached);
  console.log("\nvs DELTA baseline:");
  for (const l of layouts) {
    const s = state.get(l)!;
    const c = cost(s.prompt, s.cached);
    console.log(`  ${pad(l, 10)} ${(((c - base) / base) * 100).toFixed(1).padStart(6)}%   (${c < base ? "cheaper" : "more expensive"})`);
  }
  console.log("\n  per-step cache-miss tokens:");
  for (const l of layouts) {
    console.log(`    ${pad(l, 10)} ${state.get(l)!.miss.map(m => String(m).padStart(6)).join("")}`);
  }
  console.log();
}

// The same trajectory, differing only in WHICH operator the late repair targets.
// Real traces: 83.4% of operator writes invalidate zero later messages, because
// the repair loop lands on the operator that was just added.
const deepIndex = TRAJECTORY.findIndex(t => t.id === "S8");
const tailRepair = TRAJECTORY.map((t, i) =>
  i !== deepIndex
    ? t
    : {
        ...t,
        thought: "Tighten the parcel-count threshold on the operator I just added.",
        operators: [
          {
            op: "filter",
            id: "material",
            input: "named",
            columns: ["parcels"],
            func: "def apply(row):\n    return row['parcels'] >= 75",
          },
        ],
        observe: ["material"],
        tables: { material: { rows: 24, columns: ["zip", "mean_per_sqft", "parcels", "neighborhood"] } },
      }
);

if (import.meta.main) await run(TRAJECTORY, "A. late repair reaches an EARLY operator (p95 case)");
if (import.meta.main) await run(tailRepair, "B. late repair lands on the NEWEST operator (the 83% case)");
