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

# Does a dataflow help a multi-task session? What we measured

**Short answer.** The dataflow's maintenance property is real, correct under
test, and cheap: immutable per-task outputs, invalidation, demand-driven
execution, receipts and complete returns all work, and the context policy cuts
cost 28% and cache writes 53% against our own control on a 42-task session. It
is *not* demonstrated that any of it makes a multi-task session more correct
than a CodeAgent that simply keeps its Python variables between tasks. On
controlled families the Dataflow arms make two computation errors per 144
answers where both code agents make five, and the one family that
discriminates orders the arms exactly along the mechanism ladder — but the
totals are tied and the real sessions are lost. The binding constraints we
measured are answer-contract discipline and the agent's habit of re-deriving
everything, not state management.

This document is self-contained. Mechanism detail lives in
[kept-frames.md](kept-frames.md) and
[dependency-maintenance.md](dependency-maintenance.md); the argument this work
responds to is §§7–13 of
`agent-service/benchmark/multiturn/RESEARCH_REVIEW.md`, and §14 there carries
the same numbers in review form.

## 1. What was run

Four campaigns on an isolated stack (`isolated_stack.py`, profile
`/tmp/texera-maint`), model `gpt-5.6-luna`, strict deterministic evaluator
(exact key set, list order, absolute tolerance 1e-4, no judge).

| campaign | what | output |
| --- | --- | --- |
| `dev-run2` | 6 arms × 2 real LongDS sessions, 1 trial | `logs/campaigns/dev-run2` |
| `frames-run1` | `frames` arm × the same 2 sessions | `logs/campaigns/frames-run1` |
| `synthetic-run1` | 7 arms × 6 controlled families × 3 trials, 126 sessions | `logs/campaigns/synthetic-run1` |
| `dev-run3` | `maint`, `frames` × 2 real sessions, repeat with the new guard | `logs/campaigns/dev-run3` |

The arms, from least to most mechanism:

| arm | what it adds |
| --- | --- |
| `code` | smolagents CodeAgent, no state carried between tasks |
| `coderetain` | the same agent, its data variables retained and re-injected each task |
| `tasks` | Dataflow with task history (`{operator, atTask}`) and direct return |
| `reuse` | + ancestry facts and reuse guidance |
| `maint` | + complete return, receipts, compact index, empty-ancestor guard |
| `demand` | + demand-driven execution |
| `frames` | `maint` + kept frames (a UDF's intermediate tables as inputs) |

## 2. Real sessions: the numbers, and why they rank nothing

NFL task 1 (42 tasks) and university task 2 (21 tasks), one trial per arm.

| arm | NFL 42 | university 21 | calls | cost | cache writes |
| --- | --- | --- | --- | --- | --- |
| `code` | 1 | 13 | 96 | $0.336 | 215k |
| `coderetain` | **11** | **15** | 74 | $0.374 | 488k |
| `tasks` | 0 | 5 | 211 | $0.676 | 1,565k |
| `reuse` | 1 | 12 | 144 | $0.555 | 1,366k |
| `maint` | 1 | 10 | 129 | $0.412 | 714k |
| `demand` | 1 | 6 | 151 | $0.439 | 784k |
| `frames` | 0 | 6 | 146 | $0.398 | 724k |

Then we repeated two cells. Same fixtures, same model, same code, and a new
guard that never fired on the university session:

| arm | session | first run | repeat |
| --- | --- | --- | --- |
| `maint` | university | 10 | **2** |
| `frames` | university | 6 | **9** |
| `maint` | NFL | 1 | 1 |
| `frames` | NFL | 0 | 1 |

Thirteen of the repeat's nineteen failures carry different *numbers*, not
different labels, so this is analytical divergence rather than formatting. The
spread is wider than every arm-to-arm difference in the table above.

**Therefore the first table ranks nothing.** Read it only for cost and token
accounting, which are deterministic given a trajectory, and for the failure
attributions below, which were measured over hundreds of answers. Ranking arms
on a real session needs three trials; the observed band is about ±8 of 21.

Running real sessions was still the right first move: re-derivation, stale
answers, the naming conventions and a validator crash all surfaced there and
nowhere else. Development passes should keep the diagnosis and drop the
scoreboard.

## 3. Controlled families, three trials

Six families × 8 tasks × 3 trials = 144 answers per arm, $1.08 in total.

| arm | strict | content errors | contract slips | engine timeouts | cost |
| --- | --- | --- | --- | --- | --- |
| `demand` | 141/144 | 2 | 1 | 0 | $0.179 |
| `reuse` | 140/144 | 4 | 0 | 0 | $0.184 |
| `code` | 139/144 | 5 | 0 | 0 | $0.096 |
| `coderetain` | 139/144 | 5 | 0 | 0 | $0.116 |
| `tasks` | 139/144 | 5 | 0 | 0 | $0.164 |
| `frames` | 135/144 | 2 | 7 | 0 | $0.174 |
| `maint` | 134/144 | 5 | 3 | 2 | $0.165 |

Two things sit under the tie.

**The families are saturated.** Five of six are at 23–24 of 24 for nearly
every arm. Only `membership_values` — apply the *original* cohort's row
identities to a *new* data export — separates them, and there the ordering
follows the mechanism ladder exactly:

| family | code | coderetain | tasks | reuse | maint | demand | frames |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fanout_correction | 24 | 23 | 24 | 24 | 21 | 23 | 20 |
| independent_control | 24 | 24 | 24 | 24 | 24 | 24 | 24 |
| **membership_values** | **19** | **20** | **20** | **21** | **21** | **22** | **24** |
| repair_descendants | 24 | 24 | 23 | 24 | 24 | 24 | 19 |
| scope_expansion | 24 | 24 | 24 | 23 | 24 | 24 | 24 |
| temporary_scope | 24 | 24 | 24 | 24 | 20 | 24 | 24 |

That is the one family whose question *is* a reference to a previous task's
rows, which is precisely what task history and kept frames are.

**The strict column hides who computed correctly.** Splitting every failure by
kind, the Dataflow arms with the full mechanism set make two content errors in
144 answers where both code agents make five. Their lower totals are
answer-contract slips — six of `frames`' seven carry an extra `baseline_total`
key on otherwise exactly correct answers — plus two engine timeouts on a
foundation turn that poisoned two whole `maint` sessions. At n=144, 2 against
5 is about 1.2 standard errors: suggestive, not significant, recorded so a
larger run knows what to measure.

## 4. What the failures actually are

Three independent measurements point the same way.

**NFL, player-name casing.** Task 1 says to clean player names by lowercasing
them and key the workspace by the cleaned name; the gold answers report the
original display names. Comparing case-insensitively (folding int/float
changes nothing):

| arm | strict | case-insensitive |
| --- | --- | --- |
| `code` | 1 | 10 |
| `coderetain` | 11 | 11 |
| `frames` | 0 | 5 |
| `maint` | 1 | 4 |

Nine of `code`'s ten recovered tasks were hidden by casing alone — more than
the margin usually attributed to retention. This is not lost data: the
`displayName` column is still present in `maint`'s workspace and in the base
scan at every task. It is a convention fixed in the foundation turn and never
revisited.

**Controlled families, extra keys.** `frames` loses six answers to a helpful
extra key on numerically perfect results.

**University, divergent conventions.** The two `maint` runs diverge at task 3
on label spelling (`research` in gold, `research score` in one run,
`research_score` in the other) and never reconverge.

An answer contract offered equally to both arms would move more score than any
mechanism measured here, which is why it must not be bundled into the graph
experiment.

## 5. Stale answers: a failure the receipts caught

Across the six Dataflow real sessions, **35 tasks were answered by returning an
earlier task's answer operator with no edit and no execution at all. None was
correct.** One arm handed back `task25_calc` for eleven later questions.
The receipts state it exactly:

```
# Task 30 receipt
Edited: none
Executed: none
Returned: task25_calc (value)
```

The runtime had the fact and did not act on it. A direct return is now refused
once when the returning task edited nothing, executed nothing, and names an
operator a completed task already delivered; the message names that task, and
an unchanged second return is allowed, as with the empty-ancestor guard.

Measured effect (`dev-run3`, NFL): the guard fired on seven tasks that would
otherwise have idled, and every one then edited one or two operators. Tasks
that did no work at all fell from seven to three. **The score did not move** —
those tasks were already failing for other reasons. The guard removes a
degenerate behaviour; it does not buy accuracy.

## 6. Granularity, and the mechanism built for it

On the NFL session every Dataflow arm answered each task with one monolithic
UDF of 3–5k characters that re-derived the pipeline from the task-1 tables:
`maint` made 251 references to base tables and 45 to anything derived later.
The maintenance mechanisms had almost no dependency graph to act on. On the
university session, whose task 5 names "the cleaned dataset used for all later
analysis", the same arm made 43 references to derived results and 1 to a base
table. **The model decomposes when the question names the intermediate, and
not otherwise.**

[Kept frames](kept-frames.md) makes a UDF's intermediate tables addressable
without asking the model to plan for them: the runtime reports every DataFrame
the entry function assigned and did not return, the catalog lists them after
the operator's line, and `{operator, frame}` or `{operator, atTask, frame}`
reads one as an input through a synthesized view operator that behaves like
any other node. In the real session the `frames` arm read
`task4_answer.w@4` (86×27) in five of tasks 5 through 10 and wrote 1.0–1.3k
characters per task instead of 4k. It scores 24/24 on the one discriminating
controlled family. It did not move the real-session score in one trial, and
the model reverted to monolithic UDFs later in the session.

## 7. What the mechanisms did deliver

Against the Dataflow control (`reuse`) on the 42-task session, `maint` cuts:

| measure | `reuse` | `maint` | change |
| --- | --- | --- | --- |
| cache write tokens | 1,205k | 564k | −53% |
| model calls | 106 | 91 | −14% |
| cost | $0.477 | $0.341 | −28% |

with no accuracy change. Direct-return refusals over a *successful* operator
fell to zero: all 76 refusals in the controlled suite followed a real operator
failure. Demand-driven execution ran 1.3 operators per task against eager
maintenance's 1.5. This satisfies the review's Milestone B exit condition
against Dataflow itself, and fails it against CodeAgent, which is cheaper
still ($0.241 on that session).

## 8. Defects the campaigns found

Running real sessions paid for itself in defects, each fixed on this branch:

1. **Validator crash.** A UDF without `def process` hit an `UnboundLocalError`
   inside the validator, so the model saw "Python syntax validation
   unavailable" plus the head of a traceback and repaired blind — 38 retries
   across three tasks of one session. The arity is now computed before the
   branch, and the unavailable-validator message keeps the *tail* of stderr,
   where a traceback names its cause.
2. **A compact card dropped a cue.** The compact index printed `udf(opaque)`,
   losing the `def process` line that full cards carried in their clipped
   code; the model then wrote `def apply` in 5 of 26 UDFs under the compact
   index and 0 of 21 under full cards. Signatures now print the entry line.
3. **A runtime-owned property leaked.** `frame` reached the model's tool
   schema through the UDF catalog entry, and one task collected fifteen
   rejected edits authoring it. It is now stripped from the batch schema while
   the validator still accepts it on synthesized views.
4. **Stale answers** (§5).

All four are covered by `benchmark/multiturn/interface-fixes-smoke.ts`, ten
checks through the production agent loop against a real engine with no model
calls.

## 9. Verdict and the next experiment

Settled: the property is built and correct; it is cheap relative to our own
control; where a question *is* a reference to earlier state the mechanism
ladder orders the arms correctly and kept frames is perfect; Dataflow makes
fewer content errors than either code agent on the controlled families.

Not settled, and not to be claimed: that any arrangement of these mechanisms
makes a real multi-task session more correct than a CodeAgent that keeps its
variables. The measured wins are cost against our own control, and
content-error counts too small to carry weight.

The next step is not another mechanism. It is a benchmark that discriminates:
LongDS sessions whose later turns reference earlier **rows** and
**intermediate tables** rather than restating a formula, at the length and
messiness of the real sessions, scored with an answer contract given equally
to both arms, at three trials. The controlled families as built are too easy
to decide anything; `membership_values` is the shape to grow.

## 10. Reproduction

```bash
# stack
agent-service/benchmark/multiturn/isolated_stack.py /tmp/texera-maint \
  --project texera-maint --offset 30000 --agent-port 3051
bin/local-dev.sh up --skip=frontend

# ten-check interface smoke, real engine, no model calls
bun run agent-service/benchmark/multiturn/interface-fixes-smoke.ts /tmp/out

# controlled suite, three trials
.venv/bin/python agent-service/benchmark/multiturn/run-task-study.py \
  --fixtures /tmp/texera-maint/synthetic-fixtures --out logs/campaigns/<name> \
  --arms code,coderetain,tasks,reuse,maint,demand,frames \
  --workers 6 --native-workers 3 --repeat-all --recovery-rounds 2

# scoring by LongDS state label
.venv/bin/python agent-service/benchmark/multiturn/summarize-by-state.py \
  logs/campaigns/<name> --fixtures /tmp/texera-maint/fixtures
```

Settings are per arm in `run-task-native.ts`; every mechanism defaults off and
requires native catalog v2.
