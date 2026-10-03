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

Task 1 loaded `orders` and `review_units` and kept the delivered orders in
`eligible`. Task 2 asks for the delivered orders of the units under review,
excluding three named markets. Connect the existing selection rather than
retyping its units; the markets come from the request, so they belong in the
filter that excludes them:

```json
{
  "reasoning": "Restrict delivered orders to the review units and drop the three named markets.",
  "actions": [
    {"type": "edit", "changes": "create operator review_orders: join(on=\"unit\", how=\"semi\")\ncreate edge eligible.out -> review_orders.left\ncreate edge review_units.out -> review_orders.right\ncreate operator kept_orders: filter(lambda row: row[\"country\"] not in [\"Canada\", \"Mexico\", \"United States\"], doc=\"Review orders outside the three named markets\")\ncreate edge review_orders.out -> kept_orders.in"},
    {"type": "execute", "operator_ids": ["kept_orders"]},
    {"type": "retrieve", "operator_id": "kept_orders", "view": "sample_stats"}
  ]
}
```

{{#ledger}}
The edit's receipt lists `eligible` and `review_units` under `inputs from
earlier tasks:` with their definitions, so they can be checked before the
result is trusted. After reading `kept_orders`, answer the task. The answer's
receipt is the task's catalog entry:

```text
### 1. answer: ok
Answer recorded.
#### Task 2
2 tables created.
- **review_orders** (join, created)
  - definition: `join(on="unit", how="semi")`
  - inputs: left `eligible`, right `review_units`
  - result: 8 rows × 5 columns
  - columns: order int64, unit str, country str, status str, amount int64
- **kept_orders** (filter, created)
  - definition: `filter(lambda row: row["country"] not in ["Canada", "Mexico", "United States"], doc="Review orders outside the three named markets")`
  - inputs: `review_orders`
  - result: 3 rows × 5 columns
  - columns: order int64, unit str, country str, status str, amount int64
```

{{/ledger}}
