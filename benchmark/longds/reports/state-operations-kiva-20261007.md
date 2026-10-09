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

# State operations on the Kiva Lite session, 2026-10-07

## Verdict

The state operations work end to end with Luna and Terra: every question of
both sessions completed, and the final build keeps the prompt cache at 95 to
96%. On the final run Terra wrote 23% less output per question than the
previous build, about as much as Python, while answering 18 of 37 against
Python's 23. Python's recorded cost is not comparable: its baseline breaks
the prompt cache at every task boundary (see below), and with that fixed
Python would cost less than dataflow. Luna had its best dataflow session on Kiva, 13 of the 35
questions Python answered against Python's 10. The agents themselves still
rarely reach for the new operations; most of the saving comes from shorter
code, shorter docstrings and fewer rejected edits.

One rep per arm. Two runs of the same design differed by three questions for
Terra (21 and 18), so accuracy differences of that size are noise.

| Kiva, 37 questions | Luna correct | Luna cost | Terra correct | Terra cost |
|---|---:|---:|---:|---:|
| Old build | 1 | $0.31 | 18 | $2.42 |
| Shared functions (cc1e74dea) | 0 of 34 | $0.34 | 20 | $2.72 |
| State operations, first run (cad0936c5) | 9 | $0.49 | 21 | $4.80 |
| State operations, final run (8503423d1) | 13 | $0.33 | 18 | $2.29 |
| Python | 10 of 35 | $0.38 | 23 | $3.16 |

The Python costs come from the 2026-10-06 baseline, whose catalog turns each
finished request into a new message, so every task's first call is 0%
cached; the fix recommended in `saved-versions-lite-run-20261006.md` was
never applied. Repricing the same recorded tokens at the campaign rates,
with each first call cached like the later calls, gives a fairer view:

| Kiva | Arm | First calls cached | Recorded cost | First calls cached like later calls |
|---|---|---:|---:|---:|
| Terra | Python | 0% | $3.16 | $1.93 |
| Terra | Dataflow, final run | 95% | $2.29 | $2.25 |
| Luna | Python | 0% | $0.38 | $0.25 |
| Luna | Dataflow, final run | 95% | $0.32 | $0.31 |

With fair caching, dataflow costs about 17% more than Python on Terra and 25%
more on Luna. Output tokens do not depend on caching. A real comparison needs
the Python baseline rerun with an append-only layout.

Terra, per question:

| Arm | Output tokens | On state-change questions | Code characters | In rejected edits | Docstrings and doc= | Saved inputs |
|---|---:|---:|---:|---:|---:|---:|
| Old build | 1,993 | 2,005 | 3,136 | 0 | 388 | 84 |
| Shared functions | 2,076 | 2,021 | 3,445 | 478 | 359 | 103 |
| State operations, final | 1,598 | 1,561 | 1,920 | 116 | 173 | 1 |
| Python | 1,634 | 1,629 | 2,582 | 0 | 0 | 0 |

Saved inputs counts `name@N` references used as inputs; all of them equalled
the current table in every run. Without the per-operator `saved as name@N`
lines in the task entries, the habit disappeared.

## What the end-to-end runs found and fixed

- **The per-task state block broke the prompt cache.** The provider reuses an
  earlier request only when it is a strict prefix of the new one. A block
  rendered before each request changed at every task, so each task's first
  call cached 21% instead of 96%, and Terra's first run cost $4.80. The block
  was removed; each task's entry now says what an update did to an operator,
  such as `updated: set refund_weight 0 to 1` or `updated: restored task 1's
  version`, and the final run cached 95 to 96%.
- **rank_change was too strict.** Agents wrote its ranking as for `limit`,
  with the keys as tie-breakers, and the later version often names its score
  differently. Key columns now break ties, and `after_by=` ranks the later
  table on its own column.
- **Rebinding a name in one edit was rejected.** `x = map(...)`, then
  `x = filter(x, ...)` now builds a chain, as in Python.
- **Nested calls were rejected.** Both models wrote
  `distinct(project(t, keep=[...]))`; the inner call is now its own step.
- **A function was held with a statement it did not use.** A function now
  depends only on the functions it calls.
- **A variant could not read another table in place of a step.** Luna wrote
  `variant(view, step=other_view)`; that form now copies the steps after
  `step` to read `other_view` (added after the final run, unit-tested).

## Operations the agents used

| Run | Model | Setting changes | Variants | Commits | Restores | Inserted steps | rank_change | Held statements |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Smoke, 4 questions | Luna | 0 | 1 | 0 | 0 | 2 | 1 | 8 |
| First | Luna | 0 | 0 | 0 | 0 | 2 | 7 | 6 |
| First | Terra | 0 | 0 | 0 | 0 | 4 | 0 | 6 |
| Final | Luna | 0 | 1 | 0 | 0 | 0 | 0 | 7 |
| Final | Terra | 0 | 0 | 0 | 0 | 1 | 0 | 8 |

When Luna used a variant, it was the intended one-line counterfactual:
`no_wait_pressure = variant(restored_pressure, restored_pressure={"wait_weight": 0.0, ...})`.
Both models made a rule's weights settings in some functions and left them
inline in others, and updates still come as new functions beside the old
ones; a new name keeps the comparison the question asks for.

## Reproduce

```bash
python3 benchmark/longds/shared_functions_report.py --gold <prepared>/gold.json --arm <name> <run> ...
python3 benchmark/longds/state_operations_report.py --gold <prepared>/gold.json --arm <name> <run> ...
```

Runs: smoke `/var/tmp/versions-stateops-smoke-20261007`, first
`/var/tmp/versions-stateops-kiva-20261007`, final
`/var/tmp/versions-stateops-kiva2-20261007`; earlier arms as in
`shared-functions-state-test-20261006.md`. Judged with
`deepseek/deepseek-v4-pro` through OpenRouter.
