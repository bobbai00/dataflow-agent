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

### Example: use cast flow statistics to repair unintended missing values

Request: analyze fractional measurements. `measurements` was loaded with
`all_text=True`, and `typed = cast(measurements, value=int64, errors="null")`.
The execute receipt reports:

```text
### 2. execute typed: ok
2 operators in scope: 2 executed, 0 cached.
- **measurements** (scan, executed)
  - result: 20 rows × 2 columns
  - columns: id str, value str
  - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=20 rows.
- **typed** (cast, executed)
  - inputs: `measurements`
  - result: 20 rows × 2 columns
  - columns: id str, value int64
  - flow: "value" conversion failures=2/20 rows (errors=null).
  - flow: "value" failed-value examples (not exhaustive): "1.5" × 1; "2.5" × 1; other failures=0.
  - flow: "value" nulls before=0/20, after=2/20, delta=2; row-preserving contract, not a claim of cellwise equivalence.
```

Execution succeeded, but the flow measurement reveals that two valid
fractional measurements became missing. Preserve them with a floating-point
cast, then retrieve the repaired result and check the cast's reported failures:

```json
{
  "reasoning": "Preserve valid fractional measurements with a floating-point cast.",
  "actions": [
    {"type": "edit", "changes": "typed = cast(measurements, value=float64, errors=\"raise\")"},
    {"type": "execute", "operator_ids": ["typed"]},
    {"type": "retrieve", "operator_id": "typed", "view": "sample_stats"}
  ]
}
```

### Example: use join flow statistics to check population coverage

Request: include all orders in a regional budget analysis. `compared` is an
inner join of `budget_orders` and `budgets`. Its block in the execute receipt
reads:

```text
- **compared** (join, executed)
  - inputs: left `budget_orders`, right `budgets`
  - result: 9 rows × 4 columns
  - columns: order int64, region str, amount int64, budget int64
  - flow: Join matched contribution=9 (sum L(k)*R(k)); output=9, including outer unmatched rows as declared.
  - flow: left matched rows=9/12, unmatched rows=3; matched keys=4/6, unmatched keys=2; null-key rows=0, max eligible multiplicity=3.
  - flow: right matched rows=4/4, unmatched rows=0; matched keys=4/4, unmatched keys=0; null-key rows=0, max eligible multiplicity=1.
  - flow: left eligible unmatched-key examples (not exhaustive): ["EAST"] × 2; ["WEST"] × 1.
  - flow: left duplicate-key examples (not exhaustive): ["east"] × 3; ["west"] × 2; ["north"] × 2.
```

The returned rows alone may look reasonable, but the flow measurement reveals
that the join excluded three of the twelve orders. Their keys, `EAST` and
`WEST`, differ from the matched `east` and `west` only in case. Normalize the
keys before the join, restate the join on the normalized orders and recompute:

```json
{
  "reasoning": "Normalize region keys so every order finds its budget.",
  "actions": [
    {"type": "edit", "changes": "normalized = map(budget_orders, lambda row: {**row, \"region\": row[\"region\"].lower() if row[\"region\"] is not None else None}, doc=\"Orders with lower-case region keys\")\ncompared = join(normalized, budgets, on=\"region\", how=\"inner\")"},
    {"type": "execute", "operator_ids": ["compared"]},
    {"type": "retrieve", "operator_id": "compared", "view": "sample_stats"}
  ]
}
```

When the cause is less clear, read the key values and definitions on both
sides before changing anything. Change the join type only when its semantics
fit the request. If exclusions are intentional, establish that from the
request before accepting the reduced population.
