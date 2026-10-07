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

This example uses a generic `data/orders.csv` with order_id, unit, amount,
delivered and refund columns, not benchmark answers. Receipts are shortened
to the lines that matter.

Task 1 asks for the three units with the highest order value. Write the rule
once with its numbers as settings, keep every unit with the columns the rule
reads, and cut the report with `limit`:

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

The answer saves every completed table: `scores@1` and `top3@1` now name
these results for the rest of the session.

Task 2 says that from now on only delivered orders count. That is a lasting
change to one setting, made where it lives:

```dataflow
scores.delivered_only = True
```

Executing `top3` recomputes everything built on `scores` and compares each
recomputed table with the version task 1 saved:

```text
### 2. execute top3: ok
- **scores** (process, executed)
  - changed since scores@1: 6 → 6 rows; 6 kept with new values (rows matched on unit).
- **top3** (limit, executed)
  - changed since top3@1: 3 → 3 rows; entered (1): south; left (1): east; 2 kept with new values (rows matched on unit).
```

The receipt already says which units entered and left the report; read
`top3` for the values and answer from it.

Task 3 asks how the ranking would change if refunds counted at half their
amount, for this question only. A variant copies `scores` with the other
setting and leaves the real one alone, and `rank_change` compares the two
rankings:

```dataflow
half_refunds = variant(scores, scores={"refund_weight": 0.5})
moves = rank_change(scores, half_refunds, key=["unit"], by=[("score", "desc")], n=3)
```

```text
- **half_refunds** (process, executed)
  - differs from scores: 6 → 6 rows; 4 kept with new values (rows matched on unit).
- **moves** (rank_change, executed)
  - rank change: 1 entered, 1 left, 2 stayed in the top 3.
```

Task 4 says that from now on refunds do count at half. The variant already
holds that rule, so one line makes it current; `scores` takes its setting,
and `top3` and everything else built on `scores` follow:

```dataflow
scores = half_refunds
```

Task 5 says that from now on orders under 5 are ignored. Insert the filter
after the scan: `orders` keeps its name, the earlier scan continues as
`orders_v1`, and every table that read `orders` now reads the filtered rows:

```dataflow
orders = filter(orders, lambda row: row["amount"] is not None and row["amount"] >= 5, doc="Orders of at least 5")
```

Task 6 asks how today's top three compares with the first report. Compare
the saved ranking with the current one; `scores@1` is read from its saved
result and nothing from task 1 runs again:

```dataflow
since_first = rank_change(scores@1, scores, key=["unit"], by=[("score", "desc")], n=3)
```

Task 7 returns to the scores as they were before refunds counted, and
continues from there. The entries of earlier tasks say what each one did to
`scores`:

```text
## Task 2 (answered)
Operators:
- **scores** (process, updated: set delivered_only False to True)
...
## Task 4 (answered)
Operators:
- **scores** (process, updated: set refund_weight 0 to 0.5)
```

Task 4 set the refund weight, so `scores@3` is the last version without it.
Make it current again; it runs on today's filtered orders:

```dataflow
scores = scores@3
```

To read the definition a task saved before deciding what to reuse:

```json
{"reasoning":"Check the saved rule before reusing it.","actions":[{"type":"read","operator_ids":["scores@3"],"view":null,"columns":null,"include_implementation":true}]}
```
