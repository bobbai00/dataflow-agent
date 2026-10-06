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

### Example: default rules, a temporary branch and an earlier result

This example uses generic orders (unit, amount, delivered), not benchmark
answers. Each call supplies a brief reasoning sentence. Edits never execute.

Task 1 creates a complete per-unit table:
```dataflow
create operator orders: scan("data/orders.csv")
create operator eligible: filter(lambda row: row["delivered"] == True, doc="Delivered orders with their original units and amounts")
create operator scores: aggregate(by=["unit"], amount=sum("amount"))
create edge orders.out -> eligible.in
create edge eligible.out -> scores.in
```
Compute the named table and inspect its records before answering:
```json
{"reasoning":"Compute complete unit scores and check their values.","actions":[{"type":"execute","operator_ids":["scores"]},{"type":"read","operator_ids":["scores"],"view":"full","columns":["unit","amount"],"include_implementation":false}]}
```
```json
{"reasoning":"Report three leaders while retaining the full score table.","actions":[{"type":"answer","from":"scores[unit, amount:2] top 3 by amount desc, unit asc"}]}
```
The answer boundary saves scores@1, including every eligible unit, and records
the selection. Later tasks can read its definition with
a definitions-only read:
```json
{"reasoning":"Check the saved rule and its inputs before reusing it.","actions":[{"type":"read","operator_ids":["scores@1","eligible@1"],"view":null,"columns":null,"include_implementation":false}]}
```

Task 2 permanently changes which orders count:
```dataflow
update operator eligible: filter(lambda row: row["amount"] > 0, doc="All positive-amount orders, regardless of delivery status")
```
The receipt reports scores invalidated. Execute scores and answer from it.
scores@2 is the revised default; scores@1 still names the first result.

Task 3 asks for the earlier delivery rule with a changed score, for this
question only:
```dataflow
create operator variant from scores@1
update operator variant: aggregate(by=["unit"], amount=mean("amount"))
```
variant keeps eligible@1 as its input. Read that definition or its records
before relying on it. Execute variant and answer from
"variant[unit, amount:2] top 3 by amount desc, unit asc".
scores is still the task-2 default. The temporary mean does not leak into it.

Task 4 compares the original result with the current default:
```dataflow
create operator shift: diff(key=["unit"], columns=["amount"])
create edge scores@1.out -> shift.in[0]
create edge scores.out -> shift.in[1]
```
```json
{"reasoning":"Compare the exact first result with the current default.","actions":[{"type":"execute","operator_ids":["shift"]},{"type":"read","operator_ids":["scores@1","scores","shift"],"view":"sample_stats","columns":null,"include_implementation":false}]}
```
Only the comparison and any stale current computations run;
the old scores are read from their exact saved result. Read shift with a
non-null view to inspect changed values. Answer from
"shift[unit, amount_left:2, amount_right:2, amount_abs_delta:2] top 2 by amount_abs_delta desc, unit asc".
The answer sources include both versions through shift's input lineage.

Task 5 adopts the original delivery rule again:
```dataflow
update operator eligible from eligible@1
```
This changes the current rule while retaining today's orders input.
Execute scores to recompute. If today's orders changed, this answer can differ
from scores@1: the old rule on current data is different from the old result.
To return the exact original values instead, answer from scores@1.
