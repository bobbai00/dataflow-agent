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

# Was the Terra drop a regression? Cascades, and how updates are written, 2026-10-07

Three questions followed the validation run of the trimmed prompt
(`080acaa9f`), where Terra scored 82 of 185 against 101 in the scale-5 run:

1. Is the drop the prompt or run-to-run noise?
2. Mistakes cascade. Can the agent be told not to build on a computation it
   thinks is wrong?
3. Updates are never applied to the existing chain. What does that mean, and
   what should we do about it?

## Verdict

1. **Noise.** Rerun side by side, the old prompt scored 79 and the new one
   81. One 5-session Terra total moves by about 11 questions from run to run
   with nothing changed.
2. **The instruction is already in both prompts and never fires.** The agent
   has no signal that an earlier table is wrong. Asked directly to review a
   finished turn, Terra flags 30% of its wrong answers and 11% of its right
   ones. Two silent hazards in our own system produce such mistakes and are
   cheap to remove.
3. **Writing updates alongside is how everyone solves these sessions**: our
   agent, the Python baseline, and the benchmark's reference program. It is
   not where accuracy is lost. When the answers a rollback or mixed-version
   request depends on were right, Terra got it right 33 times of 39.

## 1. The drop from 101 to 82

### Runs

"Old" is the agent code of the scale-5 run (`ebd2261cd`, identical under
`agent-service/src` to `488f0f817`); "new" is `080acaa9f`. The second runs
were made together, on the same sandboxed engine, the old code served from an
export on a second agent service. Dataflow only, the five scale-5 sessions,
one attempt per question, same judge.

| Terra, correct of 185 | Kiva (37) | Netflix (34) | NFL (42) | Marmara (36) | WiDS (36) | Total | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Old, run 1 (scale-5) | 23 | 10 | 29 | 23 | 16 | **101** | $10.30 |
| Old, run 2 | 13 | 7 | 23 | 10 | 26 | **79** | $10.16 |
| New, run 1 (validation) | 17 | 10 | 20 | 24 | 11 | **82** | $10.63 |
| New, run 2 | 16 | 10 | 24 | 19 | 12 | **81** | $10.33 |

| Luna, correct of 185 | Kiva | Netflix | NFL | Marmara | WiDS | Total | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Old, run 1 | 3 | 3 | 16 | 16 | 9 | **47** | $1.35 |
| Old, run 2 | 2 | 7 | 7 | 12 | 6 | **34** | $1.29 |
| New, run 1 | 7 | 7 | 16 | 6 | 12 | **48** | $1.35 |
| New, run 2 | 13 | 2 | 5 | 3 | 6 | **29** | $1.39 |

### How large the noise is

The same version, run twice, differs on one session by up to 13 questions
(old Marmara 23 and 10, old WiDS 16 and 26). Pooled over sessions and
versions, one session's score has a run-to-run standard deviation of 4.8
questions for Terra and 4.2 for Luna, so a 5-session total has about 10.7 and
9.4.

| | Old, mean of 2 | New, mean of 2 | Difference | Standard error | Permutation p |
|---|---:|---:|---:|---:|---:|
| Terra | 90.0 | 81.5 | −8.5 | 10.7 | 0.49 |
| Luna | 40.5 | 38.5 | −2.0 | 9.4 | 0.89 |

The permutation test exchanges the version labels within each session
(7,776 arrangements). Two single runs of the same code differ by 19 or more
about one time in five.

Two runs per version cannot rule out an effect of ten questions either way.
Getting the standard error of the Terra difference down to 5 would take
about nine runs per version. Whole-session totals are a blunt instrument for
comparing prompts, because one early mistake moves ten later answers.

### Fresh mistakes: same rate, largely the same turns

A fresh mistake is a wrong answer on a question whose direct dependencies
(the earlier questions the benchmark says it builds on) were all answered
right in that run. This is the part of the score a prompt can influence
directly; the rest is inherited.

| Wrong among questions with right dependencies | Old run 1 | Old run 2 | New run 1 | New run 2 | Old pooled | New pooled | Fisher p |
|---|---:|---:|---:|---:|---:|---:|---:|
| Terra | 11 of 53 | 10 of 54 | 11 of 45 | 14 of 52 | 19.6% | 25.8% | 0.32 |
| Luna | 9 of 17 | 6 of 12 | 12 of 25 | 12 of 21 | 51.7% | 52.2% | 1.00 |

In the first pair of Terra runs, 6 of the 16 questions with a fresh mistake
are the same question in both versions. Several fail in every run we have of
any arm (Marmara 5 and NFL 12: 0 of 8 dataflow runs, 0 of 2 Python runs).

### What the prompt change did change

One behaviour moved with the version in both runs and both models, and it
is the intended one: data loading.

| Per 185 questions | Old 1 | Old 2 | New 1 | New 2 |
|---|---:|---:|---:|---:|
| Terra: raw-line previews (`scan(..., preview=n)`) | 40 | 38 | 5 | 2 |
| Terra: reads as `sample_stats` | 37 | 45 | 69 | 63 |
| Terra: model calls | 645 | 637 | 650 | 638 |
| Terra: failed tool calls | 5.0% | 4.7% | 6.5% | 5.0% |
| Luna: raw-line previews | 24 | 18 | 8 | 12 |
| Luna: failed tool calls | 9.1% | 9.5% | 13.6% | 12.2% |

First-question accuracy did not move (Terra 5, 5, 5 and 4 of 5; Luna 2, 3, 3
and 2 of 5; the one Terra miss left `loan_count` out of the answer).

Luna's failed calls did rise in both reruns. Questions with a Python runtime
error inside a function went from 28 and 24 to 37 and 45 of 185, mostly
`KeyError`s on column names, about half of the increase in one session
(Marmara). It does not show in Luna's fresh-mistake rate or totals, and its
cause is not identified. Terra shows nothing similar (12, 14, 14 and 13
questions).

Other counts that looked different after one run did not repeat: Luna's
`rank_change` uses were 19, 26, 0 and 15, statements per run 839, 813, 1,052
and 879 for Terra. How updates are written did not change at all (section 3).

### The mistakes behind the first drop

Each fresh mistake of the first pair of Terra runs was diagnosed from the
request, the reference program, the agent's code and the judge's finding
(22 dossiers, five independent readers; `classify-*.jsonl`).

| Cause | Count | Examples |
|---|---:|---|
| Request under-specified, or the judge stricter than the text | 6 | Marmara 2 (names of reported fields), Marmara 5 (an unrequested rank), NFL 41 (how "overstatement" is measured), Netflix 3 (does a market exactly on the median count) |
| Tables right, reported answer wrong | 5 | NFL 12 in both versions (a four-way tie decided by 1e-16 of float noise; the reference rounds the sort key to 12 digits), NFL 8 (leaders over all players, not the reliable ones), WiDS 4 (sign of a gap) |
| A stated rule misread or left out | 5 | WiDS 5 (medians over all 3,193 records, 51 state rows included, where the convention says county rows), Kiva 13 new (ranked a share the convention uses raw), Netflix 2 in both versions ("shortlist" read as the five shown, not the eight carried forward) |
| Built on the wrong earlier table | 3 | Netflix 4 in both versions (compared against the five-row display table), Kiva 13 old (joined to the population before question 12's narrowing, which question 12 had never built as a table) |
| Coding slip | 1 | NFL 14 (`int((lt > 0) + (rt > 0))` on NumPy booleans is 1, so every team got the one-side penalty) |
| Not fresh after all (a dependency passed the judge with wrong values) | 2 | Kiva 19 new, NFL 25 old |

None of the mistakes that are specific to the new version touches the text
the prompt change edited (state forms, loading, records and statistics
wording): a `>` where the old run happened to write `>=` (Netflix 3), a
reporting choice (NFL 8), a NumPy slip (NFL 14), a share ranked instead of
used raw (Kiva 13). The two versions wrote NFL question 8 almost line for
line the same; the new run then added one extra ranking over all players.

## 2. Cascades

### How a mistake spreads

Terra, four runs, the 720 questions that have dependencies:

| | Right |
|---|---:|
| Dependencies all answered right | 139 of 184 (76%) |
| A dependency answered wrong, and the answer is built on that task's tables | 161 of 488 (33%) |
| A dependency answered wrong, its tables left out | 24 of 48 (50%) |

When a dependency was wrong, the agent built on that task's tables 91% of
the time (Luna 90%, and 18% right). Reuse is the channel. In the first new
run, 13 later Kiva questions built on question 23's population table and one
was right; in the first old run question 23 was also wrong, but it had
produced only a report of the lost rows, no later question built on it, and
10 of 14 were right. The better-structured state spread its mistake further.

The agent never revisits. Its stated reasoning uses "repair" or "verify" in
about 75 of 185 turns, each time for the current turn after an execution
error or to confirm a result it just produced. In 1,480 turns (four runs, two
models) it did not once question a table from an earlier task; it reassigned
an existing table in 0 to 3 turns per run.

### The prompt already says it

Both versions contain, in the multi-task section: "Earlier answers,
docstrings and dependency links are unverified evidence. Before reusing an
earlier table, read its definition, inputs and shape [...] When an earlier
task was wrong, correct the rule in place rather than trusting its answer."
The agent does read earlier definitions before reuse (about 100 reads with
code per 185 questions). It has permission to distrust and no reason to: the
mistakes are silent.

### Asked directly: a review probe

For questions whose dependencies were right, the finished conversation was
replayed to Terra (same messages, nothing hidden) with one more user message
asking it to check each rule of the request and the standing conventions
against the tables it built, and to reply `correct` or `suspect` with a
confidence and the most likely defect. 91 turns from the four runs, no tools.

| | Reviewed | Flagged suspect | Mean stated confidence that the answer is right |
|---|---:|---:|---:|
| Answers judged wrong (fresh mistakes) | 46 | 14 (30%) | 0.84 |
| Answers judged right | 45 | 5 (11%) | 0.93 |

Fisher p = 0.04. The review separates wrong from right, weakly. For the
first pair of runs the flags can be checked against the diagnoses: of 6
flags on wrong answers, 3 name the true defect (the all-records median in
WiDS 5, the penalty on every team in NFL 14, the median cut in Netflix 3)
and 3 name something else. WiDS 5 and NFL 14 are the two costliest mistakes
of the first new run: 31 and 26 later questions were built on those tables,
7 of each answered right. The review missed Kiva's (`correct`, 0.96).

A review call costs about 25,000 input tokens, cached in flow, and 390
output tokens: about one cent per turn on Terra, 18% on top of a run.

The diagnoses mark 13 of the 22 mistakes as visible at the time to a careful
reviewer without the reference (a count, a value in the result that was
read): a 155-row result for an "up to ten" question, `one_side = true`
beside a side imbalance of 0.34, five sector rows where the request names
eight. And 13 of 22 sit in a table that later questions could build on.

### Two silent hazards of our own

- **Join name collisions.** In the first new Kiva run, question 18 joined
  two tables that both carried `partner` columns. The engine kept the left
  ones and renamed the real ones `partner_right`; the receipt listed 16 of
  83 columns and said nothing. A later `distinct` on the wrong `partner`
  dropped 5 of 22 matches, among them the two partners every later answer
  was missing.
- **Column lists cut at 16.** An entry for a wide table shows its first 16
  columns and "+N more". In NFL question 18 the request needed `x_o`, column
  39 of 40 of a scan made the question before; both versions built their
  own orientation flip instead, which cancels inside an absolute difference.

Both exist in both versions. Each is a mechanical fact the receipt can
state without a false positive.

### What to try, in order

1. Say in a join's receipt which column names exist on both sides and what
   the right-side copies are called; list every column name of a table once
   where it is created (names without types for the tail).
2. A review step run by the harness, not left to the agent: before the
   answer of a question is recorded, ask the review question; on `suspect`
   the agent repairs the table under its own name, so the engine recomputes
   everything built on it, and answers again. This is the one place where
   changing a table in place is the right operation, and where a dataflow
   has an advantage over a script: the engine knows exactly what was built
   on the repaired table. Expected from the probe: about three in ten fresh
   mistakes flagged, one in nine right answers flagged, 18% more cost. The
   false flags are the risk; it needs one run to see whether repairs of
   right answers break them.
3. A second, independent derivation only for the few tables with the most
   dependents (the cleaned table, the population, the main score), compared
   with `diff`. Across the four Terra runs, of the 27 questions whose
   dependencies were right every time, 15 were right in all four, 11 in
   some, 1 in none: most fresh mistakes are run-specific, which a second
   derivation can expose; the ones every run makes it cannot.

What none of these reaches: mistakes every run makes, and questions where
the reference asks for something the request does not say.

## 3. Updates written alongside

### What it means

When a request changes the analysis from then on, the agent does not change
the table everything else reads. It builds new tables next to the old ones.
Kiva question 23 ("restrict the recommendation population to countries with
complete data"): the first new run created `complete_evidence_final_matches`
and three more tables; `distinct_final_concentration_matches`, which every
earlier top-ten was built on, stayed as it was, and question 24 then built
`complete_evidence_final_top10` as a new table too.

| Update questions written only as new tables | |
|---|---:|
| Dataflow, Terra, 4 runs | 112 of 112 |
| Dataflow, Luna, 4 runs | 110 of 112 |
| Python baseline, Terra (scale-5) | 23 of 23 |
| Python baseline, Luna (scale-5) | 24 of 25 |

`name = name@N` (restore) was written 0 times in all eight dataflow runs.
Terra's Python sessions end with 164 to 232 DataFrames, 4 to 11 of them
changed after the question that made them. The benchmark's reference program
for Kiva assigns 164 top-level names and touches none of them in a later
question: a lasting change gets a new name (`country_sector_region_tight`,
`complete_partner_final`).

So this is the natural way to write these sessions, for a person too. The
earlier statement that this is "where the state work is worth spending" was
wrong.

### It is not where accuracy is lost

Terra, four runs, by request kind:

| | Dependencies right | A dependency wrong |
|---|---:|---:|
| Initial | 54 of 61 (89%) | 46 of 131 (35%) |
| Update | 43 of 65 (66%) | 35 of 123 (28%) |
| Counterfactual | 28 of 39 (72%) | 28 of 89 (31%) |
| Rollback or mixed versions | 33 of 39 (85%) | 76 of 193 (39%) |

Rollback and mixed-version requests are answered as well as first builds
when the state they stand on is right. Of 232 such requests, 193 stood on a
wrong answer. The loss is in section 2.

One cost of the style is measurable. In 57% of Terra's questions with
dependencies, the answer is not built on the tables where a lasting change
it depends on was made: it re-creates the change, or uses another table.
Those are right 34% of the time against 62% (not a causal comparison). Kiva
13 old is the clear case: question 12 narrowed the population but built only
the removed rows, so question 13 joined to the population before it.

### What follows for the mechanisms

- `name@N` only differs from `name` if `name` changes, and it never does.
  Saved versions and restore have nothing to do in these sessions.
- What the later requests do is recombine. The Kiva reference annotates each
  question with its mechanism: 12 of 35 take one component from an earlier
  stage and keep the rest current ("partial rollback of funding component
  only", "old formula with current sample"), 4 more combine one-off
  branches. It re-types the downstream formulas each time (four of them in
  question 27).
- A lasting change should leave the new standing table behind as a table,
  not only the comparison the question asks for.

### Related work

- **Multiverse analysis** (Steegen et al., 2016; Boba, Liu et al., VIS
  2020; the `multiverse` R package, Sarma et al., CHI 2023): one analysis
  with named decision points and options, evaluated for chosen
  combinations. A LongDS session is one built interactively: an update
  moves a default option, a counterfactual or partial rollback evaluates
  another combination.
- **Alternatives in notebooks** (Variolite, Kery et al., CHI 2017; Fork It,
  Weinman et al., CHI 2021; code gathering, Head et al., CHI 2019): analysts
  keep alternatives side by side; the tools index them and recover how a
  result was made.
- **Dataflow notebooks and stale state** (Koop and Patel, TaPP 2017;
  nbsafety, Macke et al., VLDB 2021): lineage to flag results computed from
  definitions that have since changed, which is what a repair in place needs.
- **Versioned workflows** (VisTrails, Callahan et al., SIGMOD 2006; Vizier,
  Brachmann et al., CIDR 2020): every edit of a workflow is a version, and
  parameter exploration shows variants side by side.
- **What-if over history** (Mahif, Campbell et al., SIGMOD 2022): "what
  would the current result be had an earlier update been different",
  answered by replaying only the affected part.
- **Limits of self-correction** (Huang et al., ICLR 2024; Tyen et al., ACL
  Findings 2024; Zhang et al., ICML 2024): models rarely find their own
  mistakes unprompted, correct them when shown where, and recognise more of
  them in a separate pass. Independent versions also share mistakes more
  often than independence predicts (Knight and Leveson, 1986).

## Material

- Runs: `/var/tmp/versions-scale5-20261007` (old 1),
  `/var/tmp/versions-retired-run-20261007` (new 1), and `old-r2`, `new-r2`
  under `logs/regression-study-20261007/` in this worktree, with the old
  code export, both prompts as sent, the 22 dossiers, the classifications
  and the probe outputs.
- Analysis scripts: `logs/regression-study-20261007/analysis/`.
- New spend: $23.17 for the two reruns, $1.65 judging, $3.93 the probe.
