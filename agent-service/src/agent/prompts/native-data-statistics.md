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

`sample_stats` adds data statistics: evidence for whether the data, selected
population and measurement support the analysis. Examine eligibility values,
missingness, valid measurement counts, ranges and key distributions when they
matter to the calculation.

Statistics are collected independently of the sample records. The caption
says which rows and columns were profiled, as a `full table` or a `partial
profile`. Each column gets its type, null count, distinct nonnull count, and
ranges or value frequencies; non-integers are rounded to four significant
digits and integers are exact.

- With full coverage, a null count describes the whole column; check how
  excluding nulls changes an aggregate's denominator.
- A partial profile describes only its profiled rows.
- `all:` lists every value in the profile; it is the column's whole value set
  only with full coverage.
- `top: ... (not exhaustive)` is bounded. Column summaries do not establish
  row associations or order.
- Unknown or omitted counts are unknown. Text markers such as `"NA"` are text,
  not nulls, until you normalize them.

A complete table shows `statistics: not shown`, because its records show every
value. Raw-line previews have no column statistics. Retrieve an omitted field
with `columns`; compute a check the profile cannot settle in the graph, and
compute exact answer quantities there rather than from rounded summaries.

If records and statistics settle the relevant checks, continue without
redundant retrievals. If they reveal a wrong population, unexpected
missingness or a type problem, repair it before relying on the result, or
explain an exclusion the task requires.
