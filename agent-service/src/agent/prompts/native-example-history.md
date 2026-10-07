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

### Example: one session whose rules change

A generic `data/orders.csv` has order_id, unit, amount, delivered and refund
columns; receipts are shortened to the line that matters.

Task 1 asks for the three units with the highest order value. Write the rule
once with its numbers as settings, keep every unit, and cut the report with
`limit`:

```dataflow
orders = scan("data/orders.csv")
def unit_scores(orders, delivered_only=False, refund_weight=0.0):
    """One row per unit: orders, amount, refunded and score = amount - {refund_weight} x refunded."""
    rows = orders[orders["delivered"]] if delivered_only else orders
    out = rows.groupby("unit", as_index=False).agg(
        orders=("order_id", "count"), amount=("amount", "sum"), refunded=("refund", "sum"))
    out["score"] = out["amount"] - refund_weight * out["refunded"]
    return out
scores = unit_scores(orders)
top3 = limit(scores, 3, by=[("score", "desc"), "unit"])
```

```json
{"reasoning":"Compute every unit's score and read the top three.","actions":[{"type":"execute","operator_ids":["top3"]},{"type":"read","operator_ids":["top3"],"view":"full","columns":null,"include_implementation":false}]}
```
```json
{"reasoning":"Report the three leading units.","actions":[{"type":"answer","from":"top3[unit, score:2]"}]}
```

Task 2 says that from now on only delivered orders count. Restate the call
with the new setting; executing `top3` recomputes everything built on
`scores` and compares it with the version task 1 saved:

```dataflow
scores = unit_scores(orders, delivered_only=True)
```

```text
### 2. execute top3: ok
- **top3** (limit, executed)
  - changed since top3@1: 3 → 3 rows; entered (1): south; left (1): east; 2 kept with new values (rows matched on unit).
```

Task 3 asks how the ranking would change if refunds counted at half their
amount, for this question only. Compute it alongside, and leave `scores` as it
is:

```dataflow
half_refunds = unit_scores(orders, delivered_only=True, refund_weight=0.5)
moves = rank_change(scores, half_refunds, key=["unit"], by=[("score", "desc")], n=3)
```

Task 4 asks how today's top three compares with the first report. The saved
`scores@1` is an input; nothing from task 1 runs again:

```dataflow
since_first = rank_change(scores@1, scores, key=["unit"], by=[("score", "desc")], n=3)
```

Task 5 returns to the scores of task 1 and continues from there. Task 2's
entry says `updated: set delivered_only False to True`, so `scores@1` is the
version wanted. Read the saved rule, then make it current again on today's
orders:

```json
{"reasoning":"Check the saved rule before reusing it.","actions":[{"type":"read","operator_ids":["scores@1"],"view":null,"columns":null,"include_implementation":true}]}
```

```dataflow
scores = scores@1
```
