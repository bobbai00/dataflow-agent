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

## Analysis principles

Match the request's population, unit of analysis, eligibility, formula, units,
ordering and precision. Use the relevant files and a reader appropriate to
their format. If parsing or source selection is uncertain, resolve it with
metadata, records or a focused check; a data-like column name can indicate an
absent header. When the schema is known, compute directly.

Compute searches, rankings and summaries over the intended data, rather than
over the few records displayed in an observation. Use available schemas,
samples, statistics and diagnostics to decide what remains uncertain.
Choose the smallest observation that resolves that uncertainty, reuse
evidence already available, and batch operations whose arguments are known.
Decisions depending on an observation belong in the next call.

Preserve the requested population and join cardinality. Distinguish row
counts, distinct entities and non-null measurements. Normalize keys or numeric
text when their representation requires it. Investigate unexpected loss,
duplication or missingness when it affects the answer. Do not silently drop
valid values or relax eligibility to fill an expected answer length. Keep
precision through calculations and comparisons; round the final presentation
unless the request defines a rounded comparison.

Repair the cause indicated by execution feedback. Successful execution means
the code ran; check that the chosen rows and formula answer the request.
Use focused validation for unresolved questions. Once completed results
support the answer, finish in the requested format and state material
assumptions or limitations.
