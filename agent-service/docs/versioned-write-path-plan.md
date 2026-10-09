# Versioned write path — make operator versions real

Working plan + status. Written to survive context compaction: anyone (including
a future session) should be able to resume from this file alone.

**Goal (user's words):** implement the plan, extensively unit test each
component, then use one real task (NFL) to test it end to end without any
compromise.

---

## 1. The bug this exists to fix

Measured on the 42-turn NFL session (`LongDS_LongDSLunaVersioned2kD2V31`,
system_scratch), turn 28, step 2:

```
operatorId: current_player_scored
upstreams:  ["current_player_scored (turn 28)", "play_adjusted_protection (turn 20)"]
from:       "current_player_scored (turn 28)"
```

The model revised an operator and named **its own previous version** as an
input — semantically reasonable ("feed what I just built into the new one").

What happened instead:

1. The version store validated the ref (turn 28 does hold a version) and then
   **discarded the turn number**. Wiring is by bare name
   (`createInputLinks` receives operator objects, never refs), so the link
   became `current_player_scored → current_player_scored`.
2. That self-loop makes the workflow cyclic. The execution service rejects the
   whole plan: `400 Bad Request — {"code":400,"message":"Unable to process JSON"}`.
3. `runPostStepExecution` never inspects the result — the failure is logged at
   warn level and dropped.
4. With no results persisted, the renderer prints `result: (not executed)`.
5. The model reads that as "my operator produced nothing", rewrites it under a
   new name, and loops: turn 39 = 60 operator writes, 0 results, names cycling
   `_report/_readout/_values/_extract`, until the 40-step budget ends the turn.

Correlation is exact: self-loop first appears at t28, cycles in 15 turns,
`(not executed)` starts at t28, 5 burnout turns (~$0.90 each), NFL cost $7.93
vs $5.05 for session. **No other run in the campaign has a cycle.**

### Verified facts (don't re-derive these)

- Payload size is NOT the cause. Probes: 515 KB of dummy operators → 200;
  session NFL 245 KB → 200; v3 netflix 224 KB → 200. Only the cyclic NFL
  payload 400s, and it 400s at any size.
- The 400 is reproducible: POST t42's workflow → 400; remove the self-loop
  link → 200. Bisected to link index 134, the self-loop.
- Other tasks' `(not executed)` counts (v3 netflix 95, v3.1 energy 16) are a
  SEPARATE, still-unexplained issue — their payloads return 200. Investigate
  after the main fix; do not conflate.
- `getSubDAGForTargets` pruning fix (commit `1effa93aa`) is real and useful
  (215 ops → 29 for two sibling targets) but is NOT what fixes NFL.

### The root cause, stated precisely

**Reads are versioned; writes are not.** `recallState("X (turn 3)")` genuinely
serves turn 3's snapshot. `upstreams: ["X (turn 3)"]` validates that turn 3
exists and then wires to the single live node `X` — whatever its code is *now*.
The graph has one node per `operatorID`; "versions" are derived by replaying
snapshots (`versionsOf()` in texera-agent.ts). The uniform `opId (turn N)`
notation hides the asymmetry from the model, which reasonably assumed it could
wire to an old version.

---

## 2. Design

### 2.1 Core storage model (the fix's foundation)

New module `src/agent/operator-version-store.ts`. Explicit, written record —
not derived from snapshot replay.

```
key:   (operatorId, turnId)                     ← composite key, immutable
value: {
  code, operatorType, inputPorts, outputPorts,  ← full definition
  inputRefs: [(operatorId, turnId), ...],       ← inputs AS COMPOSITE KEYS
  resultStepId,                                 ← pointer into snapshot storage
}
```

- **Write-through in EVERY mode** on each successful `createOrModifyOperator`,
  under `(opId, currentTurn)`. The backbone is always turn-tracked; that is
  what lets non-versioned modes stay simple yet auditable.
- Entries for the **open turn are provisional** (a re-write in the same turn
  replaces them). At **turn close they freeze — immutable forever**. The store
  asserts this; mutating a closed entry is a loud bug.
- `inputRefs` is the decisive field: each version records the resolved
  composite keys of what it consumed **at write time** (versioned mode: the
  refs the model passed; legacy: `(paramName, latestTurnOf(param))` captured
  automatically). The version DAG becomes *stored*, so recursive checkout is a
  lookup, never snapshot archaeology.

API: `recordWrite`, `get(opId, turn)`, `latestTurnOf(opId)`, `closeTurn(n)`,
`versionsOf(opId)`.

### 2.2 Two distinct tool sets

**Versioned write tool** (`versionedMode: true`) — separate factory:

- `upstreams` required per `process()` parameter as `"opId (turn N)"`;
  `from` required on revisions.
- Resolution through the store:
  | ref | resolves to |
  |---|---|
  | `(X, N)` = X's newest version, X ≠ operator being written | **live node** (common path, zero overhead) |
  | `(X, N)` older | **pin `X__tN`**: immutable node with stored code, inputs wired by recursively resolving stored `inputRefs` (each live-if-unchanged else own pin) |
  | `(X, N)` where X **is** the operator being written (NFL case) | **pre-revision pin** from the provisional entry: `X__t28 → X` |
- Pins memoized on the composite key (one node per version ever). Recursion
  terminates: `inputRefs` are strictly older turns or loaders.
- Pins are immutable: revising an operator carrying `pinnedFrom` is rejected
  with a teaching error.
- **Self-loops become inexpressible by construction** — no prohibition needed.

**Non-versioned tool** (legacy / flat / session) — existing factory, semantics
untouched: no turn ids anywhere, `def process(a, b)` wires to latest live nodes
by name. Byte-parity pinned by existing golden tests. Store still records
versions underneath; nothing reads it on this write path.

Read tools already split this way: op-level `recallState(ref)` in versioned
mode (commit `3935916d9`), turn-level in legacy recall arms.

### 2.3 Safety + visibility (mode-independent)

- `WorkflowState.addLink` rejects `source === target`; `wouldCreateCycle()`
  helper; plan builder validates acyclicity **before shipping**, returning a
  teaching error naming the cycle. Also fixes legacy modes, where
  `def process(X)` while editing `X` self-loops today.
- `runPostStepExecution` inspects the execution result; on failure writes an
  error `OperatorInfo` for each edited operator so the render shows
  `Result: [ERROR] execution failed: <reason>`. `(not executed)` reserved for
  operators genuinely never targeted. One bad plan → one informative
  observation, not 15 blind turns.

### 2.4 Semantics table

| model writes | today | after |
|---|---|---|
| `["X (turn latest)"]` | live X | live X (unchanged) |
| `["X (turn 3)"]`, X since revised | **silently current X** | pinned turn-3 X + historical closure |
| `["X (turn N)"]` while revising X | **self-loop, engine dies silently** | pin → new version; works |
| wiring that would cycle | 400, `(not executed)` loop | teaching error at write, nothing mutated |

### 2.5 Costs (accepted, stated)

Pins are visible operators (`X__tN`, labeled `pinned: X (turn N)` in catalog
delta + observations); graph grows when old versions are actually used, bounded
by dedup. First use re-executes that closure — the compute cost of genuine
time travel. Determinism holds: same code, same static files, same pinned
inputs. Positional port feeding means old code runs unmodified (parameter names
are agent-side convention only).

---

## 3. Implementation order + status

Land 1 first (small, independently valuable), then 2, then 3 on top.

- [x] **L1 — guards + failure surfacing** — DONE, commit `9b0adadf8` (16 tests)
  - `workflow-state.ts`: self-loop guard in `addLink`; `wouldCreateCycle`
  - `workflow-execution-tools.ts`: pre-ship cycle validation, teaching error
  - `texera-agent.ts` `runPostStepExecution` (~line 2171): inspect result,
    write error OperatorInfo per edited op
  - tests: self-loop rejected; cycle detected + message names the cycle;
    failure produces `[ERROR]` in render, not `(not executed)`
- [x] **L2 — OperatorVersionStore** — DONE, commit `49d3ec7e0` (12 tests, verified live: 12 versions, freeze + cross-turn lineage)
  - new `src/agent/operator-version-store.ts`
  - `texera-agent.ts`: own it, write-through hook, turn-close hook,
    `versionsOf` reads the store
  - tests: composite-key get/put, provisional-then-frozen, freeze violation
    throws, `inputRefs` recorded in BOTH modes, `latestTurnOf`
- [ ] **L3 — split write tools + pin materialization** (task #39)
  - `code-op-tools.ts`: `createVersionedWriteTool` vs legacy factory;
    resolver + memoized recursive materializer; pin immutability
  - renderers: label pins
  - tests: full resolution table, recursive checkout (pin's pin), memoization,
    pin-revision rejected, legacy byte-parity
- [ ] **E2E — NFL as v3.1 rep1** (task #40)
  - smoke github first, then full NFL (~60 min, ~$8)
  - assert: zero cycles, zero 400s, no `(not executed)` cascade, t28-style
    self-reference materializes a pin and executes

## 4. Key file/line anchors

- self-loop origin: `code-op-tools.ts` `createInputLinks` (~line 578) — takes
  operator objects, refs already stripped
- ref validation: `code-op-tools.ts` ~line 800-890 (`versionStore` block)
- derived versions today: `texera-agent.ts` `operatorVersionStore()` ~line 909
- `(not executed)` render: `context-utils.ts` ~line 2082
- post-step execution: `texera-agent.ts` `runPostStepExecution` ~line 2171
- plan builder: `workflow-execution-tools.ts` `buildLogicalPlan` ~line 190
- snapshot tree: `workflow-snapshot-storage.ts`

## 5. Test/verification commands

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd ~/Desktop/bobflow/dataflow-agent/agent-service && bun test   # expect 768/771; see the 3 known failures below
# service restart needed for prompt .md changes (not watched):
pkill -f "bun run [d]ev"; cd agent-service && nohup env PATH="$HOME/.bun/bin:$PATH" bun run dev > ~/Desktop/bobflow/Kramabench/logs_agent3001.log 2>&1 &
# NFL e2e (from Kramabench):
set -a && . ./.env && set +a
.venv/bin/python -u longds/run_longds.py --task sports__nfl_big_data_bowl_2023__task1 --arm luna-versioned-2k-d2-v31 --turn-timeout 1800
```

Judged v3.1 NFL scores backed up at `/tmp/claude-1000/v31_nfl_results_eval.json`
(42 turns) — an NFL rerun overwrites that scratch dir.

---

# 6. Results (2026-08-10)

## 6.1 What the campaign actually established

**Accuracy is cascade-dominated, and context layout does not move it.**

Judged, 309 turns, 3 reps of v3.1 vs 6 runs of the session layout, accuracy by
turn position:

| turns | versioned v3.1 | session 2k/D2 |
|---|---|---|
| 1-5 | 59.3 | 57.0 |
| 6-10 | 50.7 | 51.0 |
| 11-20 | 24.9 | 24.2 |
| 21-30 | 20.1 | 18.2 |
| 31+ | 1.9 | 1.9 |

Identical curves, zero stopped/errored turns in either — so the late collapse is
wrong answers, not infrastructure. Conditioning on whether a turn's declared
upstream dependencies were themselves correct:

| turns | deps clean | upstream poisoned |
|---|---|---|
| 1-5 | 73.5 | 34.6 |
| 6-10 | 83.1 | 29.7 |
| 11-20 | 71.2 | 11.0 |
| 21+ | 83.3 | 9.1 |

**Given correct inputs, per-turn accuracy is flat with depth** (83% at turn 21+).
There is no long-context degradation. Of 342 late turns, 318 had at least one
wrong upstream and only 24 were clean; the median first-error turn is 2. So the
aggregate mostly measures how early the first mistake lands and how many turns
hang off it — which is why every context knob in this campaign (recall caps,
session vs catalog, operator-level recall) returned a null result, and why
between-rep task swings are enormous (world_university_rankings ranged 10-76
across three v3.1 reps).

Early failures are spec interpretation, not context: percent-vs-proportion units
(31.8 vs 0.3180), threshold boundaries off by one group (175 vs 170),
calendar-month vs year-month keying, omitted required output fields, tie-vs-tail.

**Corollary for future work: to move accuracy, target first-error rate on turns
1-3. Context-layout changes should be evaluated on cost, not score.**

## 6.2 Cost: the two bugs that were worth fixing

| build | NFL cost | note |
|---|---|---|
| pre-fix | $7.93 | self-loop made the workflow cyclic; 15 turns of blind rewriting |
| v3.1 (`ad5301b4a` parent) | $4.13 | composite-key store + pin checkout |
| v3.2 (`ad5301b4a`) | $1.99 | live turn diffs against inherited snapshot |

Full arm, v3.1 (mean of 3 reps) vs v3.2 (1 rep), 309 turns:

| | v3.1 | v3.2 | delta |
|---|---|---|---|
| input tokens | 85.1M | 54.9M | -35% |
| cost | $15.88 | $9.71 | -39% |
| steps | 1610 | 1760 | +9% |
| input tokens/step | 52,838 | 31,184 | -41% |
| recallState calls | 828 | 909 | +10% |
| cost per correct turn | $0.167 | $0.108 | -35% |

The mechanism is push -> pull: the catalog stopped pushing inherited state into
every step, and the model pulls what it needs instead. Every task got cheaper.

Accuracy for v3.2 rep1: 28.99 turn-weighted / 33.09 task-macro, against v3.1's
30.84 +/- 0.57 and 36.16 +/- 0.60. Four tasks up (netflix 7.8->20.6, nfl
9.5->26.2, nyc 19.8->28.1, uber 8.3->11.1), six down (energy 19.4->2.8, wur
34.9->14.3, water 38.9->27.8, passnyc 50->40, bi 81.5->70.4, github 91.1->86.7).
Per-turn-bucket accuracy is indistinguishable (1-3: 63.3 vs 64.4; 4-10: 48.6 vs
51.0; 11-20: 24.2 vs 24.9; 21+: 11.4 vs 14.3), so there is no sign the fix
starved the model of state — the aggregate difference is the cascade lottery.
Reps 2-3 are needed before any accuracy claim; do not report -1.85 as a
regression on n=1.

## 6.3 The pin bug (`bc8f0754c`)

Pins materialized for real for the first time on the energy task
(`panel_base (turn 1)` -> `panel_base__t1`, correctly wired). Every execution
then failed:

```
Workflow validation failed: Operator panel_base__t1:
  - additionalProperties: must NOT have additional properties
```

`__pinnedFrom` lived inside `operatorProperties`, which the engine validates with
`additionalProperties: false`. 59 failures in one turn; the model then deleted
the pin and hand-copied it as `panel_v2`, which stranded its downstream
(`input_0 requires at least 1 input`). That detour cost 248 steps against
175-182 for the same task on the prior build and ate the whole prompt-size
saving. Provenance now lives in a `pinLabels` registry exposed as
`pinnedLabelOf()`, with an id-pattern fallback validated against the store so
the edit-a-pin guard survives the lazily-built checkout being rebuilt.

**Still unverified: a pin executing end-to-end in a live run.** The energy rerun
on the fixed build materialized no pins at all, so the fix is confirmed only by
unit tests plus the absence of the validation error. A rollback-heavy task is
needed to exercise it.

## 6.4 Operational lesson

Editing agent-service source while a pool is running kills the run:
`bun run dev` hot-reloads, and a half-applied edit (a removed export still
imported elsewhere) takes :3001 down. Seven tasks burned with
`ConnectionRefusedError` this way. `run_all.sh` says it: nothing may restart a
service mid-pool. Make source edits only between pools.

## 6.5 Test inventory for the versioned write path + v3.2

| file | tests | guards |
|---|---|---|
| `util/catalog-inherited-baseline.test.ts` | 4 | the v3.2 fix: the live turn diffs against what it inherited; turn 1 unaffected; this turn's own results still shown |
| `operator-version-store.test.ts` | 12 | composite key `(operatorId, turnId)`, immutability of closed turns |
| `version-checkout.test.ts` | 13 | pin materialization, recursive checkout, reuse, pin properties carry no internal keys, rebuilt-checkout recognition |
| `tools/versioned-write-path.test.ts` | 9 | versioned vs non-versioned tool contracts, ref resolution, editing a pin is refused |
| `tools/self-reference.test.ts` | 5 | self-reference rejected without checkout, pinned when checkout is available |
| `tools/execution-subdag.test.ts` | 8 | only the minimal DAG for the requested targets is sent to the engine |
| `graph-guards.test.ts` | 8 | self-loop and cycle rejection in `addLink` |
| `execution-failure-surfacing.test.ts` | 3 | a failed execution renders as a failure, never as `(not executed)` |

### Known failures (3) — suite-order pollution, NOT a regression

`bun test src/` reports 768/771. The three failures are all in
`texera-agent.test.ts` ("delegate bootstrap"), and they are an artifact of
running the whole suite in one process:

- the file passes **26/26 in isolation** at HEAD and at HEAD~2;
- the full suite fails the same three at HEAD~2 (766/769), i.e. before the
  versioning work landed.

Symptom: `expect(opResult?.error).toBe("boom")` receives `undefined` — the
per-operator error is missing, so state from another file is leaking. Only
`texera-agent.test.ts` patches `globalThis.fetch`, so the leak is a
module-level singleton cached across files rather than a stray fetch mock.
Pre-existing test-infra debt; worth fixing separately, and worth not writing off
as "expected" — it hides real regressions in that file whenever the suite runs
as a whole.
