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

### Example: build on an earlier task

Task 1 asks for the three units with the largest delivered-order amounts.
The verified source has 24 orders across eight units, with `order`, `unit`,
`status` and `amount` columns. Keep all unit scores in `score`; only `report`
is cut to the requested count:

```json
{
  "reasoning": "Compute every unit's delivered-order score and rank a separate answer table.",
  "actions": [
    {"type": "edit", "changes": "orders = scan(\"data/unit_orders.csv\")\neligible = filter(orders, lambda row: row[\"status\"] == \"delivered\", doc=\"Delivered orders\")\nscore = aggregate(eligible, by=[\"unit\"], score=sum(\"amount\"))\nreport = limit(score, 3, by=[(\"score\", \"desc\"), \"unit\"])"},
    {"type": "execute", "operator_ids": ["report"]},
    {"type": "retrieve", "operator_id": "score", "view": "full"},
    {"type": "retrieve", "operator_id": "report", "view": "full"}
  ]
}
```

After checking the full scores and the ranked report, answer:

```json
{
  "reasoning": "The report contains the three highest delivered-order scores.",
  "actions": [{"type": "answer", "from": "report[unit, score:full]"}]
}
```

Task 2 introduces a standing coverage rule: a unit needs at least three
orders in the full source, including cancelled orders. It asks for up to five
covered units by the same delivered-order score. Count `orders`, not the
filtered `eligible` table, and connect the complete `score`, not `report`:

```json
{
  "reasoning": "Apply coverage measured on all orders while retaining every eligible unit score for later tasks.",
  "actions": [
    {"type": "edit", "changes": "unit_counts = aggregate(orders, by=[\"unit\"], order_count=count())\ncounted_scores = join(score, unit_counts, on=\"unit\", how=\"left\", validate=\"one_to_one\")\ncovered_scores = filter(counted_scores, lambda row: row[\"order_count\"] >= 3, doc=\"Units with at least three source orders\")\nreport = limit(covered_scores, 5, by=[(\"score\", \"desc\"), \"unit\"])"},
    {"type": "execute", "operator_ids": ["report"]},
    {"type": "retrieve", "operator_id": "covered_scores", "view": "full"},
    {"type": "retrieve", "operator_id": "report", "view": "full"}
  ]
}
```

Here every unit has three source orders, so `covered_scores` retains eight
rows and `report` has five. A later request about all covered units should
read `covered_scores`. If only two units qualified, the report would contain
two; the coverage rule would still apply.
{{#ledger}}
The edit's provenance identifies `orders` and `score` as inputs from task 1.
The answer's catalog entry records the new coverage operators and the changed
report, so later tasks can locate the full working table.
{{/ledger}}

```json
{
  "reasoning": "The report ranks the covered units without changing their eligibility.",
  "actions": [{"type": "answer", "from": "report[unit, score:full]"}]
}
```

### Example: repair an aggregate that reads a limited report

A later request asks for the average score across every covered unit.
Suppose `mean_score = aggregate(report, by=[], average_score=mean("score"))`
reads the five-row `report`. Execution succeeds, but retrieving or
inspecting `mean_score` includes this structural fact:

```text
### 3. retrieve mean_score: ok
- **mean_score** (aggregate, executed)
  - inputs: `report`
  - result: 1 row × 1 column
  - scope: limit "report": n=5, offset=0; input "covered_scores" (8 rows); output 5 rows.
```

The aggregate's single row can be displayed completely while its input covers
only five units. The request concerns all eight covered units, so restate
the aggregate on `covered_scores`, preserving the coverage rule and the
earlier top-five answer:

```json
{
  "reasoning": "Average every covered unit rather than only the previous report's selected units.",
  "actions": [
    {"type": "edit", "changes": "mean_score = aggregate(covered_scores, by=[], average_score=mean(\"score\"))"},
    {"type": "execute", "operator_ids": ["mean_score"]},
    {"type": "retrieve", "operator_id": "mean_score", "view": "full"}
  ]
}
```

Use the recomputed mean in the answer. If the request instead asked for the
average of the earlier top five, the original input would be appropriate.
Scope describes the graph; the request determines which input to use.
