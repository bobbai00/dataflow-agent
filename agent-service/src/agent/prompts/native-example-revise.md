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

### Example: revise a rule for the rest of the session

Task 3 says that from now on every order with an amount counts, not only the
delivered ones. No request needs the delivered-only rule beside the new one,
so update the operator that holds it rather than building a second version:

```json
{
  "reasoning": "Revise the order rule where it is defined so every table built on it follows.",
  "actions": [
    {"type": "edit", "changes": "update operator eligible: filter(lambda row: row[\"amount\"] is not None, doc=\"Orders with an amount\")"},
    {"type": "execute", "operator_ids": ["kept_orders", "score"]}
  ]
}
```

The receipt of the edit is:

```text
### 1. edit: ok
1 change applied; results invalidated: eligible, score, review_orders, kept_orders.
- **eligible** (filter, updated)
  - inputs: `orders`
  - result: stale (execute to recompute)
{{#ledger}}
inputs from earlier tasks:
- **orders** (scan, cached)
  - definition: `scan("data/unit_orders.csv")`
  - origin: task 1
  - result: 24 rows × 5 columns
  - columns: order int64, unit str, country str, status str, amount int64
  - used by: `eligible`
{{/ledger}}
```

The edit invalidates every table built on `eligible`: `score` from task 1 and
`review_orders` and `kept_orders` from task 2. The execute recomputes them
under the new rule, so later requests read the revised tables without further
edits.
{{#history}}
The delivered-only version remains saved under tasks 1 and 2.
{{/history}}
{{#ledger}}
The task's catalog entry records the update and what it recomputed:

```text
#### Task 3
1 table updated; 3 recomputed.
- **eligible** (filter, updated)
  - definition: `filter(lambda row: row["amount"] is not None, doc="Orders with an amount")`
  - inputs: `orders`
  - result: 24 rows × 5 columns
  - columns: order int64, unit str, country str, status str, amount int64
- **score** (aggregate, recomputed)
  - definition: `aggregate(by=["unit"], score=sum("amount"))`
  - inputs: `eligible`
  - result: 8 rows × 2 columns
  - columns: unit str, score int64
- **review_orders** (join, recomputed)
  - definition: `join(on="unit", how="semi")`
  - inputs: left `eligible`, right `review_units`
  - result: 9 rows × 5 columns
  - columns: order int64, unit str, country str, status str, amount int64
- **kept_orders** (filter, recomputed)
  - definition: `filter(lambda row: row["country"] not in ["Canada", "Mexico", "United States"], doc="Review orders outside the three named markets")`
  - inputs: `review_orders`
  - result: 3 rows × 5 columns
  - columns: order int64, unit str, country str, status str, amount int64
```
{{/ledger}}
