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

# `answer` and the catalog task entry

An answer ends the task. Building blocks and settings: [README.md](README.md).

## `answer` with `content`

The call holds the answer, so the receipt confirms it without repeating it
(`answerEcho: false`):

```
### 1. answer: recorded
```

With `answerEcho: true`, the answer follows on one line:

```
### 1. answer: recorded
answer: {"fractional_top_five": ["Thailand", "Turkey", "Spain", "Egypt", "Taiwan"]}
```

## `answer` with `from`

The composed answer is not in the call, so the receipt shows it:

```
### 3. answer: composed from fractional_top_report
answer: {"fractional_top_report": [{"country": "Thailand", "fractional_rank": 1, "opportunity_score": 56.7578}, …]}
```

Refused, with the reason; the task stays open and the model answers again:

```
### 3. answer: error
- error ANSWER_REFUSED: `fractional_top_report` has numbers with decimals and states no precision for "opportunity_score" (e.g. 56.75779857397504).
  - fix: give the rounding the request asks for, e.g. "fractional_top_report[:4]", or answer in content.
```

Other reasons: the table is empty, has more than 50 rows, lacks a named
column, holds only nulls, or the stated precision is not one the session's
requests use.

## The catalog task entry (`stateLedger`)

When a task is answered, its answer receipt carries the task's entry in the
catalog: one operator block for every table the task created, changed or
deleted, inputs before consumers, each in its final version. Intermediate
attempts stay in the task's earlier receipts and are not repeated.

```
### 1. answer: recorded
#### Task 5
22 tables created; none changed or deleted.
- **fractional_assignment** (project, created)
  - definition: `project(keep=["show_id", "country", "country_credit_equal"])`
  - inputs: country_long
  - result: 10,012 rows × 3 columns
  - columns: show_id str, country str, country_credit_equal float64
- **fractional_credit** (map, created)
  - definition: `map(lambda row: {"show_id": row["show_id"], "country": row["country"], "credit": row["country_credit_equal"]}, doc="Equal country credit assignment for each title")`
  - inputs: fractional_assignment
  - result: 10,012 rows × 3 columns
  - columns: show_id str, country str, credit float64
- **fractional_title_join** (join, created)
  - definition: `join(on="show_id", how="inner", validate="many_to_one")`
  - inputs: left `fractional_credit`, right `titles`
  - result: 10,012 rows × 23 columns
  - columns: show_id str, country str, credit float64, title str, … +19 more
- …
- **fractional_top_five** (limit, created)
  - definition: `limit(5)`
  - inputs: fractional_ranked
  - result: 5 rows × 26 columns
  - columns: country str, fractional_rank int64, opportunity_score float64, … +23 more
  - note: a top-5 table; its unlimited parent `fractional_ranked` has 15 rows.
```

Rules:

- **Which tables.** Those whose definition or inputs differ from the start of
  the task, plus those deleted during it.
- **Change words.** `created`, `updated`, `reconnected`, `rolled back to task
  N`, `copied from task N`, `deleted`. A table created and then updated within
  the task is `created`.
- **Order.** Inputs before consumers; ties keep creation order.
- **Fields.** The definition is shown here, cut at `definitionChars`, because
  the entry must stand on its own for later tasks. Inputs, result and columns
  as in any operator block. A note marks a top-k, a one-row or an empty table.
- **Deleted tables** are one header line: `- **selected** (project, deleted)`.
- **Records.** With `catalogRecords` above 0, each table retrieved during the
  task adds its first rows as a table block under its operator block.
- **Nothing changed.** `#### Task 5` then `No tables created, changed or deleted.`
- **Numbering.** Tasks count from 1, continuing after any tasks whose state was
  loaded at the start of the session.

Without `stateLedger` there is no catalog entry; the receipt is
`### 1. answer: recorded`.
