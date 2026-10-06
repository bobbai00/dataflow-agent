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

### Example: a cast that silently loses values

`typed = cast(measurements, value=int64, errors="null")` executes, and its flow
lines read:

```text
  - flow: "value" conversion failures=2/20 rows (errors=null).
  - flow: "value" failed-value examples (not exhaustive): "1.5" × 1; "2.5" × 1; other failures=0.
```

Two valid fractional values became missing. Cast to a float instead, and check
the reported failures again before using the result:

```dataflow
typed = cast(measurements, value=float64, errors="raise")
```

### Example: a join that drops rows

`compared = join(budget_orders, budgets, on="region", how="inner")` executes,
and its flow lines read:

```text
  - flow: left matched rows=9/12, unmatched rows=3; matched keys=4/6, unmatched keys=2; null-key rows=0, max eligible multiplicity=3.
  - flow: left eligible unmatched-key examples (not exhaustive): ["EAST"] × 2; ["WEST"] × 1.
```

Three of the twelve orders found no budget: their keys differ from `east` and
`west` only in case. Normalize the keys and restate the join on the normalized
input:

```dataflow
normalized = map(budget_orders, lambda row: {**row, "region": row["region"].lower() if row["region"] is not None else None}, doc="Orders with lower-case region keys")
compared = join(normalized, budgets, on="region", how="inner")
```

When the cause is less clear, read the key values on both sides first, and
change the join type only when its semantics fit the request.
