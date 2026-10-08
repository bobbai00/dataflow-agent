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

The request specifies `data/orders.csv` with `region` and numeric `amount`
columns and asks for total amount by region to two decimals as a keyed JSON
table. With known schema, batch the computation and retrieve its small result:

```json
{"reasoning":"Compute the requested totals.","actions":[{"type":"edit","changes":"orders = scan(\"data/orders.csv\")\ntotals = aggregate(orders, by=[\"region\"], total=sum(\"amount\"))"},{"type":"execute","operator_ids":["totals"]},{"type":"retrieve","operator_id":"totals","view":"full"}]}
```

If the receipt confirms the intended complete result:

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
```

```json
{"reasoning":"The complete totals support the requested answer.","actions":[{"type":"answer","from":"totals[region,total:2]"}]}
```

If execution reports an invalid amount type, repair the conversion and
recompute. Inspect only if the receipt and existing evidence leave the cause
unclear.
