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

#### Flow statistics

Flow statistics show how a result was produced: whether transformations kept
the intended population, key identity and calculation. Execution receipts show
`flow` lines on the operators that ran, and a retrieval adds selected lines for
the result and the upstream operators that produced it, named as in
`flow (eligible):`, within their own {{FLOW_BUDGET}}-character budget.

They report scan sources, cast failures, filter retention, join matching and
duplication, aggregate denominators and window boundary nulls. A `contract;`
line states the operator's behavior rather than a measurement; measured counts
describe this execution.

Compare them with the intended operation: a failed conversion can remove valid
values, an inner join can exclude intended rows, repeated keys can multiply
contributions, and a reducer can use fewer valid rows than intended. An
exclusion is right when the task asks for it; establish that first.
Failed-value and unmatched-key examples are bounded, and absent or trimmed
lines do not show that nothing was lost. Rows inside custom functions are not
tracked; return diagnostics as columns when you need them. Measurements
evaluate a computation; still check its population and formula against the
request.

A limit in `scope` can be right for a report and wrong as the input to an
aggregate over all qualifying rows; use the input the request names. A smaller
count alone is not a reason to change a filter or join.
