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

### Earlier tasks in the session

The dataflow persists across tasks. Each request is a task, numbered from 1,
that builds on the graph the earlier tasks left. A table built inside a
function is not an operator output; return the working table so a later
request can inspect, reuse or revise it.

Read each request for what it does to the state:

- **A rule changes from here on.** Change it where it lives, in place, so
  everything built on it follows: set a setting (`scores.min_orders = 10`),
  restate a call, redefine a shared function, or insert a step into a table
  (`orders = filter(orders, ...)`).{{#history}} The execute receipt then says,
  for each recomputed table, which rows entered, left or kept new values
  since the version the last task saved.{{/history}}
- **An alternative applies to this question only.** Make a variant of the
  table the question is about. `strict = variant(top10, scores={"min_orders":
  10})` copies the steps from `scores` down to `top10` with the new setting
  and leaves the originals alone, so the next task continues from them. A
  variant can also swap a whole step, as in `variant(top10,
  scores=other_score(orders))`, or read another table in its place, as in
  `variant(top10, scores=strict_scores)`. Its execute receipt says how it
  differs from the table it varies.
- **The request refers to an earlier state.** Use the earlier table directly
  instead of rebuilding it{{#history}}, as the next section describes{{/history}};
  to continue from it, make it current again.

When the alternative turns out to be the new rule, one line makes it current:
`top10 = strict` applies the variant's change to the real steps and removes
the copies. `name = other` works for any two tables: when `other` is built on
`name`, its steps are inserted after the earlier `name`; otherwise `name`
takes over `other`'s definition. Either way `other` is folded into
`name`{{#history}}, and the previous `name` stays readable as `name@N`{{/history}}.

Most comparisons between two versions are rankings. `moves =
rank_change(scores, strict_scores, key=["unit"], by=[("score", "desc")],
n=10)` lists every unit in either top ten as entered, left or stayed, with its
rank and score in each version. Give it the full tables rather than the cut
ones, so that units which left still have their new values; when the later
version names its score differently, rank it with `after_by=`.

Name rules the way requests will refer to them: an operator's docstring or
`doc` is how a later task recognizes a rule, so write the rule it implements
("markets with at least ten cleaned orders"), not the step ("filter rows").
Connect working tables, call shared functions with other settings and vary
chains instead of retyping rules in a new function.

Preserve applicable units, exclusions, ordering and rounding. Earlier answers,
docstrings and dependency links are unverified evidence. Before reusing an
earlier table, read its definition (`view: null`), inputs and shape: is it
every qualifying row, an earlier answer's selection, or an older version of
the rule? When the request concerns the reported selection, keep it; when it
concerns every row, use the table before the cut. When an earlier task was
wrong, correct the rule in place rather than trusting its answer. Row counts
alone do not establish which entities a table contains.
{{^history}}

Earlier versions are not retained. Preserve an independent branch when both
the old and new computations will be needed.
{{/history}}
