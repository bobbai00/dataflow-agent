<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Evidence compaction: implementation and evaluation contract

This change branches from the tested evidence-only, Python V2 batching +
explicit `observe` implementation. It changes representation, not the worker
profile, evidence formulas, operator catalog, sample selection, or error tools.
The calculation reference remains [data-flow-evidence.md](data-flow-evidence.md).

## What changes

The existing shared-budget selector first chooses the same table rows and facts
it would have chosen before this change. A deterministic pass then shortens
that selection. Saved space stays empty: it does not buy additional facts or
sample rows. This makes the initial experiment a conservative formatting and
redundancy experiment, not a simultaneous change in information selection.

### Data counts

Several selected count sentences with the same output version and coverage
become one table, only when that table is shorter. For example:

```text
Data measurement: column counts (full=3 rows)
column | null | nonnull | distinct(nonnull)
"year" | 0 | 3 | 2
"amount" | 1 | 2 | unknown
```

This retains the column names, null counts, non-null counts, and distinct
non-null counts. `unknown` does not become zero. Partial-prefix counts get a
separate coverage heading; full and partial measurements are never pooled.
String escaping is unchanged. Single-column sentences remain expanded if a
table would be longer. Ranges, values, warnings, records, and schemas remain.

### Data + flow overlap

If a selected Filter flow fact already displays the same output null and
distinct counts, its matching standalone Data count can be omitted. Non-null
count is derivable from the displayed processed-row and null counts. Matching
requires the exact column, output result version, coverage, processed rows,
null/non-null counts, and distinct count. A fact that was merely eligible but
lost the budget competition cannot suppress another fact.

The audit record marks this omission `redundant_displayed_fact`. Data-only
retains its counts. Flow-only does not gain Data facts. Stale input proof does
not justify suppression. No two unrelated measurements are merged because
their numbers happen to match.

### Repeated upstream context

When two explicitly observed outputs have the same upstream fact, the first
keeps its complete summary. A later output in that same rendered group can say:

```text
Flow upstream: see "first" above for "selected".
```

This reference is allowed only when upstream operator ID, result version, and
complete fact text match, and the earlier summary survived the display budget.
It is used only if shorter. Hidden results, clipped chunks, different upstream
versions, and different facts cannot serve as targets.

Stored per-operator observations remain self-contained. Only their model-facing
rendering shares upstream lines. Thus a trace auditor should validate the
reference against the earlier summary, not require every stored observation
body to appear verbatim in a frame with sharing enabled.

## Context and cache boundaries

| Configuration | New display behavior |
| --- | --- |
| Neither | No additional evidence; common table view unchanged |
| Data-only | Selected count sentences can become a compact table |
| Flow-only | Repeated upstream summaries can become same-frame references |
| Data + flow | Both, plus exact displayed Filter/Data count deduplication |

DELTA gets a fresh sharing memo for each event. An observation in a later event
prints its own upstream summary; it never points into a previous event. LATEST
gets a fresh memo for each current snapshot. Observing only the second output
later restores a complete summary. Stored old DELTA observations are not
reselected or rewritten. These boundaries preserve replayable history and
avoid dangling references after context restriction.

No runtime switch or legacy statistics setting is added. `dataEvidence` and
`flowEvidence` remain the only evidence exposure controls. `inspectResult`
remains unavailable. Existing error receipts, `inspectError`, stale-result
checks, explicit observation rules, scheduler dependencies, and complete-small-
table suppression remain in force.

## Test-first qualification

Regression tests were added before implementation and failed on the old
renderer. Coverage includes exact count preservation, full versus partial
coverage, unknown distinct counts, no budget refill, no expansion, stale or
undisplayed overlap, clipped reference targets, matching versions, legacy
stored observations, DELTA prefix stability, LATEST refresh, and cached observe.

The live `benchmark/e2e/native-program-run.ts` smoke (2026-09-22; the earlier
`native-compaction-run.ts` drove the retired JSON batch tool) uses the real service and
engine with forward-referenced dependent operators, two observed outputs, and
a second cached observe. It checks all four evidence configurations in both
DELTA and LATEST, inspects actual assembled service context, and verifies frozen
snapshots remain unchanged. Existing evidence and diagnostic suites are also
qualification gates. This suite is deterministic and does not call an LLM;
separate Terra-medium smoke traces are required before the full campaign.

## Full-campaign protocol

Three fresh SUT namespaces: Data-only, Flow-only, and Combined. All use
`gpt-5.6-terra` with medium reasoning, Python V2, batch + explicit observe,
DELTA, profiling enabled, a 2,000-character observation budget, and the previous
pilot's 25-step limit. Only the exposure flags differ. Isolated agent services
use ports 3017, 3018, and 3019 with the shared Texera backend; model smoke
artifacts have separate names from the full run.

Pin service source, harness revision, native workload and inputs, backend
process, gateway route, and qualification outputs before dispatch. Use the
native KramaBench execution and evaluator. Report the answer-type primary
score, mean primary score, exact passes (score >= 1), and input-readiness or
execution failures explicitly. Never silently drop an unavailable task.

The user requires **one original attempt per task, with no automatic reruns**.
Use only the first-pass score and cost, never the latest or best of several
attempts. Failed and partially correct tasks stay in the result. Extra retries
were initially started before this clarification; their preserved artifacts,
scores and costs are excluded from the primary comparison, and further retry
launches are stopped. Do not resume the historical recovery supervisor.

Use captured `stats.json` cache-aware cost; distinguish the recorded-rate token
estimate from a provider invoice, and never turn missing usage into zero cost.
Audit actual input messages, cache tokens, samples, and references before
interpreting any cost or accuracy difference as a benefit of compaction.

The [single-pass analysis report](../benchmark/Kramabench/judgment_runs/evidence_compaction_20260916/REPORT.md)
contains all three new 104-task results, the explicitly labeled historical
Native baseline, per-task metric/cost exports, reproducible native aggregation,
and the complete first-pass context audit. The Native baseline uses V1; this is
not a same-version V2 no-evidence ablation. Mean cost per task uses the 103
actually dispatched tasks; scores retain all 104, including the input blocker.
