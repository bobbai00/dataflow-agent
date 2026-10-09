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

### Example: use data statistics to establish an aggregate's denominator

Request: report the average recorded value among eligible units, to two decimal
places, and the number of missing values. The executed `eligible` table holds
the selected units.

```json
{
  "reasoning": "Check the selected population and missing values before averaging.",
  "actions": [
    {"type": "retrieve", "operator_id": "eligible", "view": "sample_stats"}
  ]
}
```

Observation:

```text
### 1. retrieve eligible: ok
- **eligible** (filter, executed)
  - inputs: `units`
  - result: 20 rows × 3 columns
  - columns: unit str, is_eligible bool, value float64
records: sample_stats; 4 of 20 rows, 3 of 3 columns (first and last retained records; … marks omitted rows)
| unit | is_eligible | value |
|---|---|---|
| U01 | true | 0 |
| U02 | true | 25 |
| … | … | … |
| U19 | true | null |
| U20 | true | null |
statistics: full table, 20 of 20 rows, 3 of 3 columns
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| is_eligible | bool | 0 | 1 | all: true 20 |
| unit | str | 0 | 20 | top: U01 1; U02 1; U03 1; U04 1 (not exhaustive) |
| value | float64 | 4 | 11 | 0 to 25; top: 12.5 4; 10 2; 15 2; 0 1 (not exhaustive) |
- flow: Filter kept=20/20, rejected=0, null predicates=0 (a None verdict drops the row).
- flow: predicate column "is_eligible": input (full=20 rows) null=0/20, distinct(nonnull)=1; output (full=20 rows) null=0/20, distinct(nonnull)=1.
- flow: contract; Filter: stable subset of input rows; predicate columns=["is_eligible"].
```

The statistics cover the full table. They establish that all 20 selected units
are marked eligible and that 16 have recorded values. The requested average
uses those 16 values, and the four missing values must be reported. Compute
the mean and counts in the graph rather than averaging the displayed records:

```json
{
  "reasoning": "Compute the recorded-value average and the number of missing values.",
  "actions": [
    {"type": "edit", "changes": "average_values = aggregate(eligible, by=[], average=mean(\"value\"), total_rows=count(), valid_values=count(\"value\"))\nsummary = map(average_values, lambda row: {**row, \"missing\": row[\"total_rows\"] - row[\"valid_values\"]}, doc=\"Average with valid and missing counts\")"},
    {"type": "execute", "operator_ids": ["summary"]},
    {"type": "retrieve", "operator_id": "summary", "view": "full"}
  ]
}
```

The retrieved `summary` row gives the exact mean, 12.5, over the 16 recorded
values, with 4 missing.
{{#flow}}
The flow line for `average_values` confirms that the mean used 16 of the 20
rows.
{{/flow}}
Answer without another retrieval:

```json
{
  "reasoning": "The computed average and missing count answer the request.",
  "actions": [
    {"type": "answer", "content": "Average: 12.50. Missing values: 4."}
  ]
}
```

### Example: a partial data profile cannot establish every value

Request: list every region represented in the fully executed `events` table.
A `sample_stats` retrieval restricted to `region` returns:

```text
### 1. retrieve events: ok
- **events** (scan, executed)
  - result: 120,000 rows × 3 columns
  - columns: region str, … +2 more
records: sample_stats; 4 of 120,000 rows, 1 of 3 columns (first and last retained records; … marks omitted rows; columns requested)
| region |
|---|
| east |
| west |
| … |
| west |
| north |
statistics: partial profile, 37,632 of 120,000 rows, 1 of 3 columns (values describe profiled rows only)
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| region | str | 0 | 3 | all: east 12,544; north 12,544; west 12,544 |
- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=120000 rows.
```

`all:` is exhaustive for the profiled rows only. The profile covers 37,632 of
the 120,000 rows, so later rows may contain other regions, and this
observation cannot establish the whole table's value set. Compute the distinct
regions over the full executed table, for example with `distinct` on the
`region` column, and read that focused result instead.
