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

### Data statistics

`sample_stats` adds column profiles independently of the displayed records.
Read each profile's coverage: it can cover a prefix rather than the full
table. Counts apply to that coverage; absent or budget-omitted facts remain
unknown. `all` lists values within the profile; `top` is not exhaustive.
Fractional summaries have four significant digits, so compute exact answer
values in the graph. Column summaries do not establish row associations or
ordering. Complete small records can suppress redundant profiles.

Use shown types, missingness, distinct values and ranges to settle relevant
questions without recomputing known facts. A full source scan does not imply
a full-table profile.
