<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Prototype adjustments for the LongDS Lite state study (2026-10-05)

This note lists the changes to the current prototype (the ReAct agent with
`inspect`, `edit`, `execute`, `retrieve`, `answer`; saved task versions; the
per-task operator catalog) that align it with what LongDS Lite rewards, and
the shortest sequence of runs that shows whether the claim holds. It builds on
[prior-task-operator-catalog-design.md](prior-task-operator-catalog-design.md)
and the [findings](findings-and-plan-2026-10-03.md); nothing here starts a
paid run by itself.

> **2026-10-06:** the state mechanics in sections 3 and 4 (fork, `update … from task N`, `inspect task`/`state`) are superseded by
> [state-versions-design-2026-10-06.md](state-versions-design-2026-10-06.md): references `operator@N`, no fork, one `read` action,
> a `diff` operator, and the boundary receipt. Section 5 (measurement) and the decision rules stay in force.

## 1. What we are trying to show

Read through its reference solutions, Lite rewards one skill: keep every rule
version addressable and pick the right one when a request names it. The gold
programs re-read raw files on 5% of later turns, read a variable defined ten or
more turns earlier on 68% of them, redefine 9% of their names, and at Rollback
turns read the dependency's variable rather than recompute it. Requests name
versions in the session's own words ("the strict screen", "the early value
view"), never by turn number, and an Update is the new default without saying
so.

The claim worth testing is therefore not "more accurate" or "cheaper per turn"
with the best model. It is: **in the dataflow, version selection, propagation
of a revised rule and isolation of a temporary one hold by construction, so
the state error rates do not move with the model; in a kernel they depend on
the model's discipline.** Four per-turn checks, scored against the reference
replay, measure that: wrong-version rate at Rollback turns, stale-rule rate on
dependents of Updates, leakage rate after Counterfactuals, and state match
after each change.

Everything below either makes the dataflow able to exhibit those properties
(it cannot propagate through a graph that has no rule operators), makes them
measurable, or removes a confound that decided earlier runs.

## 2. What stays

The ReAct loop, the five actions, the operator catalog and `process`, saved
versions with `inspect target=state`, `fork operator … from task N as …` and
`update operator … from task N`, per-task catalog entries in the agreed
operator-block format, immutable prior-task frames, the Python-with-catalog
baseline, the LongDS binary judge as a secondary score. No ledger, no input
cap, no compaction.

## 3. Mechanical changes, in order of effect per day of work

| # | change | why | how it is verified |
|---|---|---|---|
| 1 | **Answer sources are required in multi-task sessions.** A free-text `answer` without `operator_ids` is rejected with one line: name the completed tables the answer rests on, or pass `[]` when it uses none. `answer` with `from` already records them. | In the pilot, Luna declared sources on 0 of 4 probes, so lineage was unknown and the catalog had no `answer source` markers. Every later metric (lineage precision, wrong-version) reads these. | unit test; lineage coverage in the next run |
| 2 | **`answer` with `from` takes a cut: `scores top 5 by score`** (optional `asc`). The runtime sorts and cuts; the recorded source is the full table. | Reports stop needing `limit` operators that later tasks mistake for populations (the restaurants-8 and Q13 failures). The working table is the answer source. | unit tests; share of answers using it |
| 3 | **A `process` that returns fewer rows than its single input gets a mechanical line** in execute receipts and catalog blocks: `note: returned 8 of 1,898 input rows.` No advice attached. | The two Netflix pilots lost working tables inside callbacks that returned a report. This makes it visible at the moment it happens and in every later catalog. | unit test; count of such notes per session |
| 4 | **Fork copies are named `root__<base id>`**, where the base is the original operator at the end of the origin chain, not the previous copy's name. The mapping keeps exact origins. | Lite prefixes reach fork depth 8; mean fork ID 76 characters; 7k of a 109k catalog is input lines. | unit test; catalog size on the Netflix prefix |
| 5 | **Compact catalog variant** (`catalogDetail: "compact"`): full blocks for answer sources and for operators whose state is `updated`, `restored` or `forked`; one line for everything else (`id (kind, created) ← inputs · rows × cols`). Default stays `full`. | The full catalog is 109k characters for 27 tasks, 2.4× the Python catalog. Rule changes and answer sources are the lines that matter for version selection. | render both on the Netflix prefix; run both in the first paid comparison |
| 6 | **File inventory shows each file's header line** in the first request, for both agents. Harness change, not prompt. | Both 10-05 Netflix pilots were decided at Q1 by whether the agent opened `multiTimeline.csv`, whose name does not say "United States". | preflight prints the inventory; Q1 market count on Netflix |
| 7 | **Arm settings for the study:** `taskContext: dependencies`, `stateHistory: true`, `stateLedger: false`, `catalogStatistics: true`, `catalogRecords: 0`, `retrievalViews: [sample_stats, full]`, flow evidence off, no input budget, `maxSteps 40`, 8k output. Terra and one cheap model, `reasoning_effort` recorded. | One frozen configuration; the DSGym control uses the 2026-09-27 shared prompt plus the catalog. | settings saved with every run |

Items 1–4 are a day together. Item 5 is half a day given the existing
renderer. Item 6 is an hour.

## 4. System prompt

The multi-task material is currently 28k of the 47k-character history prompt:
`native-multi-task.md` (4.3k), `native-state-history.md` (8.6k) and three
examples (15k). It is rewritten around the three gestures a Lite request can
ask for, in the benchmark's vocabulary, and cut to about 9k. The single-task
prompt is unchanged.

### 4.1 `native-multi-task.md` (replaces the body)

```
### Earlier tasks in the session

The dataflow persists across tasks. Each request is a task, numbered from 1;
answering a task saves the dataflow as it stands under that number, and later
requests build on what remains.

Earlier tasks appear under `# Prior Tasks`: each task's request, the operators
it created or changed with their definitions, inputs and result shapes, its
answer, and the tables the answer was declared from. Earlier answers are the
earlier agent's output, not verified facts; check a definition before relying
on it.

A session revises its rules as it goes. Read each request for which of three
things it asks.

- **A rule changes from here on.** Update the operator that defines it.
  Everything built on it recomputes on the next execute, so later tasks read
  the revised rule without further work. Do not build a second copy beside the
  old one; the old version stays saved under its task number.
- **An alternative applies to this question only.** Compute it on its own
  branch and leave the default untouched: fork the saved version, or build the
  variant beside the current operator, and answer from the variant. The next
  task continues from the default.
- **The request names an earlier version** ("the strict screen", "the
  first-pass scores", "before the penalty"). Find the task that introduced
  that rule in the prior-task entries. Read its saved result with `inspect`,
  fork it to compute with it next to the current version, or update from it
  when the session returns to that rule for what follows. Do not retype an
  earlier rule or its numbers from memory.

Name rules the way requests will refer to them. An operator's `doc` is how a
later task recognizes a version in the entries, so write it as the rule it
implements ("markets with at least ten cleaned orders"), not as a step
("filter rows").

Keep the table that holds every unit under the current rules apart from the
table that reports a selection of it. Rank and cut in the answer (`from:
"scores top 5 by score"`) or in a downstream operator, not inside the operator
that computes the scores. A later task that needs all units, or a different
cut, then has them. A process that returns a selection hides the rest.

Before connecting an earlier table, read its definition and shape: is it every
qualifying row, an earlier answer's selection, or an older version of the
rule? When the request concerns a selection, keep it; when it concerns every
row, connect the table before the cut.

Declare what an answer rests on. `answer` with `from` records its source
tables; a free-text answer names them in `operator_ids`. Later tasks start
from those tables.
```

### 4.2 `native-state-history.md` (shortened)

Keep: the paragraph on what a prior-task entry contains and the catalog
conventions (one block per changed operator, bodies on request, collapsed fork
copies, `answer source` marker, `version at end of task N` on references); the
capability table for `inspect target=task`, `inspect target=state`, `fork`
and `update … from task N`; the two semantic facts a model gets wrong without
being told: a fork copies definitions and recomputes when executed (saved
observations are readable without executing), and a restore puts an old
definition on today's inputs (the receipt names inputs that changed since).
Keep the sentence that going back never removes a version.

Drop: the duplicated explanations of answer-root selection, candidate reads
and graph-inspection scoping (one sentence each in the table suffices), the
statistics paragraph (the summary format is self-explanatory), and the
closing paragraph that restates the three gestures already in 4.1.

Target 2.5k characters.

### 4.3 One example session instead of three

Replace `native-example-tasks.md`, `native-example-revise.md` and
`native-example-history.md` with one five-task session on the existing toy
fixture, receipts generated from the live engine as now:

1. build the working table and answer the top three with `from: "score top 3 by amount"`;
2. a rule changes from here on: `update operator eligible`, execute, answer from the recomputed table;
3. an alternative for this question only: fork, compute beside, answer from the fork; the next task shows the default unchanged;
4. the request names the first version: locate it in `# Prior Tasks`, `inspect target=state`, fork and join with the current table for the comparison;
5. the session returns to that rule: `update operator eligible from task 1`, execute.

About 6k characters. Each step shows the receipt lines the model must read:
`results invalidated`, `forked from task 1`, `restored from task 1`, and the
catalog entry the step produces.

## 5. Measurement

### 5.1 The four checks

All four score against the reference replay (`numeric_gate.run_turns`,
`gold_state.replay`), which keeps every version under its own name, so each
variant needed below exists in the oracle namespace. No LLM judge is involved.

| check | where | definition | coverage reported |
|---|---|---|---|
| **wrong-version** | the 138 Rollback turns | the answer's lineage (declared sources and their upstream tasks; for Python, the variables the final script read and their defining turns) contains no table from the version's task, and the number set matches neither the gold nor is judged correct | turns with resolvable lineage |
| **stale-rule** | dependents of the 198 Updates | V_new from the normal replay to the dependent; V_old from the replay with the Update's cell skipped; the answer's numbers match V_old | dependents whose skip-replay runs; uninformative when V_old = V_new |
| **leakage** | the first default-state dependent after each of the 123 Counterfactuals | the agent's default table matches the oracle's temporary variant rather than the default, by content alignment; or the answer's numbers match the variant | turns with a captured table or distinguishable numbers |
| **state match** | after every Update and Rollback | oracle frames whose digest changed at that turn and are read later; agent table found by row count and column value digests regardless of names | frames read later |

Captures needed: for the dataflow, every materialized result at task end and
the execution stats (export, already stored); for the kernel, a pickle of each
DataFrame after each turn plus `read_*` and `open` logging in our executor.
Validation before any agent is scored: the reference replayed as an agent
scores 0 on all four; a replay with an Update cell skipped scores 100% stale on
its dependents; a copy with renamed and reordered columns still aligns.

Dependency precision/recall against the annotated closure, work per turn
(bytes read, rows, engine or kernel seconds), tokens and cost stay as
secondary measures.

### 5.2 Fastest path to a first number

Day 0, no paid calls: run the stale-rule and wrong-version checks on traces we
already have for Lite sessions. The Netflix task-3 prefixes (dataflow and both
Python conditions, Terra, 27 turns each), water-potability task 1 (ForkLedger
and DSGym, Luna, 31 turns), and the three Lite sessions in the 12-session
campaign (LearnPlatform task 3, derby, march madness; three reps, both arms).
State match and leakage need the new captures and wait for the next run. This
validates the scorer on real answers and gives the first per-arm rates.

Days 1–3: items 1–6 of section 3, the prompt of section 4, the scorer with its
three validation runs. Regenerate the catalog for the Netflix prefix in both
variants and record sizes.

Days 4–5: one rep of three rule-evolution sessions (Netflix task 2, Kiva task
1, water potability task 1; 105 turns) × two agents × Terra and the cheap
model. Terra at about $0.10 per turn and the cheap model at a tenth of that is
roughly $25 for all four arms. Report the four checks, the shape audit (share
of rule changes applied in place; share of tasks reading a working table rather
than the scan; process operators returning fewer rows than their input) and
cost. This is the point to decide whether the full design is worth running.

Then: the 11 rule-evolution sessions as the primary cohort, the 4 accretive
sessions as controls, three reps.

### 5.3 Decision rules, written down before the run

- At Terra, the two agents are expected to be close on all four rates. A large
  dataflow deficit there means the shape or the prompt is wrong, not the thesis.
- At the cheap model, the kernel's rates are expected to rise and the
  dataflow's to stay near Terra's. If the dataflow's rates rise as much, the
  "by construction" claim is false and the study should say so.
- If in-place updates stay below half of the rule-change turns in the shape
  audit, the mechanics of section 3 did not change behaviour and the next step
  is a stronger mechanism, not another prompt revision.
- Cost is reported, not optimized, in this round; the compact catalog is the
  only cost intervention and it is measured as a variant.

## 6. Probes beyond Lite, labelled as ours

Three per session, generated from the metadata and scored by replay, where
the dataflow is better by construction and the kernel has no mechanism: a
provenance question at the end ("which rule versions does the last answer
rest on"), a restore request ("put the screen back to its task-4 definition
and recompute the current top five"), and a refresh (append 3–5% of rows to
the inputs, replay the reference for the new gold, ask for the current
answers). These are additions, reported separately from the Lite score.
