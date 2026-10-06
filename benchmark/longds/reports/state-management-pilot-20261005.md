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

# LongDS state-management pilot: results

2026-10-05. **24/24 probes attempted, completed and judged. No scale-up.**

The observed results favor ordinary Python. **This pilot does not establish
a causal advantage or disadvantage of automatic versioning:** the generated
prefixes differed substantially in correctness and failed the verified-fixture
gate. They were retained as natural-state recovery diagnostics, without gold
state injection, answer repair, or score-selected solver retries.

See the [revised plan](state-management-comparison-plan-20261005.md) and
[results and evaluator adapters](state-management-pilot-20261005.json).
Full private artifacts are at `/var/tmp/dataflow-state-pilot-20261005`.

## Protocol and what “prefix” means

A prefix is the earlier questions and the execution state created while solving
them. Q28 starts from the completed Q1–Q27 trajectory; Q8 starts only after Q7.
It includes earlier public contexts/questions, the agent's own answers, scripts
or operators, and retained state. It does not include future questions.

We used only `business/netflix_movies_and_tv_shows/task3` from LongDS v1.1
Lite. Probes were Q8, Q14, Q24 and Q28, initialized after Q7, Q13, Q23 and Q27.
Q28 reaches back 21 turns. One Terra-generated prefix per condition was reused
for Terra and Luna continuations. These are not Luna natural-session results.

The Python baseline is **modified DSGym-style catalog ReAct**, not stock DSGym.
Each probe gets an independent replayed session. Its preceding tasks share one
persistent kernel, and continuation uses that same kernel:

- Ordinary Python freely retains names, copies and files; it is not forced to
  overwrite or prohibited from keeping old values.
- Disciplined Python adds generic instructions to retain independent copies
  under meaningful versioned names. Those copies remain in the same kernel.
- Dataflow exposes saved operator versions, task/state inspection, restore and
  fork, with ordinary ReAct and no ledger.

Each new question receives the prior-task catalog rather than the previous
ReAct transcript. Current-question ReAct remains intact. Both models use medium
reasoning, 40 calls/turn and 8,192 output tokens/call. There is **no added input
token cap or automatic compaction**. Native statistics are collected and
`sample_stats` is available; automatic flow evidence is off. Python can print
statistics normally. Current Python outputs and native full retrievals are
bounded at 5,000 characters; historical code/catalog retrieval has separate
budgets and different granularity.

Source pins: DataMind `a814927159470ad1624602d233f57b7c0be5882e`;
published data `6b448459c333ecc050a2e89fcc65c0e044d763ac`.
All conditions receive the same 16 published raw files, excluding seven
generated files found in the shared data folder. Reference code, answers and
dependency annotations are evaluator-only and were never supplied to solvers.
Private reference replay matched all 36 published answers.

## Results

The judge uses the pinned upstream question-driven prompt and
`deepseek/deepseek-v4-pro`. Original verdicts are preserved. Costs below are
solver token-rate estimates, excluding prefix preparation and judging.

| Condition / continuation | Q8 | Q14 | Q24 | Q28 | Correct | Four-probe cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary Python / Terra | 1 | 1 | 1 | 1 | 4/4 | $0.11035 |
| Disciplined Python / Terra | 1 | 0 | 1 | 1 | 3/4 | $0.12729 |
| Dataflow / Terra | 0* | 0 | 1 | 1 | 2/4 | $0.24883 |
| Ordinary Python / Luna | 1 | 1 | 0 | 1 | 3/4 | $0.01882 |
| Disciplined Python / Luna | 1 | 0 | 0 | 1 | 2/4 | $0.01861 |
| Dataflow / Luna | 1 | 0 | 0 | 1 | 2/4 | $0.03538 |

\* **Suspected judge schema sensitivity:** Terra's dataflow Q8 answer gives
identical fractional/full-claim lists, overlap five, and empty entering/leaving
sets. The judge rejected the missing explicit `top_five_changed` boolean.
The question's conclusion is clear from those values. We flag this separately
and leave the official score at zero.

All conditions attempted every probe, so lower costs here are not explained by
skipped questions. On aligned questions where **both conditions passed**,
dataflow costs were 1.44× ordinary Python for Terra (Q24/Q28), and 1.91× for Luna
(Q8/Q28). Disciplined Python ratios were 1.10× and 0.96× respectively, on their
own both-correct intersections. These tiny subsets are diagnostics, not stable
estimates of expected cost.

## Why the verified-prefix gate failed

| Primary Terra prefix, Q1–Q27 | Official correct | Prefix cost estimate |
| --- | ---: | ---: |
| Ordinary Python, corrected context | 25/27 | $1.07521 |
| Disciplined Python, corrected context | 9/27 | $1.34413 |
| Dataflow | 9/27 | $2.23486 |

No prefix is labeled reference-verified. Correct answers alone would not have
been sufficient: reusable intermediate tables were also checked.

An infrastructure audit found that the initial Python catalog omitted earlier
**public task contexts**, losing global rounding/tie conventions that dataflow
retained. Only the two Python prefixes were regenerated after fixing this
context omission. Their original runs remain excluded from arm comparisons,
with their costs and traces preserved. This was not selection among repeated
solver attempts for better accuracy.

The planned controlled comparison required correct, aligned checkpoints. That
condition was not met, and we did not patch dozens of outputs or inject oracle
tables to manufacture it. The 24 probes therefore measure recovery from
different natural prefixes. Their accuracy gap cannot isolate the effect of
retention guidance or the historical-state API.

## What the traces show about state management

**Long distance did not force Python to reconstruct old state.** All four
Python Q28 continuations found retained entropy-era tables by name. Ordinary
Python used `ent_scan`/related tables; disciplined Python used explicitly named
task-7 tables. All returned the expected five leaders and overlap four.
This refutes the assumption that an ordinary persistent kernel necessarily
loses the required old value.

**The dataflow capabilities worked, but their benefits were conditional.**
Terra Q28 forked task-7 `entropy_movement` and task-26
`tighter_screen_metrics`, joined the old score with the current screen,
executed and answered. Two fork commands plus the comparison/limit added
16 operators. Luna Q28 inspected saved observations and answered without
editing or execution. Both found the correct leaders.

At Q8, Terra requested two forks and added 15 operators; Luna requested one
fork and added nine. Both executed a comparison. At Q24 both dataflow models
read the saved director-penalty table and used no execution. This distinguishes
definition reuse, observation reuse and computation.

**Fork is not a full-result cache reader.** It copies the historical upstream
closure into new operator IDs. Compatible saved observations are readable, but
new downstream execution is not directly bound to the old full materialization;
ancestors can be recomputed. This implementation does not establish the claimed
“no recomputation” rollback advantage.

**Useful state was sometimes hidden inside process code.** At Q13, the native
process calculates a full working market table locally but exposes only a
ten-row mixed report. History can retrieve the report or its code, not the
unreturned local table. Q14 then generates about 6–10 KB of calculation code that
read raw files again. Operator-output versioning cannot recover a local variable
that was never published as an operator output.

## Intermediate correctness, updates and cascading errors

The new scorer uses explicit table-role adapters, country keys, selected
columns, numeric tolerances and coverage. Unknown or bounded incomplete
observations are not silently scored as failures. The checked columns differ
for some available outputs; their cell scores are not a common cross-arm
accuracy scale.

- Ordinary Python's Q7 working table matches the oracle exactly. Its combined
  Q13 score/rank cells match at 80%, despite a correct Q14 final answer.
- Dataflow and disciplined Python omit the US trend file, producing 14 tracked
  markets instead of 15. The omission appears at Q7 and remains visible in
  later checkpoints. Disciplined Python also constructs weekly dates instead
  of reading the CSV dates.
  Both prefixes have the same pass/fail labels on all 27 questions (the same
  18 failures). Their common file omission is a strong shared explanation,
  though it has not been isolated as the sole cause of every failure.
- Ordinary Python's Q10 freshness rule counts negative release-to-add lags as
  fresh, while the reference uses the inclusive interval 0–3 years. The resulting
  six-country score errors explain **all** Q13/Q23/Q27 score differences, to a
  maximum residual of `1.42e-14`. This is a traced semantic-error cascade,
  not a missing historical version.
- Q14 dataflow/disciplined outputs use a candidate pool differing from the
  reference updated top eight. Recovering an old treatment on the wrong pool
  can still produce plausible numbers.
- All three Luna Q24 continuations include Taiwan instead of a required
  market. The needed penalty values were available. Python's probe scripts
  printed tables and left the final selection to the model; this is a
  selection/ordering error, not proof that old state was inaccessible.

The original prefix update checks at Q13 and Q23 classify five available
table anchors as incorrect and one as unknown. None fully matches the obsolete
oracle table. This is not evidence that stale state never occurs: coverage is
limited, and wrong upstream inputs can obscure a stale-rule error.

The probes contain 41 selected table checks: six match, 32 differ and three
are unknown. They include repeated preserved-state checks and different column
selections, so those counts are coverage diagnostics rather than a leaderboard.
For example, every Q28 final answer passes, while only ordinary Python's
materialized complete screened-entropy table matches the oracle.

## Branch preservation, lineage and partial credit

Within observer coverage, all probes preserve the pre-existing table values.
Native pre-existing definitions and incoming edges also remain unchanged.
Large truncated observations are excluded from value-preservation certification;
Python locals inside callbacks and external effects are outside this check.

Initializer validation passes for all 16 Python probes at the exported-table
fingerprint level. For all eight native probes, replayed definitions and wiring
match the corresponding frozen checkpoint; complete retained observations match.
Large bounded observations and physical full materializations remain uncertified.
Every checkpoint exposes only preceding task IDs.

Dependency precision/recall compares the declared/observed answer closure with
the annotation's transitive task closure. Python follows answer bindings through
runtime script-block reads. Native follows declared answer-root operators and
their graph/definition origins. Exploratory inspections are excluded.

All four Luna dataflow answers omit explicit answer-root declarations, leaving
computational lineage unknown. Terra's declared graph has low annotation recall
because large callbacks copy inherited calculations instead of referencing
earlier graph outputs. Python's conservative block parents record broader
closures. These granularity differences prevent treating higher agreement as
proof of a better or uniquely correct algorithm.

Deterministic answer diagnostics separately score identities, requested values
and order, with explicit label/nested-field adapters. Q14 requires rank movement
and recovery. Q24's primary diagnostic checks requested market selection/order;
optional reported rank/recovery details are audited separately. Q28 ranks can be
represented by list order. Configured and selected-reference coverage are saved;
these partial scores are not the official LongDS metric.

## Cost, latency and infrastructure

| Spending component | USD |
| --- | ---: |
| Three primary prefixes, estimated | 4.65420 |
| All 24 probes, estimated | 0.55927 |
| Invalid initial Python setup runs, estimated | 2.60263 |
| All solver work, estimated | **7.81610** |
| Judge usage receipts, 149 requests including setup judgments | **0.32321** |

Solver rates were frozen at Terra $2/$0.20/$12 and Luna $0.20/$0.02/$1.20 per
million input/cached-input/output tokens. They are estimates, not invoices.
The initial invalid disciplined run stopped after 25 observed turns; its missing
observer state stays unknown. Its paid work is included.

Charging each primary prefix once across eight probes gives condition-level
estimated prefix-plus-probe cost per probe of $0.31488 for dataflow, $0.15055 for
ordinary Python and $0.18625 for disciplined Python. This hypothetical
amortization excludes invalid setup/judging and does not remove fixture-quality
confounding.

| Condition / model | Model calls | Solve wall time, four probes | Successful replay/setup wall time |
| --- | ---: | ---: | ---: |
| Ordinary / Terra | 15 | 60.7 s | 113.2 s |
| Disciplined / Terra | 14 | 62.0 s | 190.8 s |
| Dataflow / Terra | 15 | 141.1 s | 1,075.7 s |
| Ordinary / Luna | 18 | 63.9 s | 112.5 s |
| Disciplined / Luna | 16 | 69.4 s | 191.4 s |
| Dataflow / Luna | 16 | 143.2 s | 1,081.2 s |

Replay timing is approximate artifact-timestamp timing, measured separately.
Fresh native agents replay old actions to exclude future state, and that setup
is expensive. It is not the per-turn cost of an uninterrupted natural session.
The failed unpaid Terra Q28 setup adds further time outside the successful
replay totals.

Both approaches used provider caching: cached-input fractions range from 71%
to 88% across the six groups. Dataflow's larger prompts, graph work and generated
code outweigh caching here. Exported observer bytes are not kernel/engine RAM;
native bounded observations and Python complete tables cannot establish a fair
memory comparison.

The Q28 setup failure occurred after the server completed an unpaid debug
action, while the client waited for an optional context preview. The RPC now
accepts completion directly and can confirm the same request via an idle agent
with a changed head, without resubmitting uncertain edits. That unpaid setup
was retried; **the Q28 solver still had one paid attempt**. All owned probe
agents, workflows and computing units were cleaned up.

## Verification and next decision

Verification: 1,380 Bun tests passed before the final RPC correction; its four
new regression tests pass; typecheck passes; 28 new Python tests pass. Real
kernel/engine checks cover persistent copies, alias mutation, script retrieval,
large receipt transport, fork/restore semantics and future-task exclusion.
Preparation now selects v1.1 Lite explicitly; general benchmark-driver migration
is not claimed complete.

The next useful work is to expose complete reusable working tables as native
operator outputs, improve answer-root coverage, and implement an explicit reader
for historical full materializations if we want computation reuse. These are
framework changes that make the state advantage measurable; more prompt examples
alone will not recover unpublished local variables.

Any next controlled run should reuse these four questions only after reusable
checkpoint anchors pass alignment checks, and report ordinary Python's natural
retention honestly. No additional paid campaign or full Lite run was launched.

The subsequent prompt/catalog revision keeps initial file inventories to paths,
asks agents to discover samples themselves, and adds saved result metadata without
sample rows to both catalogs. Dataflow statistics were already enabled for this
pilot. These later changes have only local verification so far; the original
24 solver results and their costs remain unchanged. Candidate discovery is
restricted to the [v1.1 Lite list](lite-state-retrieval-candidates-20261005.json);
annotated rollback questions are not proof of an overwritten kernel value.
Local verification of that revision passes 1,390 Bun tests, 38 relevant Python
tests, TypeScript checking and a real persistent-kernel metadata smoke. These
checks and the Lite search made no paid model calls.
