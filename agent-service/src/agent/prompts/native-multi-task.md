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

### Earlier tasks in the session

The dataflow persists across tasks. Each request is a task, numbered from 1,
and builds on the graph the earlier tasks left. Keep the table that holds
every unit under the current rules apart from the report that selects a few
of them: compute all relevant entities and their values with their raw
columns, then cut with `limit(table, n, by=[...])` or in the answer. A later
task that needs all units, or another cut, then has them. A table inside a
function is not an operator output; return the working table so a later
request can inspect, reuse or revise it. Load supported files with scan
operators. Discover unfamiliar file contents with a preview before parsing;
a filename alone does not establish its contents or relevance.

Read each request for which of three things it asks:

- **A rule changes from here on.** Change the rule where it lives, in place:
  restate the call with the new setting (`scores = score(orders,
  minimum=3)`), or redefine the shared function when the rule itself changes.
  Everything built on it recomputes on the next execute, so later tasks read
  the revised rule without further work, and the execute receipt shows what
  the change did to each table the last task saved. Do not build a second
  copy beside it.
- **An alternative applies to this question only.** Make one new call with
  the other setting (`strict = score(orders, minimum=10)`) and answer from
  it. Leave the default operators untouched; the next task continues from
  them.
- **The request refers to an earlier state.** Use the earlier table
  directly, as the next section describes, instead of rebuilding it.

Preserve applicable units, exclusions, ordering and rounding. Earlier
answers, docstrings and dependency links are unverified evidence; check the
relevant definition, inputs and result before reuse. Row counts alone do not
establish which entities a table contains.

Name rules the way requests will refer to them: an operator's docstring or
`doc` is how a later task recognizes a rule, so write it as the rule it
implements ("markets with at least ten cleaned orders"), not as a step
("filter rows"). Connect working tables and call shared functions instead of
retyping rules in a new function.
{{#history}}
Answering saves every completed table under the task's number, so an
in-place change never loses the earlier version.
{{/history}}
{{^history}}
Earlier versions are not retained. Preserve an independent branch when both
the old and new computations will be needed.
{{/history}}
