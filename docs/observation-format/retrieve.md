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
records: full; 5 of 5 rows, 3 of 3 columns (complete)
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
records: full; 61 of 1,898 rows (retained records; cut at 5,000 characters), 16 of 16 columns
- order_key: 1477147, customer_key: 337525, restaurant_key: Hangawi | Korean, cost: 30.75, …
…
```

(16 columns exceed `keyValueColumns`, so the records print as key-value lines.)

## `sample_stats`

A sample of retained records plus statistics of the full table. This
example uses `maxResultRows: 4` and shows every printed sample record:

```
### 2. retrieve country_long: ok
- **country_long** (scan, loaded)
  - result: 10,012 rows × 5 columns
records: sample_stats; 4 of 10,012 rows (retained records, not a random sample), 5 of 5 columns
| show_id | country | country_position | country_count | country_credit_equal |
|---|---|---|---|---|
| s1 | United States | 1 | 1 | 1 |
| s8807 | India | 1 | 1 | 1 |
| s8 | United States | 1 | 6 | 0.16666666666666666 |
| s8 | Ghana | 2 | 6 | 0.16666666666666666 |
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
records: sample_stats; 4 of 4 rows, 3 of 3 columns (complete; statistics omitted)
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
`maxResultRows`). `sample` must be one of the session's offered
`retrievalViews`. The examples below print every record counted in their
captions; they are complete examples of a partial view.

### Sample records in Markdown

With `tableFormat: "markdown"` and `maxResultRows: 4`, the call is:

```json
{"type": "retrieve", "operator_id": "country_long", "view": "sample"}
```

Its receipt is:

```text
### 1. retrieve country_long: ok
- **country_long** (scan, loaded)
  - result: 10,012 rows × 5 columns
records: sample; 4 of 10,012 rows (retained records, not a random sample), 5 of 5 columns
| show_id | country | country_position | country_count | country_credit_equal |
|---|---|---|---|---|
| s1 | United States | 1 | 1 | 1 |
| s8807 | India | 1 | 1 | 1 |
| s8 | United States | 1 | 6 | 0.16666666666666666 |
| s8 | Ghana | 2 | 6 | 0.16666666666666666 |
```

The caption distinguishes records shown from the full result's shape.
`maxResultRows` is a ceiling: a character limit can allow fewer records.
The position of a record in this view does not establish its position in
the full table. Stored numeric values retain their precision.

### The same sample records in TSV

With `tableFormat: "tsv"`, the call, record selection and caption are the
same. Only the table syntax changes. The fields below are separated by
literal tab characters:

```text
### 1. retrieve country_long: ok
- **country_long** (scan, loaded)
  - result: 10,012 rows × 5 columns
records: sample; 4 of 10,012 rows (retained records, not a random sample), 5 of 5 columns
show_id	country	country_position	country_count	country_credit_equal
s1	United States	1	1	1
s8807	India	1	1	1
s8	United States	1	6	0.16666666666666666
s8	Ghana	2	6	0.16666666666666666
```

### Wide sample records as key-value lines

When more than `keyValueColumns` columns are shown, either table setting
uses one `column: value` line per record. This synthetic `orders_work`
example shows all 13 columns with `keyValueColumns: 12` and
`maxResultRows: 2`:

```json
{"type": "retrieve", "operator_id": "orders_work", "view": "sample"}
```

```text
### 1. retrieve orders_work: ok
- **orders_work** (map, executed)
  - result: 1,200 rows × 13 columns
records: sample; 2 of 1,200 rows (retained records, not a random sample), 13 of 13 columns
- order_key: 1477147, customer_key: 337525, restaurant: Hangawi | Korean, cost: 30.75, region: east, country: United States, status: delivered, ordered_at: 2026-01-03T18:30:00Z, delivery_minutes: 28, weekend: true, unit: A1, category: dinner, reviewed: true
- order_key: 1477148, customer_key: 337526, restaurant: Sunrise, cost: 18.5, region: west, country: Canada, status: pending, ordered_at: 2026-01-04T12:00:00Z, delivery_minutes: null, weekend: true, unit: B2, category: lunch, reviewed: false
```

Every displayed value stays attached to its column name. A column-narrowed
view uses the width of the displayed columns to choose its layout. For
example, requesting `["order_key", "cost"]` from this same result uses a
two-column table and says `2 of 13 columns (columns requested)`.

### Quoted values and clipped text

The same [value rules](README.md#value-rules) apply in every layout.
Missing values print as `null`; the text value `"null"` stays quoted.
JSON escapes keep a text value with a newline on one physical record line.
Inside a Markdown cell, a literal pipe is escaped as `\|`, including when
the text is JSON-quoted. For example:

```text
records: sample; 2 of 2 rows, 3 of 3 columns (complete)
| id | comment | code |
|---|---|---|
| 9007199254740993 | "east\|west" | "12" |
| 2 | "line one\nline two" | "null" |
```

A sample's text-cell cut is announced separately from its row and column
coverage. With `cellChars: 12`, the stored text
`Delivered after a delay` is displayed as `Delivered af…`:

```text
records: sample; 2 of 2 rows, 2 of 2 columns (incomplete; 1 text cell clipped at 12 characters)
| id | comment |
|---|---|
| 1 | Delivered af… |
| 2 | null |
```

That view does not claim completeness even though every row and column is
shown. A `full` view preserves the retained cell contents without sample
cell clipping; backend truncation is still announced.

### Adding statistics

`sample_stats` uses the same records and layout as `sample`, then appends
the statistics block shown above within its own budget. Its caption starts
`records: sample_stats;`. Adding statistics does not change which records
are selected or displace them. With full coverage of all rows, columns and
cell contents, a small complete table omits redundant statistics.

## Narrowed to columns

`{"type": "retrieve", "operator_id": "titles", "view": "sample_stats", "columns": ["show_id", "added_year"]}`
narrows both the records and the statistics; the caption counts the columns
shown against the table's:

```
records: sample_stats; 12 of 8,807 rows (retained records, not a random sample), 2 of 21 columns (columns requested)
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

A copy made by `fork operator … as <new_id>` can be read before it is executed; its
saved result is marked:

```
### 2. retrieve ranking_t2: ok
- **ranking_t2** (sort, saved)
  - inputs: `ranking_t2__scores`
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
- error RESULT_NOT_RUN: `review` has not been executed. Execute it, then retrieve.
```

```
### 3. retrieve top_doubled: error
- error RESULT_NOT_RUN: `top_doubled` did not run because upstream `doubled` failed. Repair it, execute, then retrieve.
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
