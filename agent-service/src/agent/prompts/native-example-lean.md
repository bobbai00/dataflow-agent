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

### Working examples

When you know the input columns, batch the graph changes and execution:

```json
{"reasoning":"Compute total spending by region.","actions":[{"type":"edit","changes":"create operator purchases: scan(\"data/purchases.csv\")\ncreate operator totals: aggregate(by=[\"region\"], total=sum(\"amount\"))\ncreate edge purchases.out -> totals.in"},{"type":"execute","operator_ids":["totals"]},{"type":"retrieve","operator_id":"totals","view":"sample_stats"}]}
```

Read the result before deciding whether to repair the calculation or answer.
For a complete, small answer table, `{"type":"answer","from":"totals[region=region,total=total:2]"}`
formats the computed values and records the source. A capped sample does not
establish every region's total or the ordering of all rows.

{{#data}}
For a requested mean among eligible records, check the filtered table's row
count and the measured column's non-null count. Null values can make those
denominators differ. A limit used for a display should not become the input to
that mean. Statistics describe the inspected version and coverage; verify
filters and definitions as well as counts before trusting the calculation.
{{/data}}

{{#flow}}
If flow evidence shows a join multiplying rows, inspect the key coverage and
uniqueness before summing values. Expansion may be intended; the metadata
alone cannot decide whether the resulting unit of analysis matches the request.
{{/flow}}

{{#history}}
Suppose task 1 computed totals for all records and a later task asks for the
same calculation among eligible records. Retrieve the earlier calculation:

```json
{"reasoning":"Check the earlier calculation's definition and inputs.","actions":[{"type":"inspect","target":"task","task_id":1,"operator_id":null,"include_implementation":true,"view":"sample_stats"}]}
```

Check whether its saved filters, denominator and output match the new request.
Reuse a matching result; otherwise fork its version, adjust the necessary
branch and execute that branch. Expand individual saved input references when
their definitions matter. The dependency index points to possible reuse and
does not certify the previous answer. A fork already preserves its incoming
edges: delete an existing edge before replacing it. Prefer one inspection that
returns the relevant implementation and result over repeated broader reads.
{{/history}}

Additional worked examples are available through
`{"type":"inspect","target":"reference","topic":"example","example":"single"}`;
choose `statistics` or `history` when those session features are enabled.
Operator-specific contracts use
`{"type":"inspect","target":"reference","topic":"operators","operator_names":["join","process"]}`.
