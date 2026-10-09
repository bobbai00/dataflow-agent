# Existing results: latency, accuracy, judging and errors

This is a read-only audit of the completed original comparison: **108 jobs,
twelve full sessions, three repetitions and 1,194 questions per arm**. All arms
use Luna at medium reasoning effort. Native baseline and native history both
use the catalog-based ReAct interface; history additionally exposes saved
operator inspection, fork and restore. The ledger is disabled. These results
precede the promoted nullable-integer compatibility correction. They must not
be described as results from the corrected runtime or the ongoing 64k study.

No solver or judge is called for this audit. The automatic ledger launch is
held for user review. The already-running 72-job context comparison has now
completed; its results remain separate from the original cohort analyzed here.

The reproducible numerical snapshot is
[existing-results-audit-20261003.json](../../benchmark/longds/reports/existing-results-audit-20261003.json).
Its source report is
`/var/tmp/dataflow-state-comparison-20261003/holdout/report-final.json`, SHA-256
`771be15cd094c96283ba233f0424f124f51b10ebba8fdf5d6d3c8c7ab5c40d59`.
Every original answer and judgment is retained. The one original missing
verdict is resolved by the previously documented judge-only sidecar.

## Why it takes longer

| Arm | Correct / 1,194 | Turn accuracy | Mean seconds / question | Median seconds / question | Model calls / question |
|---|---:|---:|---:|---:|---:|
| Native baseline | 268 | 22.45% | 35.86 | 23.26 | 3.13 |
| Native history | 254 | 21.27% | 39.04 | 25.93 | 3.05 |
| DSGym | 250 | 20.94% | 17.16 | 13.64 | 2.31 |

These are recorded solver/harness times, excluding correctness judging.
Campaign completion additionally waits for judging and includes setup and
artifact checks. The 108 full sessions contain 3,582 solver questions, and
questions within each session run sequentially to preserve their state.

There are three observed sources of overhead:

1. **More model calls and larger requests.** Baseline/history make 3,734/3,637
   calls versus 2,756 for DSGym. Each native arm carries about 330.6 million
   total input tokens versus 159.6 million, and about 2.8 million output tokens
   versus 2.05 million. These totals include cached input and reasoning output.
2. **Work outside provider requests.** Native request/response-file timestamps
   give approximately 25,015/27,570 seconds in provider requests, out of
   42,821/46,615 solver seconds. DSGym's directly captured call durations give
   17,894 out of 20,489 seconds. This leaves roughly **15–16 seconds per native
   question versus 2.2 seconds for DSGym** outside those requests. The residual
   includes compilation, scheduling, execution, context assembly, API work and
   benchmark trace/workflow export. It is not an engine CPU profile. Native
   filesystem timing is an approximation, rather than identical instrumentation
   to the script client's timer; all 3,734/3,637 request pairs are present with
   nonnegative intervals and match recorded model-step counts.
3. **Repeated graph work and repairs.** Accepted edits create 3,031 baseline
   operators and 2,730 history operators, compared with 510/555 updates. Native
   traces contain 901/821 action-error receipts. These can be repaired and do
   not equal incorrect final answers. The history arm uses only 17 accepted
   historical inspections, three forks and no restores across 1,194 questions.
   Availability of versions has not made reuse the dominant strategy.

Saved step timestamps provide an additional check on benchmark-export overhead.
The first-to-last recorded native step spans average 35.55/38.75 seconds;
only 0.31/0.29 seconds per question lie outside those spans, including trace
export and API work before/after recorded events. Thus almost all recorded
latency is inside the running agent, rather than benchmark export. Combining
this check with provider timestamps leaves about 14.6/15.7 seconds per native
question inside the recorded loop but outside provider requests. We still
cannot split that residual cleanly among compilation, execution, service
state handling and context assembly without finer instrumentation.

The latency gap persists on jointly correct questions: baseline averages
27.04 seconds versus DSGym's 16.10 on 145 questions; history averages 28.35
versus 16.84 on 122. Early nonanswers therefore do not explain the whole gap.

At the frozen common fresh-input prices, solver costs are $10.943169,
$10.954626 and $6.185430 respectively. DSGym's recorded estimate, accounting
separately for its reported cache writes, is $6.334359. These are token-price
estimates, excluding judge and engine cost. High cache hit rates do not make
long input histories free: 70.7% of the history-minus-DSGym common-price gap
comes arithmetically from additional cached-input tokens. The separate 64k
study has now completed both conditions. It must not replace the original
cohort above when interpreting these counts or cost comparisons.

### Follow-up: nonanswers and matched cost comparisons

Here, the discussion's **DS-Agent** means the **DSGym script baseline**.
Counts are question-turns: 398 unique questions across twelve unique full
sessions, each repeated three times, producing 36 session runs per arm and
1,194 question-turns per arm.

DSGym gets **944/1,194 incorrect (79.06%)**, broken down as follows:

| Observed failure behavior | Question-turns | Percentage of all 1,194 |
|---|---:|---:|
| Code attempted, final answer incorrect | 706 | 59.13% |
| Explicit empty/error nonanswer, without code | 144 | 12.06% |
| Incorrect supplied answer, without code | 94 | 7.87% |

There are 242 questions with no Python block or execution observation
(20.27%), including **four correct answers**. Thus 238 questions fail without
recorded code, but only 144 are explicit nonanswers. Absence of new code does
not establish that a task was not attempted mentally or that the model gave
up: reusing earlier computed evidence can be appropriate.

The primary result retains all failures and their cost. Supplemental cuts
remove the same question identities from every arm, using common frozen
token prices and solver model cost only:

| Matched selection | Question-turns | Native baseline | Native history | DSGym |
|---|---:|---:|---:|---:|
| All questions | 1,194 | $10.943169 | $10.954626 | $6.185430 |
| Exclude the 144 explicit no-code nonanswers | 1,050 | $9.365989 | $9.095401 | $5.838021 |
| DSGym attempted code | 952 | $8.397446 | $8.120715 | $5.620103 |
| All three agents answered correctly | 98 | $0.502838 | $0.494142 | $0.410990 |

Removing nonanswers narrows the cost gap but does not close it. On the same
98 questions where all three answers are correct, the native arms cost about
20–22% more than DSGym. These are descriptive conditional comparisons, not
an isolated causal cost estimate. Earlier skipped work changes later session
state and expenditure; even jointly correct answers do not prove identical
working state. Judge and engine costs are excluded. Source hashes, matched
counts, full-precision costs and the 98 question identities are saved in the
numerical snapshot's `ds_agent_followup` field.

## Where the small accuracy difference comes from

Baseline has eighteen more correct answers than DSGym; history has four more.
Whole-session/repetition bootstrap intervals include zero. Baseline-minus-DSGym
session-macro accuracy is +1.27 percentage points, with a 95% interval of
[-7.69, +10.62]. History's session-macro accuracy is actually lower than DSGym's
(21.97% versus 22.67%), despite its slightly higher turn-weighted accuracy.
There is no demonstrated aggregate history advantage over baseline.

All questions remain in the primary result. The following supplemental split
matches the same task, repetition and question in all arms and classifies only
the script's observed behavior:

| DSGym behavior | Matched questions | Baseline correct | History correct | DSGym correct |
|---|---:|---:|---:|---:|
| Code attempted | 952 | 226 | 202 | 246 |
| Explicit nonanswer without code | 144 | 30 | 34 | 0 |
| Incorrect answer without code | 94 | 11 | 17 | 0 |
| Correct answer without code | 4 | 1 | 1 | 4 |

The baseline net difference is `-20 + 30 + 11 - 3 = 18`; history's is
`-44 + 34 + 17 - 3 = 4`. Thus the small overall native lead comes from
questions where the script did not execute code, rather than superior accuracy
on the code-attempted subset. This is a conditional descriptive split, not a
randomized intervention or evidence about the model's internal intent.
Correct answers without new code can be legitimate reuse.

On the 952 questions where DSGym attempts code, its accuracy is 25.84%,
versus 23.74% for baseline and 21.22% for history. This explains the apparent
contradiction: DSGym is more accurate on this behavior-selected subset, while
native has a small lead on the full turn-weighted result. Neither establishes
a statistically clear overall accuracy advantage or a causal explanation.

The difference also varies markedly by dataset. Across three repetitions,
LearnPlatform contributes +19 baseline/+35 history correct answers relative
to DSGym; Kaggle 2021 contributes +19/+7; Uber contributes +13/+10. Kiva
contributes -33/-37. These concentrations warrant trace inspection; they do
not establish that the operator catalog or version tools caused those gains.

Selected audited examples make the distinction concrete:

- **LearnPlatform, repetition 1, question 2:** baseline computes correlation
  0.7515 from 16,945,781 paired observations. DSGym emits null values without
  executing code in that question. This is a computation-versus-nonanswer
  difference, not a historical-version success.
- **Policing, repetition 1, question 5:** history reads saved displays from
  tasks 1–4 and correctly reconstructs earlier-screen membership. Baseline
  reports support count one instead of four for a pair. DSGym reconstructs
  the support sets but reports fractions where percentages are required.
  This demonstrates useful historical inspection relative to baseline;
  DSGym's failure in this case has a separate unit/presentation cause.
- **Kiva, repetition 1, questions 5–6:** history's question-5 answer retains
  incorrect pairs. Question 6 hard-codes the countries from those incorrect
  pairs, excluding Uganda and adding Bolivia/Indonesia, and produces the wrong
  peer set. This is a directly observed propagation of an incorrect comparison
  population. Merely saving that earlier state cannot make it correct.

These are selected examples, not an exhaustive causal annotation of the cohort.
Raw evidence is in `holdout/runs/<arm>-r<rep>/<task>/`, under per-question
`react_steps.json.gz` for native and `agent/traj.json` for the script.

## What correctness judging measures

The frozen correctness judge is **`deepseek/deepseek-v4-pro`**, using the saved
upstream benchmark prompt at temperature zero. It receives question/context,
reference answer and final submitted answer. Identical question/reference/answer
triples share a verdict across arms. It does not examine the execution trace
or establish whether the complete reusable working state is correct.

The prompt requires:

- Score **one only when every requested field is correct**; otherwise zero.
- Exact requested numeric values, ignoring insignificant trailing zeros;
  tolerance only when the reference explicitly provides it.
- Correct requested ranking and order, with flexibility for ties.
- Ignore label aliases, formatting, and fields not requested by the question.

Consequently, one incorrect required number can zero an otherwise useful
answer. Conversely, extra incorrect numbers can coexist with score one when
the question asks only for an entity set. Kiva repetition 1, question 6 illustrates
the latter: DSGym's five peer identities match, while some extra numeric
details differ; the judge explicitly ignores those supporting fields.
An incorrect earlier answer is also not proof that all intermediate state
from that question is unusable.

There is **no complete official field-level partial score for this cohort**.
The older [history-verification report](../../benchmark/longds/reports/history-verification-results-20261002.json)
does contain exploratory entity precision/recall, correct-field counts and
group-level component checks. It covers 24 questions across four native
sessions, using different cases/models and recorded prompt/runtime revisions.
Its component diagnostics were not averaged into official accuracy and must
not be pooled with this cohort. Existing judgment reasoning/error text is
qualitative diagnostic evidence, not a numeric partial score.

Judge parsing/call failures remain unknown rather than becoming solver zeros.
The completed primary report has no unknown verdicts after its recorded
judge-only recovery. Empty solver answers score zero. No solver attempt or
existing binary verdict is replayed or replaced by this audit.

## Error categories and their current coverage

Three kinds of classification are available, with different meanings:

1. **Benchmark workload labels:** Initial, Update, Rollback and Counterfactual,
   plus dependency distance and whether referenced earlier answers were correct.
   These cover the full cohort. Labels overlap; Initial does not necessarily
   mean the first independent question. They describe the request, not the cause
   of an incorrect answer.
2. **Mechanical signals:** rejected edits, unconnected inputs, stale or failed
   retrievals, callback failures and blocked descendants. The new audit covers
   every native question and every script conversation. Different interfaces
   expose different error surfaces, so their counts are not directly comparable
   causal error rates.
3. **Causal annotations:** the existing seven-category taxonomy below, applied
   to earlier pilots by a separate GPT-5.5 annotator with per-question evidence,
   primary/multiple labels, upstream question IDs and confidence. These labels
   do not alter DeepSeek correctness judgments. The latest full cohort has not
   received a complete annotation using this taxonomy.

| Causal category | What an audit must establish |
|---|---|
| Statistical / Domain Reasoning | Incorrect analytical definition, unit, denominator or formula |
| Planning | An unsuitable decomposition or sequence of operations |
| Instruction Following | A required condition, field or population was omitted |
| Coding / Implementation | The submitted implementation causes the failure |
| Context Memory | An earlier rule or fact is forgotten or reconstructed incorrectly |
| State Management | The wrong artifact/version/population is used or useful state is overwritten |
| Cascade | A specific earlier incorrect intermediate is consumed and causes a later failure |

Rollback is currently a workload label, not an eighth root-error category.
A rollback failure can have a state, memory, implementation or other cause.
The full-cohort rollback results are:

| Arm | Correct / 255 rollback-labeled questions | Accuracy |
|---|---:|---:|
| Native baseline | 17 | 6.67% |
| Native history | 14 | 5.49% |
| DSGym | 21 | 8.24% |

These results do not show a rollback benefit. Questions after an incorrectly
answered dependency are also difficult: baseline gets 109/953 correct,
history 107/967 and DSGym 128/1,003. These are different conditional cohorts,
and incorrect prior answers are only an association signal; confirmed cascade
labels require trace evidence about the intermediate actually consumed.

The full mechanical audit records 267 questions with an action-error receipt
in each native arm. Baseline/history have 351/336 failed-operator visits,
including 275/258 callback-runtime failures, and 224/182 blocked/not-run
visits. Failed results account for 272/257 retrieval errors, unexecuted results
160/125, stale results seven/eight, and unconnected required inputs 29/23.
These are visits/receipts, not distinct root failures or counts of wrong
answers. Many retrieval errors follow the same earlier execution failure.
DSGym has 131 visible runtime-error observations across 105 questions; that
detector cannot see silent wrong calculations or graph-validation failures.

The original goodbooks nullable-integer/pivot failure is a verified framework
compatibility problem, distinct from an agent choosing a wrong formula.
The promoted correction handles complete nullable integer columns; its masked
integer corner case remains documented in [validation](validation.md).
All callback failures must not be attributed to that one defect.

The older 24-question native diagnostic has fourteen annotated failures. Its
Luna baseline/history sessions each have two primary state-management and two
primary cascade labels; five failures in each have a cascade label among their
multiple labels. Those selected sessions are useful examples, not a current
full-cohort error-distribution estimate.

## What remains unresolved

The results expose overhead and low historical-tool adoption, but do not yet
isolate a causal benefit of versioned state. Operators frequently wrap whole
analyses rather than retaining independently reusable rules and complete
working populations. A version of a truncated answer leaf or an incorrect
intermediate remains limited or incorrect when reused.

Historical observations are retained within their result budget. Historical
definitions preserve graph rules, but do not provide immutable backups of
external files or guarantee unlimited historical table materialization. A fork
may recompute on current external bytes. This boundary matters when claiming
rollback fidelity, reduced recomputation or resistance to source changes.

The next useful work on **these existing artifacts** is complete causal
annotation with provenance, and a finer split of native residual latency into
execution, context and benchmark export. Neither requires another solver
experiment. The user-review hold on the ledger is recorded at
`/var/tmp/dataflow-context-comparison-20261003/hold-ledger-for-review.json`.

### Accuracy improvements to prioritize

An incorrect population means the wrong set of records, entities, eligibility
rules or analytical grain is used. For example, calculating a rate across all
100 eligible entities using an earlier five-row top-five report selects the
wrong population. Retrieval may correctly mark those five stored rows complete
while the table remains incomplete for the next analytical question.

That selection can be a new root error. It becomes a cascade when a later
calculation actually consumes the incorrect population or rule. A wrong final
answer alone does not prove a cascade: formatting or units can be wrong while
the full intermediate remains useful. Both interfaces have this risk.

Keep ordinary ReAct and the existing state primitives. Prioritize:

1. **Reusable working state:** retain complete working populations and derived
   columns separately from ranked/report outputs; update an existing rule
   where it is defined instead of repeatedly reconstructing it. The frozen
   history prompt already instructs working/answer separation and warns that
   earlier answers can be wrong. More generic prompt prose is not a demonstrated
   remedy; verify what the model actually preserves and reuses.
2. **Scope evidence at reuse:** make source/version, row count, keys/grain,
   filters and report truncation easy to inspect. Use observed facts rather
   than assuming arbitrary Python output is a complete working population.
   The optional ledger can help expose provenance, but its experiment remains
   held and it cannot certify semantic correctness.
3. **Targeted checks:** evaluate task-derived eligibility conditions,
   denominator/grain, join coverage, group membership and unit conventions on
   the full working data at relevant boundaries. Profiles and samples can
   prompt checks but cannot establish arbitrary analytical correctness. Avoid
   a separate model judge for every step or any runtime use of benchmark gold.
4. **Repair the cause:** when an intermediate fails a relevant check, correct
   its producer and recompute affected descendants; preserve independent good
   state. Execution success and saved versions do not imply semantic validity.
   A presentation-only error should not invalidate every good intermediate.
5. **Final answer checks:** ensure requested fields, percentages, units,
   precision and ordering agree with the computed evidence. Correct reuse
   does not require executing fresh code on every question.

These mechanisms should first be verified with regression fixtures from
audited failures. They are improvement hypotheses, not measured gains. Keep
framework compatibility and graph-validation defects separate from analytical
reasoning errors when assessing whether a change helps.
