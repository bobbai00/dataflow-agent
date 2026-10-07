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
later as `name@N`, together with the shared functions its definition calls.
Saved definitions and results never change; task 9 can return to task 3, and
task 12 to task 9. A saved result can become unavailable after cleanup or
eviction: the action then fails with HISTORICAL_RESULT_UNAVAILABLE. The
engine never substitutes a newer table and never reruns the old definition on
today's files.

`scores` names the current operator. `scores@2` names the version saved at
the end of task 2: its definition, its inputs as they were then, and its
matching completed result. A version can be read, used as an input, answered
from, compared, restored or copied, but not edited or executed. Using a
version never executes anything by itself and never changes the current
graph.

Earlier tasks appear either as sealed entries under # Prior Tasks or in full
above, each ending with its answer receipt. Entries show the
operators a task created or modified in first-edit order with their final
definitions, direct inputs, output shape and columns; deletions are separate.
All working tables are included, even those outside that task's answer
computation. An answer source marker records the table the agent declared,
not a correctness guarantee. Function bodies are available on demand.
Statistics and catalog records are off by default; when enabled they describe
the saved output with their stated coverage. Saved states may contain earlier
mistakes, and earlier answers are the earlier agent's output: read a
definition before relying on it.

What you can do with a version:

- **Read it.** `read` with `operator_ids: ["scores@2"]`. With `view: null`
  (view=null) it returns the definition and direct inputs without data,
  including failed or unexecuted operators; `include_implementation: true`
  adds the Python. A non-null view reads the saved records, and `columns`
  narrows them. Several addresses may be read together. Reads never execute.
- **Use it as an input.** Any call takes `name@N` in place of an input table:
  `shift = diff(scores@2, scores, key=["unit"], columns=["score"])`. The
  engine binds the original materialization, with no ancestor copies or
  upstream execution. A version never follows later changes, so build on
  current tables by their current names and use `name@N` only when the
  request needs that earlier table.
- **Answer from it.** `answer` with `from: "scores@2[unit, score:2]"`.
- **Make it current again.** `scores = scores@2` restores the definition
  saved at the end of task 2 in place, on today's inputs; the receipt names
  inputs that changed since then, and the affected operators recompute on
  the next execute. If the shared function it calls changed since task 2,
  the restored operator keeps the task-2 code under the name
  `function_t2`, while the function keeps its current definition.
- **Copy it.** `copy = scores@2` creates one editable operator from the
  task-2 definition with its saved direct inputs; adjust it or its inputs.

An in-place change keeps the earlier version. After `scores.minimum = 3` and
an execute, `scores@1` still names the first result, and the execute receipt
compares each recomputed table with the version the last task saved, for
example
`changed since top3@1: 3 → 3 rows; entered (1): east; left (1): west; 2 kept with new values (rows matched on unit).`
That line often answers what a change did; read the tables when the request
needs their values.

Never retype an earlier rule or its numbers from memory; the saved version is
one reference away. Before using an earlier table, read its definition and
shape: is it every qualifying row, an earlier answer's selection, or an older
version of the rule? When the request concerns the reported selection, keep
it; when it concerns every row, use the table before the cut. When an earlier
task was wrong, correct the rule in place rather than trusting the old answer.

`rank_change(scores@2, scores, key=["entity"], by=[("score", "desc")], n=5)`
compares two versions of a ranking: every entity in either top five, marked
entered, left or stayed, with its rank and score in both.

`diff(earlier, later, key=["entity"], columns=["score"])` compares two tables
row by row. Entity keys must be explicit, unique and non-null, and compared columns are
separate from keys. Each output row carries status (added, removed, changed;
same with include_same=True) and each column's _left, _right, _delta and
_abs_delta. Deltas are later minus earlier; missing values and non-numeric
differences have null deltas. Cut it like any table:
`largest = limit(shift, 5, by=[("score_abs_delta", "desc"), "unit"])`.

`answer` with `from` also takes a cut over a complete table:
`scores[unit, score:3] top 5 by score desc, unit asc`. Ordering uses
unrounded values. Specify the tie-breaking columns explicitly; an ambiguous
tie at the cut is refused. Above the pagination ceiling, cut in the graph
with `limit`. The answer records the full source and its selection
separately.

Free-text content answers require operator_ids naming their completed source
tables, current or historical. Pass [] only when no table was used. Missing
sources are rejected, and exploratory reads do not become answer roots.
