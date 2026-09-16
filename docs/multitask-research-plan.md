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

# Multi-task research milestone: correct reuse and updates

Research date: 2026-09-16. The measurement milestone and development pilot are
now complete; see the [implementation and results report](../agent-service/benchmark/multiturn/STATE_MILESTONE_REPORT.md).
The candidate improved controlled state preservation but did not beat CodeAgent
on overall accuracy or cost. The larger matrix remains gated on addressing
changing-context cost, answer contracts and reference-environment parity.
The sections below preserve the research design and proposed expansion.

## Recommendation

Expand evaluation along two tracks: complete real analytical sessions, and
controlled sessions that distinguish specific state mistakes. Measure which
requested results remain correct after a change, which earlier results remain
fixed, and the model effort needed to achieve both.

The hypothesis is that explicit executable dependencies can reduce repeated
model reasoning about the state of a session. Historical retention is one part
of that hypothesis. Correct selection of reusable calculations and propagation
of changed assumptions are equally important. A code agent can implement these
behaviors too; the experiment must measure the benefit of providing them in the
runtime.

## 1. What the existing evidence does and does not cover

The [latest controlled study](../agent-service/benchmark/multiturn/TASK_CACHE_LIVE_REPORT.md)
reports 38/45 correct Dataflow task instances versus 43/45 for CodeAgent, across
three executions of one 15-task real-data session. The cache fix reduced model
cost by 19.7% relative to the Dataflow control, with the same aggregate accuracy.
The real session used no task-qualified historical inputs. It remains a useful
regression case, but provides little direct evidence about historical retention.

The local LongDS inventory gives us a much broader pool:

| Local inventory | Count |
| --- | ---: |
| Sessions with task text and metadata | 68 |
| User requests across those sessions | 2,225 |
| Domains | 6 |
| Sessions with at least one Update annotation | 66 |
| Sessions with at least one Rollback annotation | 56 |
| Sessions with at least one Counterfactual annotation | 56 |
| Sessions with a nonempty local data directory | 48 |

These are overlapping annotation counts. Data presence does not establish
completeness, executability, or numeric reproducibility. The GitHub session has
15 requests, 12 Initial annotations, and no Update, Rollback, or Counterfactual
annotations. Its remaining requests have no state-type label; this does not mean
they have no dependencies.

The [inventory](../agent-service/benchmark/multiturn/multitask-research-inventory.json)
includes all session names, pattern counts, normalized dependency spans and
breadths, source hashes, and data-presence checks. It is evidence for selection,
not a new leaderboard. Existing experiment exposure still needs auditing before
any session can be designated held out.

## 2. Lessons from research

| Source | Relevant finding or method | Application here |
| --- | --- | --- |
| [LongDS-Bench](https://arxiv.org/html/2605.30434v1) | Distinguishes context-memory, state-management, and cascade errors. It supplies executable reference answers and dependency annotations; more steps did not consistently improve results. | Separate wrong input selection from wrong calculation and inherited errors. Run complete sessions and stratify by dependency distance. |
| [AgentBoard](https://arxiv.org/html/2401.13178) | Uses intermediate progress measures to reveal differences hidden by final success rates. Its progress measure can retain the highest previously achieved match. | Check named analytical requirements individually. Measure their current validity after each change, because a previously correct result can become wrong. |
| [Tau-bench](https://arxiv.org/html/2406.12045) | Evaluates observable database outcomes and repeated-run reliability through pass^k. | Score equivalent results across architectures, and report success on all three repetitions rather than best-of-three success. |
| [AI Agents That Matter](https://arxiv.org/abs/2407.01502) | Argues for joint cost/accuracy evaluation, meaningful holdouts, and standardized reporting. | Keep failed-run spending, isolate cache effects, and split development/evaluation by dataset and task structure. |
| [DSAEval, September 2026 revision](https://arxiv.org/html/2601.13591v3) | Provides 641 problems over 285 datasets, persistent multi-query workflows, and separate reasoning, code, and result assessments using judges. | A later source of broader tabular workflows and report-quality evaluation. Deterministic numerical/state checks remain the primary authority for this milestone. |

The experimental choices below are our proposal, not findings established by
these papers. In particular, their results do not establish a Dataflow advantage.

## 3. Test suite design

### Track A: complete real sessions

Target 12 LongDS sessions, two per domain, balancing analytical difficulty,
state patterns, and data size. Start with six development candidates below,
one per domain. These were selected from metadata and task inspection, without
selecting on a new agent's score.

| Domain | Development candidate | Requests | Why include it |
| --- | --- | ---: | --- |
| Business | `netflix_movies_and_tv_shows/task1` | 36 | Temporary rankings; old title matching combined with newer scoring; reuse beyond displayed top-five results. |
| Community | `kaggle-survey-2022/task3` | 37 | An Under-30 cutoff becomes Under-35, followed by a temporary return to the old definition. |
| Education | `world_university_rankings/task2` | 21 | Different populations and missing-value rules for different statistics; a useful lower-complexity comparison. |
| Geoscience | `water-potability/task3` | 36 | Earlier populations combined with later transformations and sensitivity checks. |
| Social good | `center_for_policing_equity/task1` | 36 | Row-level versus incident-level analysis with later thresholds and severity rules preserved. |
| Sports | `nfl_big_data_bowl_2023/task1` | 42 | Long dependencies, several combined assumptions, and an existing numeric-gate precedent. |

The six candidates total 208 requests. They are not yet certified runnable on
the current isolated stack. Keep GitHub separately as the existing 15-request
regression session. NFL is computationally small in the local export but has
substantial analytical complexity; the two other sports exports contain about
1.72 GB and 4.14 GB respectively, so begin with NFL for operational efficiency.

Before agent runs:

1. Execute reference programs in the pinned evaluation environment and check
   every published answer. Resolve missing notebook helpers explicitly; record
   modifications and failures. Data availability alone is insufficient.
2. Review metadata against public requests. Some labels describe overlapping
   patterns, and they are not a complete semantic specification.
3. Preserve the full request sequence. Do not take only convenient late requests
   without their prerequisites. Added probes or changed answer contracts create
   an explicitly adapted track, separate from original-task results.
4. Reserve six additional sessions from dataset families not used to tune the
   method. Check old runs and reports before calling them held out. If the
   existing pool has no genuinely unused family in a domain, report that and
   obtain a new source; a different task on the same dataset is not a strong
   holdout by itself.

Keep the upstream-style judge score, where desired, as a separately named
compatibility measure. Our deterministic score and adapted runtime are not an
official LongDS leaderboard result.

### Track B: controlled state transitions

Build six session families with executable oracles. Instantiate each in four
domains for 24 sessions, initially 8-12 requests each. The count is six distinct
structures with 24 domain instantiations; random data seeds are repetitions, not
new task families. Use realistic tables and analytical questions drawn from the
real-session inspection, with small synthetic data where exact effects matter.

| Family | Example | What must be checked |
| --- | --- | --- |
| Reuse after a restricted report | Report three biggest increases, then analyze every positive increase. | All qualifying entities survive; a displayed subset is not mistaken for the reusable calculation. |
| One correction, several reports | Change the handling charge used by five margin reports. | Every requested dependent result reflects the charge; revenue-only reports remain correct and unchanged. |
| Historical membership with current values | Keep the original customer group, evaluate new purchases, and repeat the original publication. | Membership, measurement date, and the fixed original result are distinguished. Include a separate request to reapply the old rule to new data: that is a different operation. |
| Temporary scenario and return | Try an Under-30 cutoff once while Under-35 remains the default. | The temporary answer is right; subsequent ordinary requests still use Under-35. |
| Repair with several descendants | Correct a stated join key or deduplication rule after several analyses. | Affected outputs are repaired; unrelated outputs remain correct. Use a supplied correction initially, so this tests repair rather than error discovery. |
| Independent-task control | Interleave unrelated analyses over another dataset. | Earlier answers and later continuations remain correct; record overhead when state reuse offers little benefit. |

For a subset, vary one difficulty axis at a time: 10/25/50 requests, short/long
dependency gaps, one/five dependent reports, and two/six plausible prior states.
Keep the underlying calculation difficulty fixed where possible. Longer sessions
need meaningful state transitions or interleaved analyses, not repeated filler.
These stress sweeps are additional diagnostics, not 24 newly independent families.

Reference programs should reject plausible wrong solutions: using the current
cohort instead of the original, keeping only a displayed top-k, forgetting one
dependent report, or allowing a temporary setting to persist. Choose data where
these mistakes yield distinguishable answers. Check reference logic independently
before running either agent. Gold, dependencies, and state-type labels stay in
the evaluator and never enter normal agent prompts.

## 4. Metrics and how to observe them fairly

Keep a small scorecard. No weighted composite is needed for the headline.

| Metric | Operational definition | Where measurable |
| --- | --- | --- |
| Strict request success | All requested values, membership, fields, order, and precision satisfy the declared contract. | Both tracks. Preserve the existing strict score. |
| Analytical content | Correct entity set and quantities under predefined comparison rules; record format-only defects separately. | Deterministic tasks with a validated mapping to quantities. Unknown mappings remain unscored, not silently repaired. |
| Requirement completion | Fraction of requested semantic assertions currently satisfied, macro-averaged per request/session. | Tasks with executable assertions; no required operator sequence. |
| Update coverage | Correct affected outputs divided by requested affected outputs after a change. Also report the all-correct event rate. | Controlled changes and audited real-session events. |
| Preservation | Requested historical or unaffected outputs still match their appropriate reference state. | Historical and independent-control events. Merely remaining unchanged is insufficient if already wrong. |
| Session reliability | Fraction of complete sessions with every request correct; also fraction of requests correct in all three fresh session trials. | All registered repetitions. Report strict and analytical variants separately. |
| Recovery burden | Model calls, tokens, latency, and spending from a supplied correction until the requested outputs are correct; unresolved cases remain failures. | Controlled repairs; naturally detected errors reported separately. |
| Cost and time | Total model spend including failed attempts; model calls; input/cache-read/cache-write/output tokens; end-to-end latency; engine time and retained bytes separately. | Both tracks. Never treat missing usage as zero. |

Break these down by state pattern, dependency distance, number of prior inputs,
session position, and native/UDF usage. Report counts for every bucket and keep
multi-label pattern totals visibly overlapping.

Offline evaluator/judge spending is reported as campaign overhead separately
from agent execution cost. Runtime verification calls, if the agent makes any,
are part of that agent's cost.

### Separate outcome measurements from explanations

A code agent need not expose a DAG or use our operator names. Primary state
checks compare observable tables or requested answers with reference outcomes.
Where an intermediate result must be examined, either use an artifact already
required by the task or define the same public artifact request for both systems
in the controlled track and count its cost. Do not force extra probe requests
into an otherwise unmodified real session.

Trace audits explain wrong state selection, wrong transforms, and error cascades.
They are not automatically proved by matching an operator name or a Python
variable. Use an explicit unknown category when the selected state cannot be
established. In particular, do not reuse the old `base_selection.py` assumption
that `max(depends_tasks)` identifies one correct starting snapshot: composition
can require different historical choices for different inputs.

Report downstream failures after an upstream failure as an association unless
the trace or a controlled intervention establishes causation. A secondary
diagnostic can supply correct input tables to both agents and rerun a difficult
calculation. Improvement suggests a state-selection or upstream-state problem;
continued failure suggests a calculation/interface problem. Such assisted runs
are excluded from normal accuracy and cost comparisons.

For content scoring, specify numeric tolerances, missing values, entity keys,
and order requirements before runs. Additional keys and renamed fields remain
strict failures even when an audited content check can establish correct values.
Do not change tolerances after seeing which arm benefits. Multi-field progress
must not let one task with 200 output rows dominate an entire session.

## 5. One concrete experiment

Ask each agent to establish a baseline consisting of:

- Region and product margin reports depending on a shared handling charge.
- A revenue report independent of that charge.
- A fixed original publication retained for comparison.

Ask to change the charge from 2 to 3 and regenerate the current reports. The
oracle computes the exact expected new margins. Revenue and the original
publication must continue matching their original reference values. Then ask
for one temporary charge of 4, followed by an ordinary request that must return
to 3.

Report all complete sessions, including incorrect baselines. Also show the
diagnostic subset where the preceding baseline was correct; conditioning on
that subset must not replace the end-to-end score or conceal failures.

Observe correct-update coverage, preservation, default restoration, and total
model effort. Vary the number of dependent reports while holding data and
arithmetic constant. The resulting curve tests whether explicit dependencies
reduce reasoning as the amount of affected state grows.

An additional paired case changes an unrelated parameter; these reports must
remain correct. This checks sensitivity to relevant changes and invariance to
irrelevant ones. Fixed historical data and re-executing an old definition on
new data receive separate questions and reference answers.

## 6. Implementation to test

The candidate should make three small, connected changes:

1. Preserve the full analytical table before reporting restrictions and final
   rounding. UDFs can compute complex metrics; downstream native operators can
   form report views. This makes later reuse of the full calculation possible.
2. Show concise dependency facts when selecting existing inputs: source,
   structured restrictions where available, grouping, limiting operations, and
   current versus task-qualified inputs. Expose relevant callback code when
   needed. Do not invent a semantic guarantee for opaque Python.
3. Express shared mutable assumptions as ordinary data inputs consumed by the
   dependent calculations. Keep the existing optional `atTask` reference for
   fixed earlier data. Engine invalidation then follows actual edges.

Answer-format validation belongs in the ordinary return path. Treat it as a
separate engineering improvement and measure its effect independently. It must
not be presented as evidence that dependency reasoning improved. A format
specification declared by the model can itself be wrong; validation only enforces
the declared contract.

No new public result IDs, workflow checkout, or mandatory context-selection
model call is required by this proposal. Candidate construction still requires
the model to interpret the user's request; the engine cannot infer an omitted
dependency or prove arbitrary scientific intent.

## 7. Comparison and experimental controls

Use three primary arms:

1. Ordinary smolagents CodeAgent with persistent Python state.
2. Current cached Dataflow, with the existing feature settings recorded exactly.
3. Candidate Dataflow with the changes above.

Use Luna first. Repeat a prespecified representative subset with Terra after
the method is frozen; do not select only Luna failures for the model check.
CodeAgent may naturally write functions and preserve data. There is no separate
reusable-function baseline and no requirement to express a dataflow.

Keep task text, files, numeric libraries, model/reasoning settings, observation
budgets, and per-request limits comparable. Allow architecture-specific batching
and memory, but document it. To attribute a graph effect, hold common formatting
improvements fixed across Dataflow variants and provide equivalent output
requirements for CodeAgent; if runtime formatting support differs, include a
matched-format diagnostic comparison.

Run fresh sessions with independent cache namespaces through the verified
Responses transport. Randomize arm order, pin revisions, and run comparisons in
the same campaign window. Measure engine caching separately from prompt caching.
Include graph construction and all failed work in session cost. Preserve the
existing private agent/engine stack and isolate per-run outputs and retained data.

On controlled cases, remove one feature at a time: dependency facts, shared
assumption connections, or historical-input support. These smaller ablations
test attribution; running every knob combination on all sessions is unnecessary.
Also preserve an existing-Dataflow versus format-only comparison on the GitHub
regression so reporting improvements can be identified directly.

## 8. Stages and completion criteria

### Stage 1: measurement and gold validation

Extend the existing preparation, numeric-gate, scoring, and trace helpers. Produce
a frozen task manifest, public/evaluator file separation, typed assertions,
failure categories, and a per-request metric record. Inventory discovery is
complete; numeric gates and task certification are still pending.

### Stage 2: small development experiment

Run one controlled session per family plus the GitHub regression. Compare all
three primary arms with three fresh full-session trials after harness smoke
checks pass. This is 7 cases x 3 arms x 3 trials = 63 session runs. Begin by
checking costs and runtime on the smoke so the larger matrix uses measured
estimates rather than extrapolating from the easy GitHub case.

If the candidate does not handle the controlled transitions or its extra
reasoning erases the proposed saving, diagnose that result during development
before expanding. Preserve unsuccessful experiments in the report.

### Stage 3: broaden and evaluate held-out cases

Expand to 12 complete real sessions and 24 controlled sessions. Split by dataset
family and independently authored task variants, not random rows or data seeds.
Use six real sessions for development and reserve six for evaluation; reserve
half the controlled instantiations for evaluation with unused dataset/template
combinations. Lock the candidate before revealing evaluation outcomes.

Across development and evaluation, the full three-arm, three-trial matrix is
36 cases x 3 arms x 3 trials = 324 session runs, less any exact already-completed
development cells at the frozen revision. Extra stress sweeps, ablations, and
Terra checks are separately budgeted and reported. Three trials for every case
also provide two fresh recovery runs for each failed primary, without selecting
retries only where they improve the final table. Preserve primary and repetition
results separately; never replace a primary failure with its best retry.

### Stage 4: assess the claim

Report paired differences and uncertainty by resampling whole sessions/dataset
families; requests within a session and seeds of one template are correlated.
Show both request-weighted and session-averaged accuracy, total cost, and
cost per correct request with failed spending included. Plot accuracy versus
cost rather than compressing both into an unexplained score.

Suggested practical targets, to freeze after the development pilot and before
held-out evaluation:

- At least 10% lower model cost with accuracy within a prespecified 2-percentage-
  point noninferiority margin; or at least 5 percentage points higher strict
  accuracy with no higher model cost.
- Fewer state-related failures in at least two controlled families, with the
  corresponding feature ablation reducing the benefit.
- Report performance on real sessions and independent controls even if it
  contradicts the controlled-family result.

These are proposed engineering targets, not a power calculation. A small pilot
cannot establish a narrow accuracy margin. Use its variance to plan a larger
confirmatory sample if needed; a confidence interval spanning no improvement
means the broad comparison is inconclusive. Select the sample before evaluating
it, rather than repeatedly adding runs until significance appears.

The first milestone is a reproducible answer to: which state transitions become
more reliable, how much model effort they save, and whether that effect transfers
to real sessions. A generic formatting improvement, a cache-only saving, or a
win on one crafted history task does not establish that full claim.
