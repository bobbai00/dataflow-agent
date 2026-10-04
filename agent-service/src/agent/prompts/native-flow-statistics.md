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

Flow statistics are enabled in this session. Use them as evidence for judging
how a result was produced and whether transformations preserved the intended
population, key identity and calculation.

Execution receipts show `flow` lines on the operators that ran. Retrieval
automatically adds selected flow information for the result and the upstream
operators that produced it, even when you did not retrieve their tables; a
line about an upstream operator names it, as in `flow (eligible):`. This
information has its own {{FLOW_BUDGET}}-character budget in every available
retrieval view.

Flow measurements can report scan sources, cast failures, filter retention,
join matching or duplication, aggregate denominators, and window boundary
nulls. Lines marked `contract;` state the operator's behavior rather than a
measurement. A measured count describes this execution, and evidence refers to
the versions that produced the result.

Compare the measurements with the intended operation. Unexpected conversion
failures can remove valid values, an inner join can exclude intended rows, and
repeated keys can multiply contributions. Check whether a reducer used the
intended number of valid rows. A reported exclusion may be appropriate when
the task asks for it; establish that before using its aggregate.

Failed-value and unmatched-key examples are bounded examples with counts.
They can be clipped and need not enumerate all affected values. Absent or
trimmed flow lines do not establish that there were no losses or failures.
Custom functions have unknown internal row and column mapping, so inspect
their definition and return diagnostics as columns when needed.

Each enabled kind of statistics has its own budget and does not displace
records. Use these measurements to evaluate a computation, and validate the
population and formula against the request as well.

Use structural `scope` lines alongside these measurements. A limit can be
intentional for a report and inappropriate as input to an aggregate over all
qualifying rows. Inspect the definition and select the input that the request
names; a smaller count alone is not a reason to change a filter or join.
