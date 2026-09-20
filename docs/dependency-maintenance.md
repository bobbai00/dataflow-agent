<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements. See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership. The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied. See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Dependency-driven maintenance of an analytical session

Implementation spec for the runtime changes that follow
[RESEARCH_REVIEW.md §7–§10](../agent-service/benchmark/multiturn/RESEARCH_REVIEW.md).
The claim under test is narrow: after a user changes a source or assumption,
the runtime — not the model — determines what is invalid, what must execute
for the demanded results, and what stays fixed; and the same graph bounds
what the model is shown. Everything here is behind settings that default to
off, so the existing `tasks` and `reuse` arms stay byte-identical controls.

## 1. What the traces showed

Measured on the task-history campaigns and the first real-session pass
(NFL task 1, university task 2, 2026-09-18):

1. **The answer payload is capped by the display budget.** A `return` is
   refused with `a complete successful table is required` whenever the
   answer cell exceeds `maxOperatorResultCellCharLimit` (2,000 chars): the
   engine truncates the cell, so the runtime never holds the complete answer.
   Real-session answers are nested objects of 1–2 KB; on NFL this refused
   3 of the first 13 tasks and forced the model to re-type the answer in
   prose from a truncated observation.
2. **The catalog is rewritten every request** because it follows a history
   that gains a task per request; 50% of cache writes, and no cache boundary
   can recover it. Only a smaller catalog helps.
3. **Post-step execution is eager**: every edit materializes every live
   descendant (`texera-agent.ts` `executePostStepChanges`, native branch), so
   a one-parameter change re-executes scenario branches nobody asked about.
4. **A turn that changed nothing looks like a turn that only read.** A failed
   update left the old default in place and two later tasks reported it.
5. **Wrong foundations propagate faithfully** (a filter emptied 721 rows to
   0 and five dependents inherited null). The row counts were in the
   observation; nothing acted on them.

## 2. Changes

### 2.1 Complete return (always on with `nativeDirectReturn`)

When the display result for the returned operator is successful but
incomplete (`truncated`, or fewer displayed rows than `totalRowCount`), the
runtime retains the complete table through the existing retention endpoint
(`/api/execution/{wf}/retain/{exec}/{op}`, the same copy `atTask` inputs
load), reads the Arrow file with `python/retained_rows.py` (digest-checked,
exact int64, `null` for missing), and resolves the return from those rows.
The existing checks stay: complete row count, preview-origin refusal,
declared column for `value`/`json`. A payload over `nativeReturnMaxBytes`
(default 262,144) is refused with that reason rather than partially emitted.
The retained artifact is cached by result version, so sealing the task later
reuses it; nothing is copied twice.

This is a dataflow operation, not a display concession: the demanded output
is a materialized table, and returning it means delivering the whole table.

### 2.2 Task receipts (`nativeTaskReceipts`)

When a task is sealed, the runtime records facts about what the task did to
the graph and renders them once, immutably, after the task's answer:

```text
# Task 6 receipt
Edited: default_tariff
Executed: default_tariff, portfolio_result
Not re-executed (inputs changed): stress_result
Historical inputs: portfolio_result@task1
Returned: portfolio_result (json)
Rejected at end of task: none
```

Every line is derived from batch outcomes and the post-step execution set —
never from model text — so the receipt says which state the task actually
changed, which results were recomputed, and which were left invalid. A task
whose request implied a change but whose receipt shows `Edited: none` is
visible as such to every later turn. Receipts are stable prefix material and
carry the same cache boundary as completed-task messages.

### 2.3 Compact index and boundary evidence (`nativeCompactIndex`)

The per-operator card (a 280-character clipped JSON definition, schema,
status, ancestry) becomes one line per operator:

```text
eligible = filter(risk) <- patients_typed; schema=id:int64,risk:int64,value:int64; rows=3
totals   = aggregate group([]) sum(value) <- eligible; schema=total:int64; rows=1
report   = udf(opaque) <- totals, {operator: totals, atTask: 1}; schema=answer:str; rows=1
```

Signatures are the declared operation over declared inputs (the vocabulary
`task-reuse.ts` already uses), never Python bodies. Full definitions appear
only for the selected dependency boundary — the operators this task edits,
observes or returns and their ancestors up to retained sources — as before,
and each selected operator now carries its data/flow evidence facts (row
counts in and out, kept/rejected rows, join cardinality, null shares on key
columns) from `evidence.ts`. Retained `TaskResult` sources report their own
row count and schema so evidence does not dead-end at a historical input.

### 2.4 Demand-driven execution (`nativeDemandExecution`)

In the native post-step path the execution set becomes

```text
edited operators          (to surface runtime errors and record receipts)
∪ demanded operators      (observe targets and the return operator)
∖ operators with a valid result
```

Descendants of an edit that nobody demanded are invalidated — the snapshot
store already deletes their results when an input's materialization changes
— but not executed. They read `not executed (input changed)` in the index
until a later task observes or returns them, at which point the demand rule
executes them (and their invalid ancestors). The engine already prunes each
execution to the targets' upstream closure (`buildLogicalPlan`), so this is
real work avoided, not just fewer results viewed.

Correctness condition, tested directly: every demanded result equals a clean
recomputation under the same definitions and inputs; no invalid result is
ever served as current; `atTask` still means an actually retained complete
output, so a report that was never demanded during a task has no output at
that task and the index says so.

### 2.5 Empty-ancestor guard (with `nativeDirectReturn`)

Direct return follows the answer's ancestry within the current task; if any
ancestor produced zero rows from a non-empty input, the return is refused
with `EMPTY_ANCESTOR: <operator> produced 0 rows from N` and the model must
look at it. Emptiness is not proof of a bug; it is the one signal in trace 5
above that the runtime holds and a script agent has no hook for. The guard
is mechanical and names the operator; it does not infer intent.

## 3. Arms

| Arm | Settings |
| --- | --- |
| `code` | ordinary persistent CodeAgent |
| `coderetain` | CodeAgent with automatic per-task state retention and `retained(task, name)` |
| `tasks` | task context + history + direct return + compact prompt |
| `reuse` | `tasks` + ancestry facts and reuse guidance |
| `maint` | `reuse` + complete return + receipts + compact index + empty-ancestor guard |
| `demand` | `maint` + demand-driven execution |

`maint` isolates the context policy and the answer boundary; `demand`
isolates execution. Both compare against `reuse` (same graph, eager, full
cards) and against the two code arms.

## 4. Measurements

Per arm and per LongDS state label (Initial / Update / Rollback /
Counterfactual, overlapping): strict pass, fresh versus inherited failures,
model calls, input / cached / cache-write / output tokens and recorded cost,
`return` refusals, wall-clock. For the native arms additionally the engine
work: operators executed per task, executions per task, and retained bytes.
Receipts are audited against the batch outcomes they summarize. The
controlled families give the mechanism curve (affected reports 1/4/16,
unrelated branches 0/8/32); the real sessions give external validity, with
the caveat that their scores are set by foundation-turn conventions that no
representation fixes.

## 5. Results on the two real sessions (2026-09-20)

One trial per arm, same fixtures, same model (`gpt-5.6-luna`), the fixes
of `1f07ee766` live (validator crash, compact-card entry line). Strict
evaluator, no judge. `logs/campaigns/dev-run2`.

| arm | NFL 42 | university 21 | calls | cost | cache writes (tokens) | output tokens |
|---|---|---|---|---|---|---|
| `code` | 1 | 13 | 96 | $0.336 | 215k | 138k |
| `coderetain` | **11** | **15** | 74 | $0.374 | 488k | 84k |
| `tasks` | 0 | 5 | 211 | $0.676 | 1,565k | 197k |
| `reuse` | 1 | 12 | 144 | $0.555 | 1,366k | 140k |
| `maint` | 1 | 10 | 129 | $0.412 | 714k | 152k |
| `demand` | 1 | 6 | 151 | $0.439 | 784k | 141k |

By LongDS label on NFL, `coderetain` passes 10 of 33 state-change tasks
(2 Update, 5 Rollback, 4 Counterfactual); every other arm passes at most 1.
On university, `code` 7/12 and `coderetain` 9/12 state-change tasks, `reuse`
6/12, `maint` 5/12. Failures are inherited in about nine of ten cases in
every arm (a failed dependency upstream), so a session's score is set by its
first few conventions.

What the mechanisms did:

- **Complete return** removed refusals over successful operators: 0 in all
  native arms (every remaining refusal followed a UDF failure, 15 in `maint`
  on NFL, 42 in `tasks` on university).
- **Compact index + receipts** halved cache writes against `reuse`
  (714k vs 1,366k tokens) and cut calls (129 vs 144) at equal accuracy on
  NFL and −2 tasks on university (one trial; the tasks lost, 9/12/15/17,
  are content failures of the same `times_2016_cleaned` lineage).
- **Empty-ancestor guard** fired 5 times on university task 5 (the known
  `721→0` filter trap). The model spent four more calls and still returned
  the empty result as intended; the guard surfaces, it cannot decide.
- **Demand-driven execution** deferred 4–16 undemanded recomputations per
  session with no refusal caused by a stale result; its university score
  (6) is one trial with ten `LinAlgError` repairs of the model's own
  Mahalanobis code, not a mechanism effect that the traces support.

What the comparison actually isolates: `code` (1) and the native arms (0–1)
score the same on NFL; `coderetain` (11) differs from `code` only by
retaining its Python variables between tasks. The lever on a cumulative
session is persistent intermediate state, and the traces show the native
arms never created any: from task 2 to task 16 each task added one UDF over
the task-1 tables and re-derived the pipeline (see `docs/kept-frames.md`).
Against the review's exit conditions: Milestone B's cost reduction is
measured (cache writes −48%, calls −10%, cost −26% against `reuse`) without
extra repair calls erasing it, but neither arm approaches the code baseline
on the cumulative session, so no promotion; Milestone C's execution curve
still needs the controlled families (queued).

## 6. Limits

Retained tables live in an engine-owned directory the agent service can
read in the local stack; a distributed deployment needs object storage for
both `atTask` and complete return. Receipts state what the runtime did, not
what the user meant. The compact index can cost lookups: compare total
calls and cost, never prompt size alone. Demand-driven execution defers the
runtime errors of undemanded edits to the task that demands them; edited
operators are still executed for that reason.
