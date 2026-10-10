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

### Example: load a source, compute from it and answer

Request: report the total order amount by region from `data/orders.csv`. Scan
the file in full and look at it:

```json
{"reasoning": "Load the orders file and check its layout.", "actions": [{"type": "edit", "changes": "orders = scan(\"data/orders.csv\")"}, {"type": "execute"}, {"type": "retrieve", "operator_id": "orders", "view": "sample_stats"}]}
```

The receipt of the retrieve shows the parsed table:

```text
### 3. retrieve orders: ok
- **orders** (scan, executed)
  - result: 4 rows × 3 columns
  - columns: region str, amount float64, date str
records: sample_stats; 4 of 4 rows, 3 of 3 columns (complete)
| region | amount | date |
|---|---|---|
| east | 70.5 | 2026-01-03 |
| west | 30 | 2026-01-04 |
| east | 50 | 2026-01-05 |
| west | 50 | 2026-01-06 |
statistics: not shown; the complete records above show every value
- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=4 rows.
```

The header and types are as expected. Compute the totals and read the small
result in full:

```json
{"reasoning": "Compute total amounts by region.", "actions": [{"type": "edit", "changes": "totals = aggregate(orders, by=[\"region\"], total=sum(\"amount\"))"}, {"type": "execute", "operator_ids": ["totals"]}, {"type": "retrieve", "operator_id": "totals", "view": "full"}]}
```

```text
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
```

The complete result answers the request:

```json
{"reasoning": "The complete totals table answers the request.", "actions": [{"type": "answer", "content": "east: 120.5; west: 80"}]}
```
