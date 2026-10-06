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

Answering saves the graph's definitions, connections and matching completed
results at that task boundary. `scores` means the current operator;
`scores@2` means the definition and exact result saved at the end of task 2.
A saved result is immutable and cannot be edited. A local definition unchanged
since task 2 may have a different result if an input changed.

Earlier tasks may appear as sealed entries under # Prior Tasks, or in their
ordinary ReAct history. Entries show each task's created or modified operators
in first-edit order with final definitions, direct inputs, output shape and
columns; deletions are separate. An answer source marker records the table
declared by the agent, not a correctness guarantee. All working tables are
included, even when outside that task's answer computation. Process bodies
are available on demand. Statistics and catalog records are off by default;
when enabled they describe the saved output with their stated coverage.

Use `read` with `operator_ids: ["scores@2"]`. With `view: null` it returns
definitions and direct inputs without data, including failed or unexecuted
operators. Set `include_implementation: true` to inspect local Python.
A non-null view (full, sample, or sample_stats when available) reads matching
completed records. Use columns to request needed fields; null keeps all.
Reads never execute. Several addresses may be read together.

A saved table can directly feed a new computation:
`create edge scores@2.out -> comparison.in[0]`.
The engine binds its original materialization, with no ancestor copies or
upstream execution. If that materialization is unavailable, the action fails
with HISTORICAL_RESULT_UNAVAILABLE. It never substitutes a newer table or
reruns the old definition on today's files. Definitions remain inspectable.
Historical addresses are sources, not editable targets or execution targets.

Choose the operation that fits the request:
- **An earlier table.** Read scores@2, answer from it, or use it as an input.
  The default graph's rules do not change.
- **An old rule on current inputs for following tasks.**
  `update operator scores from scores@2` restores only the definition.
  Existing input connections remain current; the receipt names drift.
  Execute the affected operators to compute the revised default.
- **An editable alternative from earlier work.**
  `create operator variant from scores@2` copies that operator's definition
  with saved direct inputs. It creates one editable operator; ancestors are
  referenced as old results. Adjust the variant or explicitly rewire its
  inputs to current tables, execute it and answer from it. Default operators
  stay untouched. No new names for copied ancestors are needed.

Before using earlier work, inspect the rule and table coverage. A saved answer's
top-five selection is different from the full table it was selected from.
Use the earlier report when its membership is requested, and the complete
working table when all qualifying entities are needed. Saved states may contain
earlier mistakes; identify and correct the relevant rule on a separate branch
rather than trusting the old answer.

`diff(key=["entity"], columns=["score"])` compares two tables, earlier on
in[0] and comparison on in[1]. Entity keys must be explicit, unique and non-null.
Output contains status (added, removed, changed; same with include_same=True)
and each column's _left, _right, _delta and _abs_delta. Numeric deltas are
right minus left; missing values and non-numeric differences have null deltas.

Answer from the full working table with an optional cut:
`scores[entity, score:3] top 5 by score desc, entity asc`.
Ordering uses unrounded values. Specify the tie-breaking columns explicitly;
an ambiguous tie at the selection boundary is refused. A complete table is
required; above the pagination ceiling, sort and limit in the graph.
The answer records the full source and its selection separately.

Free-text content answers require operator_ids naming their completed source
tables, current or historical. Pass [] only when no table was used. Missing
sources are rejected, and exploratory reads do not become answer roots.
