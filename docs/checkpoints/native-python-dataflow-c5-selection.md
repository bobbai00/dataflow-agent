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

# C5: budgeted evidence, observations and compatibility

Date: 2026-09-15. Branch: `feat/native-python-dataflow`.
Implementation commit: `7fe9e30cd`. Batching ancestor remains `41cd8ae97`.

The model-facing selector is implemented and integrated, not just a profile
collector. Local correctness tests pass. **Real-engine C5 qualification is
pending**: no shared services were started/restarted in this checkpoint, and
the previous shared-compute coordination pause remains in force. This is not
completion of C4's expanded live repair rerun, C6 or C7. There are no real-LLM
or KramaBench accuracy/cost results from this checkpoint.

## Delivered behavior

`agent-service/src/agent/native/evidence.ts` consumes typed, version-bound
profiles and the event's declared DAG. It does not parse displayed statistics,
infer arbitrary Python semantics, fetch more data, or execute the workflow.
Successful V2 results use this renderer even with evidence off, so the four
V2 exposure arms share the same typed table format.

The existing `maxOperatorResultCharLimit` now bounds the **whole successful
result body**: counts, typed column labels, samples, evidence and version labels.
This is a character budget, not an exact model-token cap. A tighter explicit
per-operator compaction budget can further shorten a saved frame. Framework
action/definition/receipt text and the separate error path are not counted as
part of this successful result body.

Selection is deterministic, heuristic and auditable, not a learned or globally
optimal knapsack solver:

1. Keep a complete small table first when its schema, held rows, row count and
   truncation flags actually prove complete visibility. Do not repeat output
   statistics that merely restate that table. An aggregate's input denominator
   is not redundant with a one-row answer and may still be selected.
2. Otherwise allocate a bounded schema view (up to 30% of the body budget),
   prioritizing declared operation/consumer columns, including rename targets,
   predicate inputs and join/group keys. No fixed first/last-50-column filter.
3. Rank the first stored sample row, operational measurements, relevant column
   profiles, further head/tail stored sample rows and contract descriptions.
   Each row/fact is atomic; something too long is omitted, not cut into a false
   complete observation. Ties use code-point ordering, not locale/random order.
4. Keep selected IDs, omitted IDs/reasons and full version references in an
   audit record, not an extra model-facing statistics block. No benchmark IDs,
   gold answers, domain inclusion rules or task-text scoring are used.

Strings are JSON-escaped; true null, literal `"NULL"`, booleans and exact int64
decimals stay distinguishable. Schema-declared `__row_index__` and
`__is_visualization__` are ordinary user columns in V2.

## What is calculated

- Data: per-column null/nonnull counts, distinct nonnull counts, uniqueness
  fractions, ranges, bounded frequency dictionaries and structural counters
  already supplied by the ordinary collector. Unknown distinct counts remain
  unknown. Zero-denominator ratios are undefined. Partial prefix coverage is
  labeled and is not promoted to a random representative or full-table sample.
- Contract facts: row/order and declared dependency guarantees from the
  execution-tested catalog. UDF row/column mapping stays unknown, including
  when input/output counts happen to be equal.
- Filter: exact kept/input, rejected and missing-predicate counts under its
  declared null policy; version-matched before/after null and distinct counts
  for declared predicate columns, with each profile's coverage retained.
- Aggregate: input rows, output groups, group-size min/max, and per-reducer
  nonnull totals/min/max. Count-without-column uses a row denominator. Empty
  grouped input has zero groups and undefined per-group extrema; ungrouped
  empty input still has one output row. No uncollected group histogram is
  invented.
- Join: measured matched output contribution, matched/unmatched rows and
  distinct keys per logical port, null-key counts and maximum eligible-key
  multiplicity. Validate the declared join/null/cardinality policy and the
  outer-output count equation. Cross joins use the exact Cartesian product.
  Marginal column distributions never stand in for measured key overlap.
- Union/Distinct/Limit: input row sums or removed counts with declared basis;
  aligned missing-column metadata for Union. Scan retains measured source and
  parse/preview coverage, without claiming every workbook sheet was read.
- Cast and row-preserving transforms: explicit conversion-failure counts when
  provided, declared dependencies, and comparable full-profile null-count
  changes. Null deltas are not changed-cell counts or symbolic formula proofs.

Measurements require the output profile to match the result version and every
logical input reference to match its actual input version. Native operational
counters are independently checked against transported input/output counts.
A column collector timing out does not erase a validated full-execution
Filter counter. Conversely, incomplete/invalid operational metadata never
acquires exact relational claims from an arbitrary sample. Optional evidence
failure does not invalidate otherwise valid table data.

## Exposure settings and historical observations

No new model-authored statistics arguments or operator kinds were introduced.
Use fresh V2/batch workflows, as already required for collection changes.

| Purpose | `nativeProfileCollection` | `dataLevel` | `flowLevel` | `columnStats` |
| --- | --- | --- | --- | --- |
| Python framework control | false | 0 | 0 | false |
| Collector-only control | true | 0 | 0 | false |
| Data-only | true | 1 | 0 | false |
| Flow-only | true | 0 | 1 | false |
| Combined | true | 1 | 1 | false |

For V2, a positive data level **or** `columnStats:true` enables selected data
profiles; a positive flow level enables selected flow facts. The legacy level
flags must not append a second V2 profile block outside the budget. The
summarize mapping now explicitly preserves this settings-derived exposure and
budget. Core native operational counters already existed; collection-off does
not mean that every piece of operator bookkeeping disappears.

The production post-step hook records `nativeObservations` after execution,
including cached `operators:[]` observations. Settings and step/signal ownership
are captured before awaiting execution. Aborted or checked-out steps cannot
write an observation under a later HEAD. Only explicitly observed successful
operators enter this record; errors retain the existing always-visible path.

- DELTA uses the event's deeply frozen selection, even after a settings change
  or a new downstream consumer changes relevance. Saved frames can be shortened
  by compaction, not enriched with today's facts. Old imported snapshots that
  never recorded exposure settings do not receive retrospective evidence.
- LATEST uses the current DAG/settings and the current explicit observe set.
  A read-only inspection does not replace that set.
- Snapshot responses optionally include `nativeObservations`, with text,
  selected/omitted IDs, options, full input version references and render chunks.
  This is an audit surface, not automatic model exposure of hidden successes.
- V2 `inspectResult(stats:true)` uses collected structured profiles, limits
  schema/sample/statistics to requested columns, reports unavailable metrics,
  and shares the existing result budget. Row filters only search cached rows;
  they do not turn full-output statistics into statistics of a filtered sample.

## Regressions found and fixed

1. The legacy summarize adapter dropped the original data/flow arm and result
   budget. Both now survive its round trip.
2. Compact DELTA decks bypassed the caller's observe filtering and revealed a
   never-observed source sample. The shared per-operator serializer now enforces
   explicit visibility too. A regression forces compaction with a distinctive
   hidden source value and verifies it remains absent.
3. Legacy join-retention heuristics inferred unmatched rows from output counts.
   V2 bypasses those unbudgeted heuristics and uses validated join counters.
4. Structured transport injected a synthetic `__row_index__` over user data and
   could treat a table as visualization solely by column name. V2 now transports
   schema fields only and does not infer a visualization from those names.
   The agent requires the new **`schema-fields-only-v1`** capability as well as
   `typed-scalar-v1` and execution identity. An older C4 typed backend is refused
   with a compatibility error, not silently accepted with overwritten values.
   Legacy transport remains unchanged.

The V2 prompt now explains typed samples, partial profiles, budget omissions,
contract versus measured facts, undefined denominators and cached version
labels. Its batch/observe principles and Python/no-SQL operator API remain.

## Verification and remaining gates

- Final Bun: **1,074 pass**, zero failures, 89 files, 10 snapshots and 5,842
  assertions. TypeScript typecheck passes.
- Final Scala non-integration-tagged suite: **1,672 ScalaTest tests pass**, two
  pending, plus three passing JUnit tests (aggregate **1,675**, zero failures).
  The dedicated structured-transport suite passed all 12 tests, and the final
  `WorkflowExecutionService/dist` build passes with the new capability included.
- New local tests exercise calculations, stale bindings, exact integers/nulls,
  wide/renamed column relevance, atomic budgets, monotone compaction, cached
  inspection, ownership/settings changes, all six message-layout choices
  (including default), session/catalog/index modes, and actual observe hiding.
- A Python-runtime round-trip test executes all 14 core operator types across
  18 results, runs the real collector, decodes its envelopes and binds versions
  through production snapshot storage before calculating evidence. It includes
  null-key self-join, cross join, lossy cast, null fill, grouped/ungrouped empty
  aggregates and all four exposure combinations at a 600-character budget.
  This is a local cross-language test, **not a Texera/LLM E2E run**. No Python
  production code changed, and earlier full pytest counts are not relabeled
  as reruns.
- `benchmark/e2e/native-evidence-run.ts` is prepared but **not yet run**. It
  checks DELTA/LATEST × four exposure combinations using real service snapshot
  records and the service's actual context preview. It uses block layout because
  that UI preview returns the first assembled message, not an entire native
  transcript. Three debug steps per case cover reversed batching, cached
  observation, upstream revision/new consumer, hidden success, frozen frames,
  budgets and reserved-name transport. It starts no services itself.

Temporary verification logs use `/tmp/native-python-dataflow-c5-`:
`bun-verified.log`, `typecheck-verified.log`, `evidence-green.log`,
`compact-red.log`/`compact-green.log`, `layouts.log`,
`transport-red.log`/`transport-green.log`, and `scala-verified.log`.
Temporary files may expire; this checkpoint is the durable sanitized record.

Commands: `bun test`, `bun run typecheck`, and
`sbt 'WorkflowExecutionService/test' 'WorkflowExecutionService/dist'` with
`AMBER_TEST_FILTER=skip-integration`. The test-only upload stub used port 39192,
not the shared file service's 9092. Credentials were supplied privately; no
environment files or dependency symlinks are part of these commits. The newly
built ZIP is under `amber/target/universal/`; the previously unpacked C4
distribution has **not** been refreshed or deployed. Any live rerun must use
the new distribution and the matching worktree's Python code.

Next gates: coordinated matching-engine live C4 repair/C3 core/C5 evidence
reruns; remaining C6 shape operators and expanded pinned diagnostics; real-LLM
batch/observe/error-repair traces; then the planned small KramaBench pilot with
official accuracy, compile/execution pass and cache-aware cost. No measured
optimization benefit or completed full plan is claimed here.
