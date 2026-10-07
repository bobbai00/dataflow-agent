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

### Example: preview a source, compute from the full file and answer

Request: report the total order amount by region. The layout of
`data/orders.csv` is unknown, so preview it before choosing parse options:

```json
{
  "reasoning": "Preview the orders file to choose its parse options.",
  "actions": [
    {"type": "edit", "changes": "orders = scan(\"data/orders.csv\", preview=8)"},
    {"type": "execute"},
    {"type": "retrieve", "operator_id": "orders", "view": "sample_stats"}
  ]
}
```

The receipt of the retrieve is:

```text
### 3. retrieve orders: ok
- **orders** (scan, executed)
  - result: 6 rows × 3 columns
  - columns: file str, line_no int64, line str
records: sample_stats; 6 of 6 rows, 3 of 3 columns (complete; source preview only)
| file | line_no | line |
|---|---|---|
| orders.csv | 0 | Exported by finance |
| orders.csv | 1 | region,amount,date |
| orders.csv | 2 | east,70.5,2026-01-03 |
| orders.csv | 3 | west,30,2026-01-04 |
| orders.csv | 4 | east,50,2026-01-05 |
| orders.csv | 5 | west,50,2026-01-06 |
statistics: not shown; the complete records above show every value
- flow: Scan preview only (not full source); files selected=1/1, omitted=0; output=6 rows.
```

The file starts with one preamble line, and the header is on line 1. `orders`
still holds only the preview, so load the full file without the preamble and
compute the requested totals in the same call:

```json
{
  "reasoning": "Load all orders and compute total amounts by region.",
  "actions": [
    {"type": "edit", "changes": "orders = scan(\"data/orders.csv\", skip_lines=1)\ntotals = aggregate(orders, by=[\"region\"], total=sum(\"amount\"))"},
    {"type": "execute", "operator_ids": ["totals"]},
    {"type": "retrieve", "operator_id": "totals", "view": "full"}
  ]
}
```

Observation:

```text
### 1. edit: ok
3 changes applied; results invalidated: orders.
- **orders** (scan, updated)
  - result: stale (execute to recompute)
- **totals** (aggregate, created)
  - inputs: `orders`
  - result: not run
- created edge: orders.out -> totals.in

### 2. execute totals: ok
2 operators in scope: 2 executed, 0 cached.
- **orders** (scan, executed)
  - result: 4 rows × 3 columns
  - columns: region str, amount float64, date str
  - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=4 rows.
- **totals** (aggregate, executed)
  - inputs: `orders`
  - result: 2 rows × 2 columns
  - columns: region str, total float64
  - flow: Aggregate groups=2 from 4 rows; group size min=2, max=2.
  - flow: "total" nonnull=4/4; per-group min=2, max=2; reducer=sum.

### 3. retrieve totals: ok
- **totals** (aggregate, executed)
  - inputs: `orders`
  - result: 2 rows × 2 columns
  - columns: region str, total float64
records: full; 2 of 2 rows, 2 of 2 columns (complete)
| region | total |
|---|---|
| east | 120.5 |
| west | 80 |
- flow: Aggregate groups=2 from 4 rows; group size min=2, max=2.
- flow: "total" nonnull=4/4; per-group min=2, max=2; reducer=sum.
- flow: contract; Aggregate: one output row per group; group keys=["region"]; null keys form a group.
```

The complete result establishes the requested totals. Answer in the requested
format:

```json
{
  "reasoning": "The complete totals table answers the request.",
  "actions": [
    {"type": "answer", "content": "east: 120.5; west: 80"}
  ]
}
```
