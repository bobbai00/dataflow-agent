<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# `edit`

Applies graph commands atomically; never executes. Building blocks and
settings: [README.md](README.md).

The receipt lists one operator block per operator the edit touched, in the
order inputs before consumers, then one edge line per edge change. Definitions
are left out, because the call directly above holds them; a restore is the
exception. The summary line counts the changes and names the results the edit
invalidated.

## Each command

`create operator`:

```
### 1. edit: ok
3 changes applied.
- **selected** (project, created)
  - inputs: orders
- created edge: orders.out -> selected.in
- created edge: selected.out -> totals.in
```

A created operator whose input is still unconnected says so in its block, and
the summary repeats it, since execution will refuse it:

```
- **selected** (project, created)
  - inputs: in unconnected
```

`update operator` keeps the operator's edges; the receipt names what must be
recomputed:

```
### 1. edit: ok
1 change applied; results invalidated: totals, over_budget.
- **totals** (aggregate, updated)
  - inputs: selected
```

`delete operator` removes the operator's edges with it; each removed edge is
listed:

```
### 1. edit: ok
2 changes applied; results invalidated: totals.
- **selected** (project, deleted)
- deleted edge: orders.out -> selected.in
- deleted edge: selected.out -> totals.in
- created edge: orders.out -> totals.in
```

`create edge` and `delete edge` alone change an operator's inputs, so the
operator appears as `reconnected`:

```
### 1. edit: ok
2 changes applied; results invalidated: totals.
- **totals** (aggregate, reconnected)
  - inputs: orders
- deleted edge: selected.out -> totals.in
- created edge: orders.out -> totals.in
```

`update operator <id> from task <N>` (`stateHistory` only) shows the restored
definition, since the call does not hold it, and the inputs that changed since
task N:

```
### 1. edit: ok
1 change applied; results invalidated: report.
- **score** (map, restored from task 2)
  - definition: `map(lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")`
  - inputs: joined
  - note: its inputs are today's; changed since task 2: eligible.
```

`fork operator <id> from task <N> as <new_id>` copies the version and its
task-N inputs under new names:

```
### 1. edit: ok
2 changes applied.
- **score_t3__joined** (join, forked from task 3)
  - definition: `join(on="k", how="inner")`
  - inputs: left eligible, right top8
- **score_t3** (map, forked from task 3)
  - definition: `map(lambda row: {**row, "score": row["k"] * 3}, doc="Tripled k")`
  - inputs: score_t3__joined
  - result: 70 rows × 3 columns (saved by task 3; retrieve it, or execute after changing it)
```

## Inputs from earlier tasks (`stateLedger`)

When the edit wires a table that predates the current task into a new or
updated operator, the receipt adds one block per such table, after the
changes:

```
inputs from earlier tasks:
- **titles** (scan, loaded)
  - result: 8,807 rows × 21 columns
  - columns: show_id str, type str, title str, director str, … +17 more
  - used by: fractional_title_join
- **eligible** (filter, task 1)
  - definition: `filter(lambda row: row["k"] > 0, doc="Units with positive k")`
  - inputs: units
  - result: 70 rows × 2 columns
  - columns: k int64, value str
  - used by: joined
```

## A rejected edit

An edit applies nothing when any command fails. The receipt names the command
by its position and line, and the cause:

```
### 1. edit: error
No changes were applied.
- error EDIT_REJECTED: change 3 (line 3) `create edge selected.out -> totals.in`: input `totals.in` is occupied by `orders.out`; delete that edge first.
```

```
### 1. edit: error
No changes were applied.
- error INVALID_ARGUMENTS: change 2 (line 2) `create operator totals: aggregate(by=["region"], total=sum)`: `sum()` needs the column to reduce: total=sum("col").
  - fix: Fix the named argument to match the signature; nothing about the data has been checked yet.
```

```
### 1. edit: error
No changes were applied.
- error PYTHON_SYNTAX: change 4 (line 6) `create operator scored: map(…)`: invalid syntax.
  - at: line 2 `return {**row, "score": row["k"] *}`
```

The causes are the parser's (a malformed command or expression), the
catalog's (an argument that does not fit the signature), the graph's (an
unknown operator, an unknown or occupied port, a cycle, an existing or missing
identifier) and Python validation of attached functions.
