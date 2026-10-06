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

The dataflow persists across tasks. Each request is a task, numbered from 1.
Keep the table that holds every unit under the current rules apart from the
table that reports a selection of it: compute all relevant entities and their
values, then rank and cut in the answer (`from: "scores top 5 by score desc"`)
or in a downstream operator, never inside the operator that computes the
scores. A later task that needs all units, or a different cut, then has them;
a process that returns a selection hides the rest. A table inside a process
function is not an operator output; return the working table so a later
request can inspect, reuse or revise it. Load supported files with scan
operators. Discover unfamiliar file contents with a preview before parsing;
a filename alone does not establish its contents or relevance.

At each request, decide whether it changes the default rule from here on,
asks for an alternative for this question only, or refers to an earlier
state. Preserve applicable units, exclusions, ordering and rounding. Earlier
answers, descriptions and dependency links are unverified evidence; check the
relevant definition, inputs and result before reuse. Row counts alone do not
establish which entities a table contains.

When a rule changes for following tasks, update the operator that defines it.
Consumers are invalidated and recompute on the next execute. Give reusable
rules clear operator boundaries and name them the way requests will refer to
them: an operator's `doc` is how a later task recognizes a rule, so write it
as the rule it implements ("markets with at least ten cleaned orders"), not
as a step ("filter rows"). Connect working tables instead of retyping rules
in a new function. An alternative for one question stays on a separate branch
unless the request adopts it; the next request continues from the default.
{{#history}}
Answering saves every completed table under the task's number. Use those
addresses rather than copying whole upstream graphs or reconstructing old
numbers.
{{/history}}
{{^history}}
Earlier versions are not retained. Preserve an independent branch when both
the old and new computations will be needed.
{{/history}}

A process should implement one coherent transformation, with a concise doc that
accurately describes its output grain, formula, exclusions and null handling.
Related helpers for one algorithm may stay together.
