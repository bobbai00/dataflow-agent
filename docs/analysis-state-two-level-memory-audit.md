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

**Within-task observations and between-task entries, 2026-09-24.**
The strongest evaluated arm already selects operator outputs explicitly.
There is substantial overhead in replayed status lines and historical entry
formatting. In the newer arm, a rejected retrieval request can also bypass the
normal output-selection rule. These are separate targets from discarding useful
analytical state.

This audit uses the six first-pass tasks, saved traces and frozen-r3 source.
Existing judge labels are unchanged. No runtime changes, executions, service
restarts or model calls were made. The [structured evidence](analysis-state-two-level-memory-audit.json)
includes each action's selection, parsed observations, source hashes, the full
original Survey entry and a proposed compact version. Cost context comes from
the earlier [cost audit](analysis-state-context-cost-audit.md).

**What an entry actually contains.** An entry is created at the end of a user
question and then replayed as an immutable message. It includes:

1. The full request, including inherited conditions supplied in that request.
2. Net changes grouped under the action rationale that last established them.
3. Each changed operator's statement, row count, columns, documentation, function
   bodies, selected profile facts and replacement/error information.
4. Tables read during the task: complete small tables if available, otherwise
   samples, within a 4,000-character row-content budget per entry.
5. The complete answer and names of tables containing matching answer numbers.

The source attribution in item 5 is a numeric-matching heuristic, not a formal
proof of every answer claim. Function bodies are limited to 80 lines per
function, and statements to 400 characters; there is no overall entry/history
budget. Unchanged rows from the same table can reference an earlier task instead
of repeating it. Equivalent rows from different derived tables can still repeat.

Survey question 13 is an existing-arm pass and an earlier audited accuracy gain.
Its entry is 3,918 characters. This is an abbreviated view of the actual format:

```text
## Task 13
The role-level intensity score combines three active states: ...
Question: Build a role-level intensity score ... Report the top 5 roles ...
Changes:
  Step 1: I will combine the already computed strict role composition lifts ...
    added role_intensity = process(strict_role_composition_lift,
              strict_coding_experience_comparison,
              strict_ml_experience_comparison, fn=build_role_intensity, doc=...)
             → rows=14; cols=role,composition_lift,coding_anchor,ml_anchor,role_intensity_score
             doc: Scores each role using composition lift ...
             def build_role_intensity(roles, coding, ml):
                 coding_anchor = max(0.0, float(coding["difference_percentage_points"].max()))
                 ml_anchor = max(0.0, float(ml["difference_percentage_points"].max()))
                 ...
    added role_intensity_sorted = sort(role_intensity, ...)
             → rows=14; cols=<the same five columns>
    added top_role_intensity = limit(role_intensity_sorted, 5)
             → rows=5; cols=<the same five columns>
             values: role = <the same five names that appear below>
Tables read:
  top_role_intensity (5 rows, complete): <full-precision values>
  role_intensity_sorted (first 3 of 14 rows): <three rows repeated from above>
Answer: Final Answer: {"roles": [...five rounded scores...]}
  from: top_role_intensity, role_intensity_sorted
```

The actual entry's function calculates one global coding anchor and one global
ML anchor from earlier component tables. These are precisely the details that
helped preserve the intended definition. Its full 14-role table also remains in
the engine even though this entry shows only selected rows.

**The first proposed change keeps the entries architecture.** Preserve the
request, exact function source, named inputs, historical change/version facts,
full-precision answer data and answer. Reduce repetition in their presentation:

| Current material | Proposed reduction | Guardrail |
| --- | --- | --- |
| Action rationale, operator statement, separate doc and code explain the same formula | Keep one canonical definition; omit rationale/doc text only when covered by retained material | Preserve unique scope, units, denominator, missing-value or rounding rules |
| Identical column lists repeated for process, sort and limit | Reference a retained schema for operators that preserve it | Preserve each table's row count and any actual schema change |
| Top-five table plus the same first three rows of its sorted parent | Keep the full top-five rows once and refer to them for the duplicate sample | Keep the full parent table and its 14-row population available |
| Category counts already completely visible in a small table | Omit the repeated profile listing | Keep profiles that expose information not in displayed rows |
| Heavily indented source and repeated formatting labels | Compact the rendering while preserving Python's own indentation and change status | Never rewrite the computational source as an unverified prose summary |

The concrete proposed Survey entry is **2,688 characters, a 31.4% reduction**.
It retains the original request, all three operator statements, Python source,
five full-precision result rows and complete answer. It is an illustrative
rendering change, not an implemented or accuracy-tested feature. That one-entry
character reduction is not a prediction of aggregate model-cost savings.

For a larger later reduction, store exact old definitions and complete results
outside the prompt and retrieve the required dependency/version records before
the current calculation. Preserve explicit contracts and original requests in
the compact history. This needs stronger selection than the newer arm currently
uses, because recalling whole task entries after omitting definitions raised its
call count. Start with format reductions and measure before introducing this
more aggressive selection.

**What the agent observes during ReAct.** `dataflow(edits, observe)` separates
creating/executing operators from showing their results. With a normal structured
tool result:

- `observe: ["A", "C"]` shows A and C's table bodies, including selected schema,
  rows and enabled evidence. This is usually a sample, not every raw output row.
- Unrequested successful outputs have status/row-count receipts only.
- Omitted `observe` or `observe: []` shows no successful table bodies.
- Failures remain visible regardless of the selection.

The recorded `resultSelection: "all"` setting does not override a valid native
`observe` list: the native receipt determines the selection. Inspection and
recall are additional response channels, so `observe: []` can legitimately
return requested definitions or archived entries without table observations.

The 2,000-character result setting is a per-operator table budget. Data and flow
evidence have additional budgets, so it is neither a strict total for one
operator's entire response nor a total per ReAct action. Both evidence kinds are
enabled in these runs. Complete small tables already suppress redundant data
facts; any further per-action budget should preserve their completeness and
useful diagnostic checks rather than indiscriminately shrinking every table.

The agent frequently chooses a subset. Counts below concern successful
added/modified operator receipts, including captured interrupted work:

| Batch category | Existing entries | New analysis arm |
| --- | ---: | ---: |
| Batches changing at least two operators | 140 | 146 |
| Requested every changed output | 27 | 89 |
| Requested some changed outputs | 109 | 57 |
| Requested no changed outputs | 4 | 0 |
| Batches changing exactly three or four operators | 43 | 49 |
| Of those, requested every changed output | 5 | 19 |
| Of those, requested a subset | 37 | 30 |
| Of those, requested no changed output | 1 | 0 |

These are requested selections. Three calls per arm have no subsequent logged
model input carrying their outcome. Restricting to observed follow-up frames,
entries has 42 three/four-operator batches: 36 subset, five all, one none; the
candidate has 48: 29 subset and 19 all. Across inspected frames, no normal
structured receipt displays a successful table body outside its selection.

The audit finds 360 actual entries-arm dataflow calls and 689 candidate calls.
The previous report's 353/684 tool counters came from completed-turn statistics;
the additional 7/5 appear in interrupted-turn traces. This does not change the
reported model-call usage or cost, which already includes captured usage.

Survey 13 creates three operators but requests only two:

```text
role_intensity          = process(three existing component tables, ...)
role_intensity_sorted   = sort(role_intensity, ...)
top_role_intensity      = limit(role_intensity_sorted, 5)
observe = ["top_role_intensity", "role_intensity_sorted"]
```

The unrequested base table receives a receipt. Both requested tables appear.
For this question, the five-row result already contains the required ranking,
component values and score. Observing only it is a concrete candidate reduction;
the sorted 14-row table can remain available for later calculations. Intermediate
checks should still be requested when needed to verify population, join behavior,
missing values or normalization.

**A larger within-task problem: missing baseline for the first observation.**
The Survey 13 observation is 10,004 characters. It includes 43 operator blocks:
three new operators and forty old ones. Comparing saved results before and after
the question confirms that **all forty old result objects are identical**,
including their execution provenance and six old error records. Nevertheless,
they are rendered as re-executed; their blocks occupy **5,824 characters**.

The first active-task observation is compared without the preceding task's
snapshot. `withTaskCatalog` filters completed steps from the active trace;
`buildPath` seeds a baseline only from an included init step. Without a baseline,
`computeDelta` treats existing operators as newly present. The observation layer
then labels unacted entries in that delta as re-executed. These lines therefore
do not prove engine recomputation.

Across the strongest arm's logged tool-result text, counting replay into later
model calls, **60.7% is hidden-output receipts**, 22.8% successful table blocks,
10.5% errors and the remainder other formatting/status text. Of the receipt text
introduced once per tool result, 99.1% occurs on the first action of a question.
These are character shares of tool results, not shares of total billed tokens.
Historical entries still occupy approximately 89.5% of the larger logged context.

The proposed correction is to seed active-task delta rendering with the actual
task-start snapshot. Emit changed operators, newly refreshed results and requested
tables. Keep current failures discoverable; avoid repeatedly pasting an unchanged
old failure's full diagnostics on unrelated questions. This preserves execution
and analytical state while removing misleading and redundant observation text.

**The newer arm also has an error-path selection leak.** An oversized retrieval
request returns an error string before a structured native receipt is built.
`batchObservedIds` then returns `undefined`, which removes the explicit native
observation gate. Combined with the missing task-start baseline and the fallback
`resultSelection: "all"`, a rejected first action can display existing tables.

There are 21 such unstructured retrieval-limit errors; 12 render successful table
bodies despite an omitted or empty `observe`. Together those 12 introduce 685
table bodies and 691,690 characters of table-block text, replayed as 3,780,692
characters across later calls. For example:

- Survey 15 supplies `observe: []`, exceeds the recall limit, and receives 38
  table bodies (38,737 characters of table-block text).
- NFL 33 omits `observe`, exceeds the recall limit, and receives 154 table bodies
  (150,309 characters of table-block text).

This exception is absent from the entries arm's recorded structured tool calls.
The correction should retain the explicit requested scope even on validation
failure, returning the error and relevant diagnostics. It should also validate
or handle retrieval batching without needing another model repair call.

**The two levels need separate controls.**

| Level | What to reduce first | What to preserve |
| --- | --- | --- |
| During ReAct | False whole-graph deltas; output-selection leakage on error; redundant parent/child table displays; unnecessary status/evidence repetition | Requested complete small results, meaningful intermediate checks, new errors and exact state |
| Between tasks | Repeated rationale/docs, schemas, profile facts and overlapping rows inside each entry | Requests, exact formulas, named dependencies, scope/version facts, complete stored tables and precision |

The levels interact: every changed operator is recorded in the entry even if
its output was not requested. Reducing `observe` therefore reduces active output
and some retained sample rows, but does not remove its function, definition or
other change metadata. That is useful for later reuse, and also explains why
output selection alone will not solve the between-task cost.

The recommended order is to correct observation baselines and error scoping,
compact entry formatting without dropping computational content, then evaluate
more selective retrieval if still needed. Keep these changes independently
switchable for validation. The existing successful normalization, partial
rollback and exact-arithmetic cases are regression targets; reducing context is
not sufficient evidence that their accuracy will be preserved.

Source: frozen
[task-context.ts](/tmp/texera-analysis-state/frozen-r3/agent-service/src/agent/native/task-context.ts),
[task-entries.ts](/tmp/texera-analysis-state/frozen-r3/agent-service/src/agent/native/task-entries.ts),
[native-batch-tools.ts](/tmp/texera-analysis-state/frozen-r3/agent-service/src/agent/tools/native-batch-tools.ts),
[context-utils.ts](/tmp/texera-analysis-state/frozen-r3/agent-service/src/agent/util/context-utils.ts),
[Survey 13 trace](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-entries_luna_t1/community__kaggle-survey-2022__task2/turns/t13/react_steps.json),
[Survey entry in the next task](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_react-entries_luna_t1/community__kaggle-survey-2022__task2/turns/t14/react_steps.json).
