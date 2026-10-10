# Bounded-context LongDS pilot — results and direction

The direction is dataflow as retrievable analytical memory: ordinary ReAct,
a thin task/answer/dependency index, and selective retrieval of saved operator
definitions and results. The target is reliable reuse under a bounded context.
The Python comparison retains a live kernel and pays for same-model history
summarization. There is no ledger or benchmark-specific solving rule.

The repaired pilot answered **19/38** questions correctly with dataflow and
**14/38** with DSGym, at **30.8% higher estimated solver cost**, **92.4% more
provider calls**, and **49.1% more summed session time**. The gains concentrate
in the survey case; dataflow loses on the film case. These are two selected
19-turn prefixes with one repetition, not a benchmark-wide result or an
isolated test of historical retrieval. An input-inventory problem discovered
during audit further limits the comparison, as described below.

The [portable results and audit](bounded-context-pilot-20261004.json) contain
every turn's official score, provider usage, input-cap audit, both revisions,
manual target-component mappings, reference gates, and verification details.
Raw artifacts and frozen source archives remain at
`/var/tmp/dataflow-bounded-pilot-20261004`.

## Repaired pass

Both systems use `gpt-5.6-luna`, medium reasoning, a 32,000-token estimated
complete-input cap, 40 model calls per turn, and 8,192 output tokens per call.
The cap includes system instructions and tool schemas. All 345 captured
requests stayed within the estimate and observed provider-token limits; the
maximum observed input was 28,227 tokens. The baseline made 19 paid summary
calls, so bounded-history management was exercised rather than merely enabled.

| LongDS prefix, Q1–Q19 | DSGym correct | Dataflow correct |
| --- | ---: | ---: |
| `community/kaggle-survey-2021/task2` | 7/19 | 14/19 |
| `business/netflix_movies_and_tv_shows/task3` | 7/19 | 5/19 |
| Total | 14/38 (36.8%) | 19/38 (50.0%) |

| Measure across both prefixes | DSGym | Dataflow |
| --- | ---: | ---: |
| Uniform estimated solver cost | $0.2306 | $0.3017 |
| Provider calls, including summaries | 118 | 227 |
| Summary calls | 19 | 0 |
| Sum of per-turn elapsed seconds | 972.337 | 1,450.195 |
| Valid finite JSON-object answers | 37/38 | 38/38 |
| Explicit nonanswers without submitted computation | 2/38 | 0/38 |
| Answers ending in an input-budget error | 0/38 | 0/38 |
| Unknown usage among captured requests | 0 | 0 |

Sessions ran concurrently; summed per-turn elapsed time is not campaign wall
time. Costs apply the same frozen repository rates to both routes: $0.20 per
million fresh input tokens, $0.02 cached, and $1.20 output, without a
route-specific cache-write surcharge. These are estimates, not invoices.
Summarization and unsuccessful work are included. Original solver statistics
remain untouched; the supplemental report recovers complete captured usage
from provider-wire records, including requests preceding a local budget error.
Missing request captures or turn identities cause the report to fail rather
than silently assign zero cost.

On the 34 aligned turns where both systems submitted computation, DSGym scores
13/34 at $0.2156 and dataflow 15/34 at $0.2753: dataflow still costs 27.7% more.
This is descriptive conditioning, not removal of all failure-related bias.
It excludes legitimate answers made from saved results without new execution,
and earlier skipped work can affect later costs. The headline comparison keeps
all 38 turns. Including all failures, estimated spend per correct answer is
$0.0165 for DSGym and $0.0159 for dataflow on this small cohort; that ratio is
not sufficient evidence of a general efficiency advantage.

## What the additional metrics and traces show

The primary grade uses the existing LongDS binary judging prompt and
`deepseek/deepseek-v4-pro`; it is not a new partial-credit judge. One nonfinite
baseline answer is rejected by the harness without a model judgment. All 152
answers across both passes have recorded official grades. Identical
question/reference/answer triples reuse the same cached judgment.

The frozen automatic Q19 component rubric expects specific JSON field layouts.
All eight target answers used other layouts or an explicit budget error, so its
automatic component scores remain **unscored**. A separate, labeled manual
audit maps reported fields to the required tables, preserving numbers,
membership and order; it does not rewrite official grades. Its partial score
averages identity F1, requested-value accuracy and row-order accuracy. It
measures tables, not narrative truth or the correctness of unseen procedures.

| Repaired Q19 target | Arm | Official grade | Table component score |
| --- | --- | ---: | ---: |
| Survey framework comparison | DSGym | 0 | 1.000 |
| Survey framework comparison | Dataflow | 1 | 1.000 |
| Film-rule sensitivity | DSGym | 0 | 0.533 |
| Film-rule sensitivity | Dataflow | 1 | 1.000 |

Four audited mechanisms explain why final accuracy alone is insufficient:

- **Answer-writing error:** DSGym's survey Q19 contains all four correct tables,
  but its explanation says women swap XGBoost and PyTorch positions. Its own
  tables and the reference have XGBoost fourth and PyTorch fifth in both groups.
  The zero official grade therefore reflects a false required comparison,
  despite correct computed tables. This is not evidence of lost kernel state.
- **Rule applied twice:** DSGym's film Q17 builds the adjusted score as
  `base + delta`. Q19 constructs its purported direct score as `base - delta`
  and compares those two, doubling the intended difference. Its reported
  values are approximately twice the references. Australia also replaces
  France in the answer; that separate membership error has not been fully
  traced to its earlier source.
- **An early definition error propagates:** dataflow's film Q1 loader omits
  `multiTimeline.csv`, whose header identifies United States search interest,
  and reports 14 markets instead of 15. Q2 forks that search summary and
  inner-joins country/market names; `UK` also fails to match `United Kingdom`.
  Its percentile calculation then uses a reduced universe. Thailand's demand
  gap is 92.3077 instead of 93.3333. This chain is visible in implementations
  and results, rather than inferred solely from task dependency annotations.
- **Saved-state recovery after a rejected edit:** dataflow's film Q19 inspects
  tasks 17 and 15, then attempts a fork/update with an edge into an occupied
  input. The Edit is rejected atomically, with no changes applied and later
  execution/retrieval actions skipped. The agent subsequently retrieves the
  preserved original definition and result and answers correctly. This shows
  actual use of saved state and safe edit failure; it does not prove that
  historical retrieval alone caused the accuracy difference.

The repaired dataflow traces contain 163 successful Inspect action receipts,
including 82 task inspections, alongside 8 execution-error and 10
retrieval-error receipts. Receipts are actions, not distinct model calls, and
some retrieval errors follow an execution failure. These are mechanical
counts, not 18 independent semantic failures. The semantic examples above are
a targeted audit, not a complete causal classification of every wrong answer.

The first native requests consume 14,502–15,612 input tokens, versus
2,111–3,222 for Python. Native system/tool content accounts for roughly 61,000
JSON characters before evolving state is considered. Across the repaired pass,
dataflow sends 5,022,062 input tokens versus Python's 1,589,405. Prefix caching
helps, but its cached-input charges are $0.0904 versus $0.0229. More calls and
large fixed instructions remain measurable overhead even with a thin task
history. Dataflow actually generates slightly fewer total output tokens, so
large generated code blocks are not the sole cost explanation in this pilot.

## Limits and next decision

The Netflix input inventory includes seven pre-existing CSVs under
`working_tables/`, with sampled file modification times in September. Both
arms could see them; first-pass DSGym successfully reads cleaned/detail/search
tables from that directory after its early nonanswers. Repaired DSGym builds
its own live working tables, and a write under the read-only input directory
is rejected; no native edit references that directory. Nevertheless, the
repaired pass also exposes these files. The first pass especially is not an
uncontaminated test of preserving self-generated state. No shared input files
were deleted or rewritten during this audit.

Before another paid comparison, use a freshly extracted, immutable raw-input
snapshot common to both arms, and keep reference execution and run outputs
outside it. This needs input provenance rather than task-name exclusion rules.
Both agents should have equal input access and persistent analytical state.

Then the useful optimization is reducing the cost of finding and reusing a
computation: make detailed operator reference material available on demand,
keep task retrieval centered on its answer roots and required definitions, and
measure whether repeated inspection can be reduced. Keep generic guidance to
check input coverage, filters, denominators and the requested rule before
reusing a saved result. Saved state needs semantic checking; the graph cannot
guarantee that the original calculation was right.

A small follow-up should retain the same bounded Python kernel baseline and
separate controls for historical tools, so it can distinguish fixed prompt
overhead, memory retrieval and paid compaction. Judge accuracy, table
components, answer consistency, recovery, calls, cost and latency together.
This pilot justifies refining that experiment; it does not establish dataflow
as universally better or cheaper on LongDS.

## Repairs, provenance and verification

| Pass | Source revision | DSGym correct/cost | Dataflow correct/cost | Native budget-error answers |
| --- | --- | --- | --- | ---: |
| Initial bounded pass | `716e80431` | 10/38 · $0.1404 | 11/38 · $0.2416 | 12 |
| Repaired paired pass | `bb736610e` | 14/38 · $0.2306 | 19/38 · $0.3017 | 0 |

The first pass exposed a real checkpoint bug: user turns do not own workflow
snapshots. Compaction must resolve the prior action's snapshot rather than
look up the user's ID. The regression now uses that production ownership
structure and fails before the fix. The second pass also gives Python a
generic notice explaining its `<python>` execution protocol. It changes no
analytical question or rule and does not reset the kernel. These passes bundle
changes and model variation, so their score difference is not a causal estimate
of either fix. Both are retained; there is no best-of selection.

Verification passed: **1,368 Bun tests**, TypeScript checking, **121 Python
harness tests**, and **5 optional transport tests** in the benchmark virtual
environment. The two accepted prefixes reproduce all 38 reference answers.
All eight live jobs completed. Four owned agents, computing units and workflows
were removed, the owned agent service on port 3068 was stopped, and shared
backend services remained listening.

Both passes together cost $0.9143 at uniform solver rates. The shared judge
cache contains 147 unique captured provider responses with $0.3264 in reported
provider cost; reused judgments are not charged twice. Solver estimates and
reported judge charges are different accounting bases, not an invoice total.
Protocols freeze source, prompts, data hashes, runtime packages, input-budget
calibration and rubrics. The analysis reads those artifacts without changing
answers or judgments:

```bash
.venv/bin/python benchmark/longds/bounded_pilot_report.py \
  /var/tmp/dataflow-bounded-pilot-20261004 \
  --destination /var/tmp/dataflow-bounded-pilot-20261004/supplement.json
```

The portable JSON additionally preserves the labeled manual component audit
and source-answer hashes. The original plan at `716e80431` and repair addendum
at `bb736610e` predate their respective solver calls; their text is retained
below and in the artifact root's `predeclared-plan.md`.

## Predeclared plan, preserved

This pilot compares the current dataflow agent with DSGym on two natural
19-turn LongDS prefixes. It tests whether state retrieval remains useful when
both agents have a bounded context; one repetition cannot establish a broad
accuracy or cost advantage.

The selected cases are `community/kaggle-survey-2021/task2` (Q19 reuses the
Python/Matplotlib subgroup and compares its framework ranking with the earlier
overall ranking) and `business/netflix_movies_and_tv_shows/task3` (Q19 replaces
one historical scoring rule while retaining current components and membership).
All 38 reference answers reproduce with the repository Python environment.
Only notebook-relative data paths were normalized. The initially considered
2020 survey prefix was rejected before solver calls: five published answers
contain NaN. Its gate artifacts remain recorded.

Both arms use Luna at medium reasoning, the identical interface-neutral user
requests, 40 model calls per turn, and 8,192 output tokens per call. The initial
full-input cap is 32,000 estimated tokens, including the system prompt and tool
schemas. One pooled scale, 0.9191098451130497, was calibrated on 270 earlier
development requests without answer scores. Actual provider usage is audited
separately; this estimator is not a tokenizer guarantee. No artificial history
or token padding is added to make the cap bind.

The dataflow arm uses ordinary native ReAct, task/answer/dependency cards,
on-demand task-local historical retrieval, available data statistics, and
runtime answer composition. It has no ledger. Automatic overflow checkpoints
exclude unchanged historical operators. All current references remain available
through state tools.

DSGym retains its Python kernel for the entire prefix. At overflow the same
solver model summarizes complete earlier messages in bounded chunks, retaining
the original request, current question, recent turns, incremental summary and
live variable inventory. Every summarization call, failed provider attempt and
token is included in call limits and cost. No baseline kernel resets occur.
Within an exceptionally large current turn, older printed outputs may be
omitted with an explicit marker; the kernel objects remain available.

The primary measure remains the official LongDS binary judgment with its
existing DeepSeek judge. Additional measures are strict JSON validity, the
frozen Q19 answer-component rubrics (table membership, requested values, rank),
calls including summaries, cache usage, latency, retrieval size, execution/tool
errors, and full-request cap violations. Component metrics recognize only
predeclared answer structures; unfamiliar structures are unscored, not silently
assigned zero. Manual trace audits distinguish wrong cohort/definition,
unsupported reuse, answer formatting and infrastructure errors. A dependency
edge alone does not prove a cascading failure.

All four attempts are retained with frozen source/input hashes. No best-of
selection or score-selected solver retry is allowed. If the cap does not bind,
that is reported; any further cap or control experiment requires a separately
frozen protocol. The comparison bundles prompt/context/interface changes, so it
cannot isolate the causal effect of a single fix. Costs use frozen repository
fallback rates and are estimates, not provider invoices.

## Verification adjustment after the first pass

The first pass completed all 76 answers. It exposed a real overflow failure:
user turns have no owned snapshots, so the starting-workflow identity must be
resolved to its preceding action. The initial unit fixture incorrectly gave
user turns snapshots. The revised regression uses the production structure,
fails on the first-pass implementation, and passes after the fix.

One further paired pass uses exactly the same two prefixes and 32k policy.
The Python baseline additionally receives a generic execution-protocol notice:
the runner executes `<python>` blocks and supplies the subsequent observations,
with no formal function-call tool required. This changes no question, analytical
rule, file, kernel lifetime or reference answer. It addresses model claims that
a verified executable kernel was unavailable. Both passes remain separately
reported; this is verification after a discovered bug, not best-of selection.

The first-pass automatic target-component scorer encountered equivalent JSON
structures with different field names. Those remain unscored in its frozen
metric; a separately labeled manual component audit may map reported fields to
the question-defined table requirements. Official judgments remain unchanged.
