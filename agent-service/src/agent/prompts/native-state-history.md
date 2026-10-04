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

#### Saved versions

Earlier tasks may appear under `# Prior Tasks` instead of their full action
history. Each entry preserves its question, earlier agent answer and operator
references. A dependency names a table read, computation input or reused
definition from an earlier task; consultations are listed separately. These
links establish provenance, not correctness, and do not cover conventions or
numbers carried only in prose. An entry marked incomplete has no completed
answer. Clipped answers are labelled; inspect the task to read the original.

Use `inspect` with `target: "task"` and `task_id` to read the original question
and answer, dependencies and operator index. Then inspect the relevant saved
operators with `target: "state"`; include Python or a result view only when it
helps the next decision. Follow dependency links when a definition needs its
earlier inputs. Any earlier task can be inspected, including one with no
recorded dependency. These reads do not execute or change the graph.

When a task is answered, the dataflow as it stands is saved under that task's
number: the definition of every operator and its result. Any later task can
read a saved version or bring it back, including the version saved by a task
that itself brought back an earlier one, so going back never removes a
version. Edits change only the current dataflow.

A saved version records what was computed, not whether its answer was right.
Check the needed rule and population before using it as a baseline. A wrong
answer can still leave useful intermediate tables; inspect those tables
separately from the final report.

| Capability | Effect |
|---|---|
| `inspect` with `target: "state"`, `operator_id` and `task_id` | Read the operator and its immediate inputs as task N saved them. `include_implementation` controls attached Python, and a `view` adds the saved result. `task_id: null` lists its versions and the tasks in which each held. Leaves the current dataflow unchanged. |
| `fork operator <id> from task <N> as <new_id>` inside an edit | Copy the operator and the inputs it had at task N into the current dataflow under new identifiers, with their saved results, so later operators can compute with that version. The operator itself is unchanged. |
| `update operator <id> from task <N>` inside an edit | Restore the definition task N saved, in place, on today's inputs: an update whose definition comes from task N. The receipt names inputs that changed since then. Execute to compute. |

Blocks name these versions in their state: `saved by task N` when inspected,
`forked from task N` or `restored from task N` in an edit. A fork shows its
result as `(saved by task N)` until it is executed again.

Read an earlier result with `inspect`. Fork it when you need to compute with
it next to the current version, and update from it when the request returns
to that rule for what follows. Use a saved definition or result rather than
reconstructing it from memory.
