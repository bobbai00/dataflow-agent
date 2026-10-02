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

# `retrieve`

Reads an executed result in a chosen view; never executes. Building blocks,
value rules and settings: [README.md](README.md).

The receipt is the operator block (header and result), then the records table
block, then, in `sample_stats`, the statistics table block, then any `flow`
lines. The records caption states the view, how many rows and columns are
shown, and whether that is the whole table.

## `full`

The whole table fits:

```
### 3. retrieve fractional_top_report: ok
- **fractional_top_report** (project, executed)
  - result: 5 rows × 3 columns
records: 5 of 5 rows, 3 of 3 columns (complete)
| country | fractional_rank | opportunity_score |
|---|---|---|
| Thailand | 1 | 56.75779857397504 |
| Turkey | 2 | 53.29955947136563 |
| Spain | 3 | 49.21670702179177 |
| Egypt | 4 | 44.11137868753762 |
| Taiwan | 5 | 38.2051282051282 |
```

The table exceeds `fullResultCharLimit`; records keep their stored order and
stop at the budget:

```
### 3. retrieve orders_work: ok
- **orders_work** (map, executed)
  - result: 1,898 rows × 16 columns
records: first 61 of 1,898 rows (cut at 5,000 characters), 16 of 16 columns
- order_key: 1477147, customer_key: 337525, restaurant_key: Hangawi | Korean, cost: 30.75, …
…
```

(16 columns exceed `keyValueColumns`, so the records print as key-value lines.)

## `sample_stats`

A sample of retained records plus statistics of the full table:

```
### 2. retrieve country_long: ok
- **country_long** (scan, loaded)
  - result: 10,012 rows × 5 columns
records: 12 of 10,012 rows (retained records, not a random sample), 5 of 5 columns
| show_id | country | country_position | country_count | country_credit_equal |
|---|---|---|---|---|
| s1 | United States | 1 | 1 | 1 |
| s8807 | India | 1 | 1 | 1 |
| s8 | United States | 1 | 6 | 0.16666666666666666 |
| s8 | Ghana | 2 | 6 | 0.16666666666666666 |
| … | … | … | … | … |
statistics: full table, 10,012 of 10,012 rows
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| show_id | str | 0 | unknown |  |
| country | str | 0 | 122 | top: United States 3,690; India 1,046; United Kingdom 806; Canada 445 (not exhaustive) |
| country_position | int64 | 0 | 12 | 1 to 12, mean 1.321 |
| country_count | int64 | 0 | 10 | 1 to 12, mean 1.643 |
| country_credit_equal | float64 | 0 | 10 | 0.08333 to 1, mean 0.7966 |
```

A complete small table needs no statistics; its records say everything:

```
records: 4 of 4 rows, 3 of 3 columns (complete; statistics omitted)
```

A partial profile, and a table with no profile:

```
statistics: first 2,000 of 1,048,575 rows (partial prefix; values describe these rows only)
```

```
statistics: unavailable for this result
```

## `sample`

Records only, within the sample budget (`maxOperatorResultCharLimit`,
`maxResultRows`), with the same caption as above.

## Narrowed to columns

`{"type": "retrieve", "operator_id": "titles", "view": "sample_stats", "columns": ["show_id", "added_year"]}`
narrows both the records and the statistics; the caption counts the columns
shown against the table's:

```
records: 12 of 8,807 rows (retained records, not a random sample), 2 of 21 columns (columns requested)
```

## A file preview

A `scan` with `preview=n` returns raw lines, not a parsed table:

```
### 1. retrieve orders: ok
- **orders** (scan, executed)
  - result: preview of data/orders.csv, 8 lines (not a parsed table; remove preview and execute before computing)
records: 8 raw lines
| line |
|---|
| Exported 2026-09-30 by finance |
| region,amount,date |
| east,120.5,2026-01-03 |
| … |
statistics: unavailable for raw lines; parse them into columns first
```

## Flow evidence (`flowEvidence`)

`flow` lines follow the table blocks, naming the operator they describe when
it is upstream of the one retrieved:

```
- flow (typed): cast of value to int64 failed for 2 of 20 values, e.g. "1.5" × 1, "2.5" × 1.
- flow (compared): inner join of 4 left and 4 right rows produced 4 rows; every key matched once.
- flow: mean("value") used 16 of 20 rows; 4 were null.
```

## A result read from an earlier task (`stateHistory`)

A copy made by `rollback … as <new_id>` can be read before it is executed; its
saved result is marked:

```
### 2. retrieve ranking_t2: ok
- **ranking_t2** (sort, copied from task 2)
  - result: 15 rows × 4 columns (saved by task 2)
records: …
```

If an edit later in the same call changes the operator, the receipt says the
records are no longer current:

```
  - note: changed later in this call; these records are its earlier version.
```

## Refused

```
### 3. retrieve over_budget: error
- error RESULT_STALE: `over_budget` changed after its last execution. Execute it, then retrieve.
```

```
### 3. retrieve review: error
- error RESULT_NOT_RUN: `review` has never been executed.
```

```
### 3. retrieve fractional_genre_period: error
- error RESULT_FAILED: its last execution failed.
- error MISSING_COLUMN: the function reads `added_year`, which input `fractional_genre_titles` does not have.
```

```
### 3. retrieve titles: error
- error UNKNOWN_COLUMN: `titles` has no column `year`. Its columns: show_id, type, title, director, … +17 more.
```

```
### 3. retrieve totals_v2: error
- error UNKNOWN_OPERATOR: no operator `totals_v2`. Similar names: totals.
```

A view the session does not offer rejects the whole call before anything runs
([calls-and-prompt.md](calls-and-prompt.md)).
