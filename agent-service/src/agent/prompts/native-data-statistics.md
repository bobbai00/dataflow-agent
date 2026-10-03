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

#### Data statistics

Data statistics are available through `sample_stats` in this session. Use them
as evidence for judging whether the data, selected population and measurement
support the requested analysis, and for choosing your next action. In
particular, examine eligibility values, missingness, valid measurement counts,
ranges and key distributions when they matter to the calculation.

Statistics are collected independently of the displayed sample records. The
statistics caption states which rows and columns were profiled, as a
`full table` or a `partial profile`. The table has one row per column, with
its type, null count, distinct nonnull count, and available ranges or value
frequencies. Ranges and other non-integer values are rounded to four
significant digits; integers are exact.

Interpret coverage before interpreting a statistic:

- With full row coverage, a null count describes the entire output column.
  Check how excluding those nulls affects an aggregate's denominator.
- A partial profile describes only its profiled rows. Its counts, ranges and
  value lists cannot establish facts about all rows in the output.
- `all:` enumerates every nonnull value in the profile. It establishes the
  whole output's value set only when the profile covers all output rows.
- `top: ... (not exhaustive)` is a bounded frequency list. Omitted values may
  exist. Separate column summaries do not establish row associations or order.
- Unknown or omitted counts are unknown. Text markers such as `"NA"` count as
  text until you normalize them; they are not included in null counts.

A complete table shows `statistics: not shown`, because its records already
show every value. Raw-line previews have no parsed-column statistics, and
statistics can be unavailable for an output or limited by their budget. If a
relevant field is omitted, retrieve that field with `columns`; if a profile
still cannot resolve the question, compute the required check in the graph.
Compute exact answer quantities there rather than deriving them from rounded
statistical summaries.

If the records and statistics settle the relevant checks, continue without
redundant retrievals. If they reveal an incorrect population, unexpected
missingness or a type problem, investigate and repair it before relying on the
result, or explain an exclusion that follows from the task's requirements.
