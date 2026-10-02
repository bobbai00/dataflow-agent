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

# `execute`

Computes the graph, or a selection and its ancestors, reusing valid cached
results; returns status, not tables. Building blocks and settings:
[README.md](README.md).

The summary line counts the operators in scope by state. Only operators with
something to report get a block: a failure, a note, a check or (with
`flowEvidence`) a flow line. Operators that did not run are grouped by cause on
`not run` lines.

## Everything ran

```
### 2. execute: ok
5 operators: 3 executed, 2 cached.
```

With notes:

```
### 2. execute: ok
23 operators: 9 executed, 14 cached.
- **fractional_top_report** (project, executed)
  - result: 5 rows × 3 columns
  - note: input `fractional_top_five` is a top-5 table; its unlimited parent `fractional_ranked` has 15 rows.
- **fractional_with_trends** (join, executed)
  - result: 15 rows × 30 columns
  - flow: inner join of 107 left and 15 right rows produced 15 rows; 92 left rows found no match.
- **flag_rates** (aggregate, executed)
  - result: 84 rows × 4 columns
  - note: boolean column slow_relative reduced as 1/0.
```

Notes depend on settings: `stateLedger` adds the state notes (empty or top-k
inputs, current pools, retyped literals), `nativeChecks` adds `check` lines,
`flowEvidence` adds `flow` lines; the runtime's own adjustments (a replaced
column, a renamed join column, booleans as 1/0) are always reported.

## A selection

`{"type": "execute", "operator_ids": ["kept_orders"]}` runs the selection and
its ancestors; the summary says so:

```
### 3. execute kept_orders: ok
4 operators in scope: 2 executed, 2 cached.
```

## Failures

A failed operator gets its error; the operators it blocked are grouped:

```
### 2. execute: error
23 operators: 9 executed, 13 cached, 1 failed.
- **fractional_genre_period** (filter, failed)
  - error MISSING_COLUMN: the function reads `added_year`, which input `fractional_genre_titles` does not have (its columns: show_id, country, credit, index, genre).
    - at: line 2 `return row["added_year"] is not None and row["added_year"] >= 2010 and …`
    - fix: read an existing column, or bring `added_year` in upstream.
- not run: fractional_country_genres, fractional_country_genres_distinct, fractional_genre_counts (upstream `fractional_genre_period` failed)
- not run: fractional_period, fractional_measures (the run stopped when `fractional_genre_period` failed; they do not read from it)
```

The engine returned nothing, or the run timed out:

```
### 2. execute: error
- error EXECUTION_TIMEOUT: the run exceeded 240 seconds; no results were returned.
- not run: spending, compared, over_budget
```

## Refused before running

Each of these leaves every result unchanged:

```
### 2. execute: error
- error UNKNOWN_TARGET: no operator `kept`. No execution was started.
```

```
### 2. execute: error
- error EMPTY_DATAFLOW: the dataflow has no operators. Create one before executing.
```

```
### 2. execute: error
- error UNCONNECTED_INPUTS: review.in has no edge. Connect it or delete `review` before executing.
```
