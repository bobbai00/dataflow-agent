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

# Shared functions and in-place state on two Lite sessions, 2026-10-06

## Verdict

The new edit form did not cut output on state-change questions through
state. The agents changed earlier state in place on at most two questions
per session. They answered each update with a new table under a new name,
built by a new function that most often ran once. Where output fell, on
water, the drop came from shorter edits rather than reuse, and the two runs
of the new build differ widely (Luna wrote 2,926 and then 1,792 code
characters per question), so one rep cannot size it. On Kiva, Terra wrote
more code than the old build and than Python.

Accuracy rose for Luna on water and stayed flat for Terra. Python stayed
ahead in every session and model. One rep per arm, so a single misreading
moves a whole session: the Terra water rerun lost seven questions to one
wrong table.

| Session | Model | Old build | New build | Python |
|---|---|---:|---:|---:|
| Water, 34 questions | Luna | 9 | 16, rerun 21 | 24 |
| Water, 34 questions | Terra | 24 | 25, rerun 19 | 26 |
| Kiva, 37 questions | Terra | 18 | 20 | 23 |
| Kiva, first 33 questions | Luna | 1 | 0 | 10 |

Output tokens per state-change question (Update, Rollback, Counterfactual):

| Session | Model | Old build | New build | Python |
|---|---|---:|---:|---:|
| Water | Luna | 2,120 | 2,037, rerun 1,519 | 1,810 |
| Water | Terra | 1,602 | 1,507, rerun 1,450 | 1,355 |
| Kiva | Terra | 2,005 | 2,021 | 1,629 |
| Kiva | Luna | 2,586 | 2,487 | 1,900 |

The water reruns used commit cc1e74dea (tables may share a function's name,
a note when a saved input equals the current table). Kiva used the same
build. Old builds and Python are the runs in
`/var/tmp/versions-lite-run-20261006`; Luna's Kiva Python arm stopped after
35 answers and Luna's new Kiva session stopped at question 34, which hit the
15-call cap, so Luna's Kiva rows compare the first 33 questions.

## The mechanism was taught but not used

| Session, model, run | Questions changing earlier state | Shared functions (called once) | Saved inputs (differing from current) | Saved-input notes shown |
|---|---:|---:|---:|---:|
| Water, Luna, first / rerun | 2 / 2 | 43 (32) / 36 (30) | 83 (0) / 21 (0) | 0 / 61 |
| Water, Terra, first / rerun | 2 / 1 | 37 (25) / 36 (30) | 49 (0) / 43 (0) | 0 / 118 |
| Kiva, Terra | 0 | 39 (30) | 103 (0) | 228 |
| Kiva, Luna | 1 | 28 (19) | 66 (0) | 263 |

Kiva's updates ask to compare the old rule with the new one, and the agents
keep both by naming the new one. Task 5 asks for a stronger share of named
regions; Terra writes
`strict_regional_pressure = build_strict_regional_pressure(clean_loans)`, a
new function that recomputes the view from the cleaned loans. The in-place
form would restate the existing pressure table with a new setting and
compare it with its saved task-4 version. Terra's task-1 function made the population
thresholds settings but not the weights, so the task-3 counterfactual
(waiting time removed) became another new function on the revised table
instead of a one-line call.

Saved references are used as names for current tables. All 365 saved
inputs in the six new-build runs equalled the current table.
The task log teaches this: each operator ends with "saved as `name@N`",
answer sources are written as `name@N`, and a "Saved versions" line repeats
up to twelve unchanged tables as `name@N`. The note added in cc1e74dea was
shown 61 to 263 times per session and did not change the habit.

## Output is mostly new logic

Characters per question for the new build and Python. Python reads data
inside its scripts, so it has no read actions.

| Session, model | Arm | Code | In rejected edits | Docstrings and `doc=` | Read actions | State-change code repeating earlier 8-token runs |
|---|---|---:|---:|---:|---:|---:|
| Water, Luna | new, rerun | 1,792 | 0 | 264 | 496 | 46% |
| Water, Luna | Python | 2,480 | 0 | 0 | 0 | 68% |
| Water, Terra | new, rerun | 1,811 | 0 | 260 | 626 | 49% |
| Water, Terra | Python | 2,011 | 0 | 0 | 0 | 44% |
| Kiva, Terra | new | 3,445 | 478 | 359 | 670 | 51% |
| Kiva, Terra | Python | 2,582 | 0 | 0 | 0 | 49% |
| Kiva, Luna | new | 3,861 | 478 | 475 | 841 | 51% |
| Kiva, Luna | Python | 3,075 | 0 | 0 | 0 | 44% |

Dataflow repeats earlier code about as often as Python, so reuse is not
where dataflow can win on output for these sessions. Only 5 to 10% of the
new build's code lines repeat a line written in an earlier question. The
measurable costs are elsewhere: rejected edits (14% of Terra's Kiva code),
required docstrings and `doc=` text (10 to 15%), and read actions, which
restate an operator list and three fixed fields at 200 to 260 characters
each, two to three times per question.

Four of Terra's six rejected Kiva edits were a defect in the new form: a
table named like its function (`partner_score_reversals =
partner_score_reversals(...)`) could not be the input of a later operator.
Fixed in 809246c98, with two message fixes found in the same traces (an
unclosed bracket now names its line; rejected calls show `clean_loans@1`,
not the parser's placeholder). Luna's six were four nested operator calls,
a lambda in the table position and one indentation error.

## Where sessions were lost

- **Terra water rerun, questions 20 to 26.** At task 5 Terra named the full
  post-acidity table `initially_repaired_reduced`. At task 20, asked for
  "the early strained list", it passed that 1,265-row table instead of the
  five-row `most_strained_initially_repaired`, and tasks 21 to 26 reused the
  same inputs. The first run picked the shortlist and passed task 20.
- **Luna Kiva, from question 1.** The specification defines the completion
  gap as "100 minus weighted completion percentage". Both dataflow builds
  percentile-ranked it. In the new build Armenia/Agriculture got a gap
  score of 90.646 instead of 12.917, so early pressure was 84.703 instead
  of 65.27, and every later view inherited it. Luna's Python run and Terra used the raw gap.

## What this says about the target

Reducing output on state changes through in-place edits needs agents that
take the in-place path, and on these sessions they do not: an update is a
comparison, and a new name keeps both sides. Even if they did, the reusable
share of the code is small. The new syntax is still worth keeping: it is
shorter, Luna's water accuracy rose, and nothing regressed beyond run-to-run
variance. Scaling this build to more sessions would measure syntax, not
state.

## Reproduce

```bash
python3 benchmark/longds/shared_functions_report.py \
  --gold /var/tmp/versions-lite-run-20261006/prepared/<session>/gold.json \
  --arm "old build" <old run> --arm "new build" <new run> --arm Python <python run> [--limit 33]
```

Runs: water reruns `/var/tmp/versions-shared-water2-20261006`, first water
runs `/var/tmp/versions-shared-water-20261006`, Kiva
`/var/tmp/versions-shared-kiva-20261006`. Judged with
`deepseek/deepseek-v4-pro` through OpenRouter by
`benchmark/longds/context_state_score.py evaluate`.
