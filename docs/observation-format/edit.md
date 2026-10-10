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

Applies assignments and deletions atomically; never executes. Building blocks
and settings: [README.md](README.md). The language itself is described in
[native-expression-mode.md](../archived/native-expression-mode.md#edit-statements).

The receipt lists one line per change: first the operators the edit created,
updated, left unchanged or deleted, in statement order, then every edge it
removed or created. A port is named only when the target has several (join,
union, multi-input process). Then come the results the edit invalidated, any
unconnected inputs, and notes. Definitions are left out, because the call
directly above holds them; restored and copied versions are the exception.

## Each statement

A new name creates the operator, and each input becomes an edge:

```
### 1. edit: ok
operator selected created (project)
operator totals created (aggregate)
edge orders -> selected created
edge selected -> totals created
```

An existing name replaces the definition; the receipt names what must be
recomputed. Unchanged inputs keep their edges and add no line:

```
### 1. edit: ok
operator totals updated (aggregate)
results invalidated: totals, over_budget
```

Restating an operator exactly as it stands changes nothing:

```
### 1. edit: ok
operator totals unchanged
```

Restating an operator with another input rewires it; with the same parameters
there is no operator line:

```
### 1. edit: ok
edge budgets -> compared.right removed
edge budgets_2024 -> compared.right created
results invalidated: compared, over_budget
```

`del` removes the operator and every incident edge. A consumer left without an
input is named, since execution will refuse it:

```
### 1. edit: ok
operator selected deleted
edge orders -> selected removed
edge selected -> totals removed
totals.in is unconnected; restate totals with its inputs or delete it before executing.
```

`x = at(x, task=N)` (`stateHistory` only) shows the restored definition, since
the call does not hold it, and the inputs that changed since task N:

```
### 1. edit: ok
- **score** (map, restored from task 2)
  - definition: `score = map(joined, lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")`
  - inputs: `joined`
  - result: stale (execute to recompute)
results invalidated: score, report
note: Restored score's task-2 definition in place; its inputs are today's (changed since task 2: eligible). Dependents are invalidated; execute to recompute.
```

`y = at(x, task=N)` copies the version and its task-N inputs under new names:

```
### 1. edit: ok
- **score_t3__joined** (join, forked from task 3)
  - definition: `score_t3__joined = join(eligible, top8, on="k", how="inner")`
  - inputs: left `eligible`, right `top8`
- **score_t3** (map, forked from task 3)
  - definition: `score_t3 = map(score_t3__joined, lambda row: {**row, "score": row["k"] * 3}, doc="Tripled k")`
  - inputs: `score_t3__joined`
  - result: 70 rows × 3 columns (saved by task 3)
note: Forked score from task 3 as score_t3 with its task-3 inputs (joined → score_t3__joined); retrieve score_t3 for the saved result, or execute it after changing it.
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
  - definition: `eligible = filter(units, lambda row: row["k"] > 0, doc="Units with positive k")`
  - inputs: `units`
  - result: 70 rows × 2 columns
  - columns: k int64, value str
  - used by: joined
```

## A rejected edit

An edit applies nothing when any statement fails. The receipt names the line
and the cause:

```
### 1. edit: error
No changes were applied.
- error EDIT_REJECTED: Line 2: totals's input `selectd` is not an operator. Operators: orders, selected. No changes were applied.
```

```
### 1. edit: error
No changes were applied.
- error EDIT_REJECTED: Line 1: selected cannot be its own input. Give the new table its own name, for example `selected_2 = filter(selected, ...)`. No changes were applied.
```

```
### 1. edit: error
No changes were applied.
- error EDIT_REJECTED: Line 2: Invalid aggregate arguments: … Signature: aggregate(T, by=[], name=reducer("col"), ...) No changes were applied.
```

The causes are the parser's (a statement that is not an assignment or `del`,
a Python syntax error, a reserved word as a name, an old graph command), the
catalog's (an argument or input count that does not fit the signature, a
nested operator call), the graph's (an unknown input, an operator as its own
input, a name assigned twice, a cycle, deleting an unknown operator) and
Python validation of attached functions.
