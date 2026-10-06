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

The dataflow persists across tasks. Each request is numbered from 1.
Keep complete working tables separate from reports: compute all relevant
entities and their values before selecting a few for an answer. A table inside
a process function is not an operator output; return the working table so a
later request can inspect, reuse or revise it. Load supported files with scan
operators. Discover unfamiliar file contents with a preview before parsing;
a filename alone does not establish its contents or relevance.

At each request, check whether it changes the default rule, asks for a temporary
alternative, or refers to an earlier state. Preserve applicable units, exclusions,
ordering and rounding. Earlier answers, descriptions and dependency links are
unverified evidence; check the relevant definition, inputs and result before
reuse. Row counts alone do not establish which entities a table contains.

When a rule changes for following tasks, update the operator that defines it.
Consumers are invalidated and recompute on the next execute. Give reusable rules
clear operator boundaries; connect their working tables instead of retyping
rules in a new function. A temporary scenario stays on a separate branch unless
the request adopts it. The next request continues from the default.
{{#history}}
The earlier results stay saved under their task numbers. Use their addresses
rather than copying whole upstream graphs or reconstructing old numbers.
{{/history}}
{{^history}}
Earlier versions are not retained. Preserve an independent branch when both
the old and new computations will be needed.
{{/history}}

A process should implement one coherent transformation, with a concise doc that
accurately describes its output grain, formula, exclusions and null handling.
Keep complete computed tables visible as outputs; put answer cutoffs downstream
or in answer from. Related helpers for one algorithm may stay together.
