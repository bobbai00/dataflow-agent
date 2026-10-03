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

# `inspect`

Reads definitions and result shapes; never executes. Building blocks and
settings: [README.md](README.md).

Every receipt opens with `### <n>. inspect <target>: <status>` and a one-line
summary.

## The graph

`{"type": "inspect", "target": "graph"}` returns the operator index.

```
### 1. inspect graph: ok
6 operators; no unconnected inputs.
| operator | kind | inputs | result | task | columns |
|---|---|---|---|---|---|
| transactions | scan |  | 1,200 × 4 | 1 | id, region, amount, date |
| budgets | scan |  | 4 × 2 | 1 | region, budget |
| spending | aggregate | transactions | 4 × 2 | 1 | region, spent |
| compared | join | left spending, right budgets | 4 × 3 | 1 | region, spent, budget |
| over_budget | filter | compared | stale |  |  |
| review | project | over_budget | not run |  |  |
```

- An operator whose definition or input changed since its last execution shows
  `stale`; one never executed shows `not run`. Neither has columns.
- The `task` column is the task that last changed the operator, or `loaded`.

With unconnected inputs, the summary names them:

```
### 1. inspect graph: ok
6 operators; unconnected inputs: review.in.
```

An empty dataflow:

```
### 1. inspect graph: ok
The dataflow is empty.
```

## One operator

`{"type": "inspect", "target": "operator", "operator_id": "compared", "include_implementation": false}`
returns the full operator block, with its definition whole.

```
### 2. inspect compared: ok
- **compared** (join, executed)
  - definition: `join(on="region", how="inner", validate="many_to_one")`
  - inputs: left `spending`, right `budgets`
  - result: 4 rows × 3 columns
  - columns: region str, spent float64, budget float64
  - used by: over_budget
```

A loaded table carries its origin instead of a task:

```
### 2. inspect market_full_scores: ok
- **market_full_scores** (scan, loaded)
  - definition: `scan("…/market_full_scores.09a7fafeae19.parquet", format="parquet")`
  - result: 15 rows × 25 columns
  - columns: country str, content_credit float64, rank int64, opportunity_score float64, … +21 more
  - used by: full_candidates
```

With `"include_implementation": true`, a `filter`, `map` or `process` adds its
Python:

````
### 2. inspect correlation: ok
- **correlation** (process, executed)
  - definition: `process(fn=correlate, doc="Pearson correlation between yearly changes")`
  - functions:
    ```python
    def correlate(df):
        return pd.DataFrame({"correlation": [df["x_change"].corr(df["y_change"])]})
    ```
  - inputs: yearly_changes
  - result: 1 row × 1 column
  - columns: correlation float64
````

An operator that has not run, or whose last run failed:

```
### 2. inspect over_budget: ok
- **over_budget** (filter, stale)
  - definition: `filter(lambda row: row["spent"] > row["budget"], doc="Regions whose total spending exceeds their budget")`
  - inputs: compared
  - result: stale (execute to recompute)
```

```
### 2. inspect fractional_genre_period: ok
- **fractional_genre_period** (filter, failed)
  - definition: `filter(lambda row: row["added_year"] is not None and …, doc="Genre records for fractional assignments in the score period")`
  - inputs: fractional_genre_titles
  - result: failed
  - error MISSING_COLUMN: the function reads `added_year`, which input `fractional_genre_titles` does not have (its columns: show_id, country, credit, index, genre).
```

An unknown operator:

```
### 2. inspect totals_v2: error
- error UNKNOWN_OPERATOR: no operator `totals_v2`. Similar names: totals.
```

## A saved version (`stateHistory` only)

`"target": "state"` with a `task_id` returns the operator block as that task
saved it, with its immediate inputs as one-line blocks:

```
### 1. inspect score at task 2: ok
- **score** (map, saved by task 2)
  - definition: `map(lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")`
  - inputs: joined
  - result: 70 rows × 3 columns
  - columns: k int64, value str, score int64
- **joined** (join, saved by task 2)
  - definition: `join(on="k", how="inner")`
```

With `"task_id": null`, the versions of the operator, one row per change. A
version that held for several tasks shows their range; a definition that
returns is a restore from the last task it held in:

```
### 1. inspect score versions: ok
versions: score
| tasks | change | definition |
|---|---|---|
| 2 | created | `map(lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")` |
| 3 | updated | `map(lambda row: {**row, "score": row["k"] * 3}, doc="Tripled k")` |
| 4-5 | restored from task 2 | `map(lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k")` |
```

A version whose definition is unchanged but whose inputs changed shows
`inputs changed`; one with only a new result shows `recomputed`. Engine cache
hits do not create versions.

With a `view`, the saved result follows as a table block (formats in
[retrieve.md](retrieve.md)):

```
### 1. inspect score at task 2: ok
- **score** (map, saved by task 2)
  - …
records: 5 of 70 rows (retained records, not a random sample), 3 of 3 columns
| k | value | score |
|---|---|---|
| 1 | r-units | 2 |
```

When the earlier task saved no result:

```
### 1. inspect score at task 2: ok
- **score** (map, saved by task 2)
  - …
  - result: not saved; roll it back as a copy and execute it to recompute.
```

With `stateHistory` off:

```
### 1. inspect score at task 2: error
- error HISTORY_DISABLED: saved versions of earlier tasks are not available in this session.
```
