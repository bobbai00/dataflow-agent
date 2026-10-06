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

When you answer, the dataflow as it stands is saved under that task's number:
every operator with a completed result becomes a version you can refer to
later as `operator@N`. The receipt of your answer lists what was saved.
Saved definitions and results never change; task 9 can return to task 3, and
task 12 can return to task 9. A saved result can become unavailable after
cleanup or eviction: the action then fails with HISTORICAL_RESULT_UNAVAILABLE.
The engine never substitutes a newer table and never reruns the old
definition on today's files.

`scores` names the current operator. `scores@2` names the version saved at
the end of task 2: its definition, its inputs as they were then, and its
matching completed result. A local definition unchanged since task 2 may
still have a different result today if an input changed. A version can be
read, connected as an input, answered from, diffed, or made current again.
It cannot be edited or executed. Using a version never executes anything by
itself and never changes the current graph.

Earlier tasks appear either as sealed entries under # Prior Tasks or in full
above, each ending with the receipt that lists what it saved. Entries show the
operators a task created or modified in first-edit order with their final
definitions, direct inputs, output shape and columns; deletions are separate.
All working tables are included, even those outside that task's answer
computation. An answer source marker records the table the agent declared,
not a correctness guarantee. Process bodies are available on demand.
Statistics and catalog records are off by default; when enabled they describe
the saved output with their stated coverage. Saved states may contain earlier
mistakes, and earlier answers are the earlier agent's output: read a
definition before relying on it.

Read a version with `read`, `operator_ids: ["scores@2"]`. With `view: null`
(view=null) it returns definitions and direct inputs without data, including
failed or unexecuted operators; `include_implementation: true` adds local
Python. A non-null view (full, sample, or sample_stats when available) reads
the saved records; `columns` narrows them and null keeps all. Several
addresses may be read together. Reads never execute.

A session revises its rules as it goes. Read each request for which of three
things it asks, and spell each the same way every time.

- **A rule changes from here on.** `update operator scores: <definition>`.
  Everything built on `scores` recomputes on the next execute, so later tasks
  read the revised rule without further work. The old version stays saved.
  Do not build a second copy beside it.
- **An alternative applies to this question only.** Build the variant beside
  the current operator, from the current or saved inputs it needs, and answer
  from the variant. `create operator variant from scores@2` copies that
  definition with its saved direct inputs as one editable operator; adjust it
  or rewire its inputs, execute it and answer from it. The default operators
  stay untouched; the next task continues from them.
- **The request names an earlier version** ("the strict screen", "the
  first-pass scores", "before the penalty"). Find the task that introduced
  that rule among the earlier tasks, then use the version directly: read
  `scores@2`, connect `scores@2.out` as an input, answer from it, or diff it
  against the current table. When the session returns to that rule for what
  follows, `update operator scores from scores@2`: the task-2 definition
  becomes current on current inputs, the receipt names inputs that changed
  since then, and the affected operators recompute on the next execute.

Never retype an earlier rule or its numbers from memory; the saved version is
one reference away. Before connecting an earlier table, read its definition
and shape: is it every qualifying row, an earlier answer's selection, or an
older version of the rule? When the request concerns the reported selection,
keep it; when it concerns every row, connect the table before the cut. When
an earlier task was wrong, correct the relevant rule rather than trusting the
old answer.

`diff(key=["entity"], columns=["score"])` compares two tables, the earlier
version on in[0] and the current table on in[1]. Entity keys must be explicit,
unique and non-null; compare value columns separately from keys. Each output
row carries status (added, removed, changed; same with include_same=True) and
each column's _left, _right, _delta and _abs_delta. Deltas are right minus
left; missing values and non-numeric differences have null deltas.

Answer from the full working table with an optional cut:
`scores[entity, score:3] top 5 by score desc, entity asc`.
Ordering uses unrounded values. Specify the tie-breaking columns explicitly;
an ambiguous tie at the cut is refused. The complete table is required; above
the pagination ceiling, sort and limit in the graph. The answer records the
full source and its selection separately.

Free-text content answers require operator_ids naming their completed source
tables, current or historical. Pass [] only when no table was used. Missing
sources are rejected, and exploratory reads do not become answer roots.
