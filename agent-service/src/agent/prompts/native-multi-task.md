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

The dataflow and its current tables persist across tasks. Each request is a
task, numbered from 1. Answering completes that request; subsequent requests
can build on the graph that remains.

At the start of a task, identify which existing tables and definitions it
refers to. Preserve earlier conventions for population, units, ordering and
rounding when they still apply. Follow the current request when it revises a
convention. Earlier answers and definitions may contain mistakes; check the
relevant definition, inputs and result before using a table as a population,
lookup or baseline.

Extend the graph when the request adds an analysis. When the request revises
a rule for the rest of the session, update the operator that defines it rather
than building a second version beside it: every table built on it recomputes
on the next execute, so later tasks read the revised rule without any further
change.
{{#history}}
The version earlier tasks used stays saved (see "Saved versions" below). To
compare with what an earlier task reported, read its saved result or fork its
saved version instead of keeping a duplicate or retyping its numbers.
{{/history}}
{{^history}}
Earlier versions are not kept, so build a second operator only when the
request needs the old and the new rule at the same time.
{{/history}}
Keep a temporary scenario on its own branch unless the request adopts it. Use
an existing selection by connecting its table rather than retyping the members
from an earlier answer.

Operator blocks can name the task that defined an operator (`origin: task 1`)
and the operators that read its table (`used by`).
