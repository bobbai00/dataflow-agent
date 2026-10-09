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

When you answer, every operator with a completed result is saved under the
task's number, with the shared functions it calls, so an in-place change never
loses an earlier version. `scores` names the current operator; `scores@2`
names the version saved at the end of task 2: its definition, its inputs as
they were then, and its matching completed result. Saved definitions and
results never change, and using a version never executes anything or changes
the current graph. If a saved result has been evicted, the action fails with
HISTORICAL_RESULT_UNAVAILABLE; the engine never substitutes a newer table and
never reruns an old definition on today's files.

A version can be:

- **read**: `read` with `operator_ids: ["scores@2"]` and `view: null` returns
  its definition and direct inputs without data, for failed or unexecuted
  operators too; `include_implementation: true` adds the Python, and another
  view reads the saved records.
- **used as an input**: `shift = diff(scores@2, scores, key=["unit"],
  columns=["score"])` binds the saved result itself, with no upstream
  execution, and `rank_change(scores@2, scores, ...)` compares a saved
  ranking with today's. A version never follows later changes, so build on
  current tables by their current names and use `name@N` only when the
  request needs that earlier table.
- **answered from**: `"from": "scores@2[unit, score:2]"`.

An execute receipt line such as
`changed since top3@1: 3 → 3 rows; entered (1): east; left (1): west; 2 kept with new values (rows matched on unit).`
often answers what an in-place change did; read the tables when the request
needs their values. Never retype an earlier rule or its numbers from memory;
the saved version is one reference away.

Earlier tasks appear under # Prior Tasks as sealed entries, or in full in
sessions that keep every call. An entry lists, in first-edit order, every
operator the task created or changed, with its final definition, direct
inputs, shape and columns, then its deletions and its answer.
All working tables are included, not only those its answer used. Columns are
listed where a chain starts, and a later step gives only how its columns
differ from its first input's, as in ``same as `scores`; plus rank int64``. An
operator's state names what the task did to it, such as
`updated: set min_orders 5 to 10`; use these to find the table a request means
and the task an earlier state refers to.
Function bodies are left out; read them on demand. The answer source marker
records the table the agent declared, not a correctness guarantee.
Saved states may contain earlier mistakes.
