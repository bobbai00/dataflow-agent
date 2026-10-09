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

## 5. Working across requests

Later requests build on the Dataflow that earlier requests left. Read each request for what it does to that state:

- **A rule changes from now on.** Change it where it lives so that everything built on it follows: `set` the operator again with the new setting, or redefine its function. Setting an existing ID replaces that operator for everything that reads it.
- **An alternative for this request only.** Compute it alongside under new IDs and leave the current tables as they are: call the same function with the other setting and build only the steps the question needs on it.
- **An earlier state.** Read a table as an earlier request left it, written `name@N` for request N, instead of rebuilding it or retyping its rule. A version never follows later edits, so otherwise build on current tables by their current names. An update's receipt or catalog entry shows what it replaced, which tells you the request whose state is meant.

Write a rule that a later request may vary, such as a threshold, weight, population, or definition, as a keyword setting of the function that applies it, and give the operator a `doc` that states the rule as requests phrase it. Later requests then change the setting instead of retyping the rule in a new function. Return complete working tables; a table built only inside a function is gone for later requests.

Earlier answers and docs are unverified. Before building on an earlier table, check from its definition, inputs, and shape that it is the one the request means: every qualifying row, an earlier answer's selection, or an older version of a rule. When an earlier result was wrong, correct its rule in place.

For example, with a registered `unit_scores(orders, *, min_orders=5)`, a first request ranks units by score among units with at least five orders:

```text
set scores: unit_scores(orders, min_orders=5, doc='Score of each unit with at least five orders.')
set ranked: sort(scores, by=[('score', 'desc')])
set top: limit(ranked, n=3)
```

A later request says a unit needs ten orders from now on. The rule changes, so set it where it lives; `ranked` and `top` follow:

```text
set scores: unit_scores(orders, min_orders=10, doc='Score of each unit with at least ten orders.')
```

Another asks which current leaders were not leaders under the original threshold. That is an earlier state; `top@1` is `top` as the first request left it:

```text
set newcomers: join(top, top@1, on=['unit'], how='anti')
```

Another asks who would lead with twenty orders, for that question only. Compute it alongside with the same function:

```text
set strict: unit_scores(orders, min_orders=20, doc='Score of each unit with at least twenty orders.')
set strict_ranked: sort(strict, by=[('score', 'desc')])
set strict_top: limit(strict_ranked, n=3)
```
