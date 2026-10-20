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
    {"type": "edit", "changes": "create operator orders: scan(\"data/unit_orders.csv\")\ncreate operator eligible: filter(lambda row: row[\"status\"] == \"delivered\", doc=\"Delivered orders\")\ncreate operator score: aggregate(by=[\"unit\"], score=sum(\"amount\"))\ncreate operator ranked: sort(by=[(\"score\", \"desc\"), \"unit\"])\ncreate operator report: limit(3)\ncreate edge orders.out -> eligible.in\ncreate edge eligible.out -> score.in\ncreate edge score.out -> ranked.in\ncreate edge ranked.out -> report.in"},
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
    {"type": "edit", "changes": "create operator unit_counts: aggregate(by=[\"unit\"], order_count=count())\ncreate operator counted_scores: join(on=\"unit\", how=\"left\", validate=\"one_to_one\")\ncreate operator covered_scores: filter(lambda row: row[\"order_count\"] >= 3, doc=\"Units with at least three source orders\")\ncreate edge orders.out -> unit_counts.in\ncreate edge score.out -> counted_scores.left\ncreate edge unit_counts.out -> counted_scores.right\ncreate edge counted_scores.out -> covered_scores.in\ndelete edge score.out -> ranked.in\ncreate edge covered_scores.out -> ranked.in\nupdate operator report: limit(5)"},
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
