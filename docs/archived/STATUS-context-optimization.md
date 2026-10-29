# Context optimization — where we are, where we're heading

A single map for the context-tuning effort. Written after grounding every claim
against the **current** renderer (not the recorded traces, which — see §5 — were
captured under older code).

---

## 0. The goal (one line)

Assemble the *cheapest context that preserves accuracy* for each ReAct step, by
choosing per-operator render parameters from the current state of the dataflow +
the task. I.e. learn the map **(params × dataflow-state × task) → (token cost, accuracy)**
and act on it. This is exactly the framing you stated.

---

## 1. Your intuition is correct — here is the mapping

You said we have knobs *because it's a dataflow*: result sampling size, column
statistics, and structural signals (operator location in the DAG, edit times).
That is precisely the design. Concretely:

| Your knob | In the code | Default today | What it moves |
|---|---|---|---|
| result sampling size | `result.latest.tuple.sampleRows` (`maxResultRows`) | `0` = uncapped rows | **cost** |
| detail: rows vs shape | `result.latest.detail` = `sample`\|`shape` | `sample` | **cost** (the big lever) |
| column statistics | `result.latest.column.stats` (+ `schema`, hints) | **OFF** | **accuracy** (and adds cost) |
| operator location / edit-times | selector features: `role`, `stepsSinceEdit`, `frontierOpId` | computed | **routing** — *where* to apply the above |
| display column cap | `MAX_DISPLAYED_COLUMNS` (table) / `MAX_SCHEMA_COLUMNS` (schema line) | 50 / 50 | **cost** |

The selector features are the "we know the location / editing times" part — they
don't render anything themselves, they decide *which* render params each operator
gets this step.

---

## 2. The current baseline (`LATEST`) is already lean — this matters

At default settings `flowLevel=0, dataLevel=0, maxResultRows=0`:

- **No** schema line, **no** column stats, **no** value/format hints. (`levelsToFlags(0,0) = {}`.)
- Renders: DAG operator summaries + each op's **full sample table** (rows
  uncapped, **columns capped at 50**).
- The dominant cost is therefore **re-rendering every operator's sample table on
  every step** — not stats, not schema lines (they're off).

Consequences:
- The **cost lever** is *trimming* consumed/idle operators' sample tables
  (`sample → shape`, or fewer rows).
- The **accuracy lever** is *adding* `stats` on decision-critical columns — it is
  OFF by default and not even reachable via `dataLevel` (it's a standalone flag).
  So accuracy tuning means turning something **on**, cost tuning means turning
  something **off**. They pull in opposite directions — the policy is directional,
  not "always less."

---

## 3. What is already built (inventory + status)

| Component | Path | Status |
|---|---|---|
| Centralized `summarize(data, params)` | `context/summarize/` | ✅ built, unit-tested, **golden byte-parity** with legacy LATEST/DELTA |
| Orthogonal param space + presets | `summarize/params.ts` | ✅ LATEST/DELTA are presets of it |
| Rule-based selector (features → params) | `context/selector/` | ✅ built, tested; roles + `stepsSinceEdit` action vector |
| LLM "teacher" tuner (gpt-5.4 advises params) | `context/tuner/` | ✅ built, tested; e2e verdict = **accuracy-neutral, cost-mixed** |
| Read-only `inspectResult` pull tool | `tools/inspect-result-tool.ts` | ✅ built, opt-in |
| Oracle trace analysis (60 traces) | `output/trace-analysis/` | ⚠️ built, but partly on **stale** renders (§5) |
| Phase 1: schema-line 50-col cap | `decorate/data/schema.ts` | ✅ **landed this session** (see §6) |

---

## 4. The honest empirical read (unchanged headline)

From the 60-trace oracle pass + ~50 live cells: on KramaBench, **context tuning is
overwhelmingly a COST lever, not an accuracy lever** (accuracy ceiling ≈ 1/60).
- The **one** fail→pass accuracy lever: `stats` on a join-key column
  (wildfire-hard-17). Plus latent hardening (environment-hard-15 mixed-case
  categorical, correct only by luck).
- Everything else that failed is **task-intrinsic** (bad transform, absent data) —
  no render fixes it.
- Most of the *cost* is actually an **action** problem (agent rarely deletes: 6%
  delete rate; duplicates loaders) that render-trimming only masks.

This headline is still trustworthy. What is NOT trustworthy is some of the
specific cost *mechanisms* — see next.

---

## 5. Correction discovered this session (important)

The recorded traces in `llm-training-set-v1-kramabench/` were **captured under an
older rendering code path** than what ships today. Evidence:

- **Small tables**: legal-easy-25's 26-row / 1,316-char table rendered in the trace
  as ~3 rows with the middle (incl. the answer "U.S. Space Force") ellipsis-hidden.
  Under **current** defaults (`maxResultRows=0`, no context char-cap) the same table
  renders **in full** — verified by running it through today's `formatOperatorResult`.
  → `smallTableFullThreshold` is **redundant**; dropped from the plan.
- **Wide tables**: the biomedical trace rendered a **179-column-wide** table (raw,
  no cap) with a largest single context of 33.7K chars. Current code caps display
  columns at 50. → the "179-col re-render" cost is **already mitigated**; the
  case-study's "3,127-char schema line ×18" mechanism is wrong for that run (there
  was **no** schema line in it at all).

**Takeaway:** case studies built on the recorded traces describe some pathologies
that current defaults already fix. Any cost claim must be re-measured against the
current renderer. (The Phase-1 number in §6 *was* measured on current code.)

---

## 6. Phase 1 result (real, current-code)

Schema-line column cap (`formatSchemaLine`, `MAX_SCHEMA_COLUMNS=50`): a 179-col
schema line drops **4,192 → 1,188 chars (−72%)**, narrow tables byte-identical (10
golden snapshots still pass), suite 505 pass / 3 pre-existing env-coupled fails.

**Caveat on when it fires:** the schema line only renders at `dataLevel≥1` or in
`detail:"shape"` mode. Under the raw default (`dataLevel=0`) there is no schema
line, so Phase 1 is a **companion to the shape-trim lever** (§7 lever A), not a
standalone win. It makes "shape a wide consumed table" cheap instead of still-heavy.

---

## 7. The lever map (what actually moves cost/accuracy, current code)

| lever | mechanism | type | status |
|---|---|---|---|
| **A. shape consumed/idle ops** | `detail: sample→shape` on ops a healthy downstream consumed | cost (big) | selector has the role; wire it |
| **B. omit dead ops** | `omit` unconsumed non-terminal ops | cost | selector role exists |
| **C. stats on decision-critical cols** | turn on `stats` for join-keys / filter-categoricals | **accuracy** (the one lever) | needs a targeting rule |
| **D. freeze unchanged upstream** | during no-progress runs, shape ops with high `stepsSinceEdit` | cost | not wired |
| **E. schema-line width cap** | Phase 1 | cost (companion to A) | ✅ done |
| **F. don't over-trim value-quirk loads** | keep `sample` at load/discovery step | anti-cost (correctness of trim) | principle only |
| **(ACT) delete/dedupe** | GC dead ops, collapse duplicate loaders | cost root-cause | prompt/behavior track |

---

## 8. The central open question + the *methodology* to answer it

The map **(params × dataflow-state × task) → (cost, accuracy)** splits cleanly, and
the two halves need **different** methods:

- **COST is deterministic and offline-measurable.** Given a recorded *action
  sequence*, the rendered-context token cost under any param setting is a pure
  function — no LLM calls. So we can build the cost side of the map exactly, on
  current code, by **replaying recorded action sequences through `summarize()` with
  different params** and summing tokens. Cheap, rigorous, no variance. This is the
  right tool and we don't have it yet.
- **ACCURACY requires live runs and is noisy** (trajectory variance dominates a
  single sample). Evidence says the ceiling is ~1/60, concentrated in lever C. So
  accuracy should be tested with **targeted live A/B on the handful of tasks where
  a stats-on-decision-column could flip the answer**, not a broad sweep.

This is why the earlier end-to-end tuner comparisons were inconclusive: they mixed
a deterministic cost signal with a noisy accuracy signal in one expensive live run.

---

## 9. Proposed path forward

1. **Build the offline cost-replay harness** (deterministic). Replay each recorded
   action sequence through the *current* `summarize()` under N param policies →
   exact token cost per (task × policy). This re-grounds every cost claim on
   current code and gives the cost half of the map for free. *(This also
   auto-corrects the stale-trace problem: we re-render, we don't trust the old
   render.)*
2. **Wire lever A + D in the selector** (shape consumed/idle ops; freeze unchanged
   upstream) and measure the cost win with the harness from step 1. Expect the real
   wins to concentrate in multi-source / long-verify-loop tasks.
3. **Targeted accuracy A/B for lever C** (stats on join-key / filter-categorical
   columns) on the ~2–4 tasks where it could matter (wildfire-hard-17,
   environment-hard-15, + any join/filter-heavy task). Live, small-N, but decisive.
4. **Actions track (separate):** the delete/dedupe discipline is the real cost
   root cause; treat as a prompt/behavior change, not a render param.

Recommended first move: **step 1** (offline cost harness) — it's cheap, removes the
stale-trace uncertainty, and turns "where does cost come from, really" from
anecdote into a measured table.
