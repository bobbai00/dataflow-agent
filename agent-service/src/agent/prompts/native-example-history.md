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

### Example: retrieve a relevant task before reusing its work

Task 1 prepared eligible records. Task 2 added a grouping by category and a
top-five report. Task 3 now asks for counts by region using the complete
eligible records. Inspect task 2 to identify which parts can be reused:

```json
{
  "reasoning": "Inspect task 2's saved computation before choosing a reusable starting point.",
  "actions": [
    {"type": "inspect", "target": "task", "task_id": 2, "operator_id": null, "include_implementation": true, "view": "sample_stats"}
  ]
}
```

The local computation shows category grouping followed by `limit(5)`, and a
saved input reference to task 1's `eligible` table. Neither the grouping nor
the five-row report answers the new regional question. The input reference
helps locate reusable work but does not prove that its filter was correct.
Expand just that input and verify its rule against the new request:

```json
{
  "reasoning": "Check the complete working records rather than inherit the previous report's limit.",
  "actions": [
    {"type": "inspect", "target": "task", "task_id": 1, "operator_id": "eligible", "include_implementation": true, "view": "sample_stats"}
  ]
}
```

If the saved branch matches the requested rule, fork it when its historical
inputs are needed, then build the new grouping on that branch. If its filter
was wrong, correct the fork and recompute the affected outputs. A saved answer
does not establish correctness, and a complete saved table does not establish
that it contains the right rows. Use the available statistics and scope
evidence when they help resolve those questions. Retrieve the new `by_region`
result, then compose the answer directly from its requested columns:

```json
{
  "reasoning": "Answer using the checked regional counts and record their source table.",
  "actions": [
    {"type": "answer", "from": "by_region[region,count]"}
  ]
}
```

The runtime serializes the rows and records `by_region` as the answer source.
The agent remains responsible for the computation and requested fields.

### Example: compare with an earlier task and go back

Task 4 asks how every unit's score changed from task 2, including units that
were outside its top-five report. Task 2 retained all eight rows in `score`
under the delivered-only rule, which task 3 replaced in place. Fork that full
working table and compare the two versions in the graph:

```json
{
  "reasoning": "Compare today's scores with the scores task 2 reported, using its saved version.",
  "actions": [
    {"type": "edit", "changes": "fork operator score from task 2 as score_t2\ncreate operator score_vs_task2: join(on=\"unit\", how=\"left\", suffix=\"_task2\")\ncreate edge score.out -> score_vs_task2.left\ncreate edge score_t2.out -> score_vs_task2.right\ncreate operator score_change: map(lambda row: {**row, \"change\": None if row[\"score_task2\"] is None else row[\"score\"] - row[\"score_task2\"]}, doc=\"Score change per unit since task 2\")\ncreate edge score_vs_task2.out -> score_change.in"},
    {"type": "execute", "operator_ids": ["score_change"]},
    {"type": "retrieve", "operator_id": "score_change", "view": "full"}
  ]
}
```

The fork `score_t2` comes with the inputs it had at task 2. The receipt of the
retrieve is:

```text
### 3. retrieve score_change: ok
- **score_change** (map, executed)
  - inputs: `score_vs_task2`
  - result: 8 rows × 4 columns
  - columns: unit str, score int64, score_task2 int64, change int64
records: full; 8 of 8 rows, 4 of 4 columns (complete)
| unit | score | score_task2 | change |
|---|---|---|---|
| U01 | 54 | 44 | 10 |
| U02 | 57 | 57 | 0 |
| U03 | 60 | 40 | 20 |
| U04 | 63 | 63 | 0 |
| U05 | 66 | 36 | 30 |
| U06 | 69 | 54 | 15 |
| U07 | 72 | 72 | 0 |
| U08 | 75 | 50 | 25 |
- flow (score_vs_task2): Join type=left, keys="unit". Join matched contribution=8 (sum L(k)*R(k)); output=8, including outer unmatched rows as declared. left matched rows=8/8, unmatched rows=0; matched keys=8/8, unmatched keys=0; null-key rows=0, max eligible multiplicity=1. right matched rows=8/8, unmatched rows=0; matched keys=8/8, unmatched keys=0; null-key rows=0, max eligible multiplicity=1.
- flow (score): Aggregate group keys=["unit"]. input column "status" was read by no operator on the way here; over the 24 rows reduced it is "delivered":19, "cancelled":5. Aggregate groups=8 from 24 rows; group size min=3, max=3.
- flow (score_t2): Aggregate group keys=["unit"]. Aggregate groups=8 from 19 rows; group size min=2, max=3. "score" nonnull=19/19; per-group min=2, max=3; reducer=sum.
- flow: contract; Map: row identities preserved, same order; added=["change"]; dropped=[]; dependencies measured from the columns the function read.
```

To read the earlier working result without computing anything, use `inspect`
with `target: "state"`, `operator_id: "score"`, `task_id: 2` and a view. To
read only the answer selection, inspect `report` at task 2 instead. The fork
uses task 2's input versions; restoring just a definition uses current inputs.

Task 5 asks to go back to delivered orders only, for everything that follows.
List the versions of `eligible` to find the task that used that rule:

```json
{
  "reasoning": "Find which tasks used the delivered-orders rule.",
  "actions": [
    {"type": "inspect", "target": "state", "operator_id": "eligible", "task_id": null, "include_implementation": false, "view": null}
  ]
}
```

Observation:

```text
### 1. inspect eligible versions: ok
versions: eligible
| tasks | change | definition |
|---|---|---|
| 1-2 | created | `filter(lambda row: row["status"] == "delivered", doc="Delivered orders")` |
| 3-4 | updated | `filter(lambda row: row["amount"] is not None, doc="Orders with an amount")` |
```

Tasks 1 and 2 used the delivered-orders rule. Update `eligible` from task 2,
which restores that definition in place, and execute the tables that read it:

```json
{
  "reasoning": "Restore the delivered-orders rule for the rest of the session.",
  "actions": [
    {"type": "edit", "changes": "update operator eligible from task 2"},
    {"type": "execute", "operator_ids": ["report"]}
  ]
}
```

The restored definition runs on today's `orders`. The coverage rule and its
source-based counts stay in place. `score_t2` keeps its historical input
branch; restoring the current rule does not change that fork. The comparison
tables from task 4 stay stale until they are executed again. Retrieve the
current report before answering task 5.
