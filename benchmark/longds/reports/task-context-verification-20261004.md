# Task dependency context verification, 2026-10-04

The task graph and thin context work, but the first pilot does not establish an
accuracy improvement. Replacing old trajectories substantially reduces model
input; it also makes the model reconstruct more operator details. Cache reuse
must be preserved deliberately. This policy remains opt-in.

The implementation retains ordinary ReAct within the current task. Earlier
questions, agent answers, operator names and observed dependencies form the
index. `inspect task` retrieves a complete saved question/answer and operator
index; existing state inspection, fork and restore retrieve or reuse selected
versions. Dependencies record computation, reads and definition reuse, while
consultations remain separate. There is no model-maintained ledger or semantic
check tool. Request-only failures remain addressable as incomplete tasks.

## Original matched pilot

Both arms used Luna at medium reasoning effort, native DELTA messages, saved
state tools, 40 model calls per question and identical system prompts/tools.
Only `taskContext` differed. Data/flow evidence exposure was disabled, native
profile collection enabled, and retrieval choices were `full` and `sample`.
Samples had a 2,000-character budget; full results had a 5,000-character budget.
The model-input budget was disabled. No summarizer, ledger, selective solver
replay or best-of selection was used.

The two complete LongDS sessions were Uber task 2 (35 questions) and Kaggle
survey 2019 task 2 (30 questions), with three independent repetitions per arm.
These sessions were previously studied; this is exploratory evidence, not a
held-out or benchmark-wide result. It is not a new DSGym comparison.

| Metric | Full trajectory | Dependency context |
|---|---:|---:|
| Official correct answers | 56/195 (28.72%) | 58/195 (29.74%) |
| Estimated solver cost | $1.1294 | $1.8462 |
| Model calls | 503 | 848 |
| Mean model input per call | 59,876 tokens | 28,318 tokens |
| Mean dynamic context per call | 208,405 characters | 68,864 characters |
| Input cache hit rate | 97.74% | 81.71% |
| First-call cache hit rate | 98.91% | 41.95% |
| Mean elapsed time per question | 27.28 s | 37.90 s |

All 390 questions produced completed answers and received official judgments.
Costs include incorrect attempts. On the 43 paired questions both arms answered
correctly, dependency context still cost $0.2747 versus $0.1945, about 41% more.
Across all questions it cost about 63% more and used about 69% more model calls.
The estimated macro accuracy difference is +0.87 percentage points; a
session/repetition bootstrap interval is -7.22 to +7.78 points. Only two
independent sessions underlie that interval, so it is descriptive uncertainty,
not strong evidence of an advantage.

The difficult state-related questions remain weak: among 42 questions tagged
Rollback, full trajectory passed zero and dependency context passed one;
among 18 tagged Counterfactual, the counts were zero and one. Benchmark tags
can overlap. These outcomes show that preserving state correctly is not
sufficient to reconstruct the requested analytical interpretation correctly.

Cost uses the same repository fallback rates for both arms, with cached-input
discounts. These are estimates, not provider invoices. LongDS uses the official
binary DeepSeek judge. Judge spending is separate ($0.8666 for this pilot;
shared exact-output verdicts counted once). KramaBench uses its official
evaluator; the single-task wildfire case passed all six original runs. First
task messages are identical under the two policies, so different single-task
outcomes represent model variation rather than a context-policy effect.

## Mechanisms and fixes

The old dependency index was one rewritten message. That lost most cache reuse
at task boundaries. Separate immutable task messages only helped after earlier
questions retained their **exact native event wrappers**. In a six-task cache
probe, the final four first calls reused 86.65% of input, versus 41.77% for the
original format. Every probe variant and attempt was retained. This is a cache
mechanism test, not an accuracy benchmark.

Task inspection also emitted top-level Markdown headings. The native message
parser mistook them for a changing trailing context section: 17 of 653
within-task prefix comparisons changed in the original thin arm. Quoting the
inspection body keeps arbitrary saved question/answer headings inside their
immutable tool response. A regression test reproduced the failure before the
fix. A real three-task Luna integration smoke returned the expected values and
preserved its within-task prefixes after the fix.
An initial integration fixture omitted its required gold file and stopped
after its first paid call. Its trace and cleanup are retained separately;
the corrected independent fixture is a functional check, not a retry used to
improve benchmark accuracy. All diagnostic attempts are included in the
machine report's auxiliary cost accounting.

Runtime versions are kept separate. The original paid pilot ran `e77066929`.
The immutable-request follow-up ran `27a2ea8f3`, which also includes the canonical
saved-read provenance fix `d26d107bf`. The inspection-heading fix `a4735aef1`
and request-only-task fix `ad2016f55` were subsequently verified with regression
tests and live engine checks; paid pilot numbers must not be attributed to
those later fixes. No paid runtime was edited during its experiment.

## Separate cache-refinement follow-up

One new independent repetition of both full sessions produced 130 answers.
This adaptive follow-up is separate from the original three-repetition pilot.
It tests the immutable-request cache fix, before the inspection-heading fix.

| Metric | Full trajectory | Dependency context |
|---|---:|---:|
| Official correct answers | 15 confirmed; 1 unjudged / 65 | 13/65 (20.00%) |
| Accuracy bounds over all questions | 23.08–24.62% | 20.00% |
| Estimated solver cost | $0.3308 | $0.5112 |
| Model calls | 160 | 293 |
| Mean model input per call | 53,938 tokens | 26,421 tokens |
| First-call cache hit rate | 98.94% | 96.16% |
| Overall input cache hit rate | 97.74% | 88.41% |
| Mean elapsed time per question | 23.21 s | 36.57 s |

The task-boundary cache mechanism improved, but dependency context still cost
about 55% more, used 83% more calls and took 58% longer. Eleven within-task
prefix changes remain in this frozen revision; the later inspection-heading
fix has functional verification rather than a new paid accuracy comparison.
On seven paired questions both arms answered correctly, thin context was about
9% cheaper ($0.0329 versus $0.0360). That small conditional subset does not
establish an overall efficiency advantage.

The survey session passed 13/30 with thin context and 9/30 with full history.
The Uber session passed 0/35 with thin context; full history has six confirmed
passes and one unjudged answer. A manually inspected initial failure missed the
literal `Unknown Location` sentinel, selected an extra unknown-endpoint pair,
and reused the wrong watch list in task two. Both arms' first-call messages for
task one were identical. This demonstrates a semantic cascade and model
variation; it does not establish that thinning caused the initial mistake or
explain every later failure.

The unresolved official judgment is full-history Uber task eight. All three
original judge calls exhausted 8,000 tokens without a usable verdict. One
registered missing-verdict-only recovery exhausted 16,000 tokens as well.
The model answer is retained, its spending is included, and the judgment stays
missing rather than becoming a guessed score. Even the favorable accuracy
bound for thin context is below the full-history lower bound in this repeat.
Judge spending for the follow-up is $0.1633, including failed calls and recovery.

The follow-up single-task check passed 1/1 in the thin arm and 0/1 in the full
arm: the latter constructed both requested monthly lags with the same offset.
The original single-task checks passed 6/6. These runs share first-task input,
so the difference is model variation rather than a policy benefit.

## Error and partial-result analysis

The [manual audit](task-context-audit-20261004.json) covers nine selected cases:
accuracy differences in both directions, both-correct cost differences in both
directions, semantic cascades, an inconsistent judgment and a single-task
window-offset mistake. It is not a prevalence estimate.

Wrong source-column selection propagated from salary calculations into age
calculations. A faulty C/C++ token boundary propagated from a saved mention
table into a later language comparison. Ranking only watched corridors instead
of all eligible corridors corrupted a later rank-change/top-half report.
These are semantic cascades through correctly identified state, not evidence
that the snapshot engine selected the wrong version.

Thinner context sometimes helped the model inspect and reuse a correct cleaned
table. It also prompted many additional lookups: 634 successful operator
inspections versus 26, and 144 graph inspections versus 8. Model time and action
execution dominate latency; original context assembly totaled 10.5 seconds
across 848 thin-arm calls, versus 2.8 seconds across 503 trajectory calls.

Official correctness alone does not establish correct intermediate state. One
both-correct case used different percentile populations. One reported accuracy
flip arose because the judge required a full country comparison from one
answer while accepting its omission from the other. Official labels remain
unchanged; the audit flags that inconsistency explicitly.

Mechanical diagnostics cover every turn: action errors, execution failures,
blocked descendants, unrelated stopped work, skipped actions, history accesses,
provenance coverage, context size, cache hits, model calls and latency. Counts of
operator execution states are visits, not unique faults or measured CPU time.
The separately frozen strict JSON-leaf score is a schema-sensitive format
diagnostic: renamed keys and extra reference fields make it unsuitable as
semantic partial accuracy. Selected manual component checks identify correct
parts of failed answers without inventing a cohort-wide semantic partial score.

## Verification and next decision

The full agent suite passes 1,344 tests; type checking, generated-reference
checks and formatting checks pass. The evaluation tests pass 109 tests in the
repository Python environment plus five transport tests in the benchmark
environment. The live five-task fixture checks cached producers, changed-input
recomputation, consultations, historical reads, fork, restore, deletion and
unknown tasks. Its runs allocate and remove only their own resources.

The current feature should remain experimental. The next useful improvement is
to make relevant operator definitions and schemas cheaper to retrieve, while
keeping questions/answers and version references stable. Evaluation should
separately measure retrieval overhead, correctness of analytical scope and
version selection; a saved dependency edge alone cannot establish any of those.
Before making broader accuracy claims, freeze a consistent question-derived
required-field rubric and expand to independent sessions. Keep correct-answer
cost comparisons alongside total spending.

The [portable machine report](task-context-verification-20261004.json) contains
per-turn official outcomes, diagnostics, partial-format scores, audit references,
verification logs and cost accounting. Across both studies and all diagnostic
attempts, estimated solver spending was $3.9088, including $0.0705 for probes
and integration smokes. Provider-reported LongDS judge spending was $1.0298;
that figure excludes uninstrumented single-task evaluator spending.

Frozen raw artifacts are retained under
`/var/tmp/dataflow-task-context-verification-20261004` and
`/var/tmp/dataflow-task-context-cache-verification-20261004`. The portable
machine report records protocol/report hashes and runtime revisions. The
follow-up is reported separately because its format was chosen after examining
the original pilot. All allocated benchmark/probe resources were removed, and
the three isolated agent-service processes were stopped. Shared backend
services remain running.
