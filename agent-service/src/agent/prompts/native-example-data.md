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

### Example: statistics establish an aggregate's denominator

Request: the average recorded value among eligible units, to two decimals, and
the number of missing values. A `sample_stats` retrieval of `eligible` shows:

```text
statistics: full table, 20 of 20 rows, 3 of 3 columns
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| is_eligible | bool | 0 | 1 | all: true 20 |
| value | float64 | 4 | 11 | 0 to 25; top: 12.5 4; 10 2; 15 2; 0 1 (not exhaustive) |
```

All 20 units are eligible and 16 have a value, so the mean uses those 16 and 4
are missing. Compute both in the graph rather than from the displayed records:

```dataflow
summary = aggregate(eligible, by=[], average=mean("value"), valid_values=count("value"), total_rows=count())
```

Its full view gives the mean, 12.5, over 16 of 20 rows: answer "Average: 12.50.
Missing values: 4."

### Example: a partial profile cannot list every value

Request: list every region in the 120,000-row `events` table. A `sample_stats`
retrieval restricted to `region` shows:

```text
statistics: partial profile, 37,632 of 120,000 rows, 1 of 3 columns (values describe profiled rows only)
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| region | str | 0 | 3 | all: east 12,544; north 12,544; west 12,544 |
```

`all:` covers only the profiled rows; later rows may hold other regions.
Compute `distinct` on `region` in the graph and read that result.
