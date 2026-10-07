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
once, as a shared function whose likely changes are settings, keep every
unit with the columns the rule reads, and cut the report with `limit`:

```dataflow
orders = scan("data/orders.csv")
def unit_scores(orders, delivered_only=False, refund_weight=0.0):
    """One row per unit with order count, amount and refunded amount; score = amount - {refund_weight} x refunded; delivered orders only: {delivered_only}."""
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

Task 2 says that from now on only delivered orders count. The rule changes
where it lives, in place:

```dataflow
scores = unit_scores(orders, delivered_only=True)
```

Executing `top3` recomputes everything built on `scores` and compares each
recomputed table with the version task 1 saved:

```text
### 2. execute top3: ok
3 operators in scope: 2 executed, 1 cached.
- **scores** (process, executed)
  - changed since scores@1: 6 → 6 rows; 6 kept with new values (rows matched on unit).
- **top3** (limit, executed)
  - changed since top3@1: 3 → 3 rows; entered (1): south; left (1): east; 2 kept with new values (rows matched on unit).
```

The receipt already says which units entered and left the report; read
`top3` for the values and answer from it. Later tasks build on the revised
`scores` without further work.

Task 3 asks what the report would be if refunds counted at half their
amount, for this question only. One new call with another setting leaves the
main view as task 2 left it:

```dataflow
refund_scores = unit_scores(orders, delivered_only=True, refund_weight=0.5)
refund_top3 = limit(refund_scores, 3, by=[("score", "desc"), "unit"])
```

Task 4 asks how far each unit moved from the first report. Compare the saved
table with the current one; `scores@1` is read from its saved result and
nothing from task 1 runs again:

```dataflow
moves = diff(scores@1, scores, key=["unit"], columns=["score"])
largest_moves = limit(moves, 3, by=[("score_abs_delta", "desc"), "unit"])
```

```json
{"reasoning":"Compare the first scores with the current ones and read the largest moves.","actions":[{"type":"execute","operator_ids":["largest_moves"]},{"type":"read","operator_ids":["scores@1","largest_moves"],"view":"full","columns":null,"include_implementation":false}]}
```
```json
{"reasoning":"Report the three largest moves.","actions":[{"type":"answer","from":"largest_moves[unit, score_left:2, score_right:2, score_delta:2]"}]}
```

Task 5 says that from now on orders under 5 are ignored. That is a change to
the rule itself, so redefine the function in place; every call follows it:

```dataflow
def unit_scores(orders, delivered_only=False, refund_weight=0.0, min_amount=5):
    """One row per unit with order count, amount and refunded amount over orders of at least {min_amount}; score = amount - {refund_weight} x refunded; delivered orders only: {delivered_only}."""
    rows = orders[orders["amount"] >= min_amount]
    rows = rows[rows["delivered"]] if delivered_only else rows
    out = rows.groupby("unit", as_index=False).agg(
        orders=("order_id", "count"), amount=("amount", "sum"), refunded=("refund", "sum"))
    out["score"] = out["amount"] - refund_weight * out["refunded"]
    return out
```

```text
### 1. edit: ok
- note: unit_scores redefined; its callers scores, refund_scores recompute on the next execute. Results saved by earlier tasks stay readable as name@N.
```

Task 6 returns to the first report's rule for the rest of the session. Make
task 1's definition current again; it runs `unit_scores` as it was then:

```dataflow
scores = scores@1
```

```text
- note: scores runs unit_scores as it was at the end of task 1, now named unit_scores_t1; unit_scores keeps its current definition.
```

To read the definition a task saved before deciding what to reuse:

```json
{"reasoning":"Check the saved rule before reusing it.","actions":[{"type":"read","operator_ids":["scores@1"],"view":null,"columns":null,"include_implementation":true}]}
```
