# Clean-input LongDS pilot: full versus on-demand references

Keep the full native prompt as the default. Moving operator documentation and
worked examples behind inspection reduced estimated solver cost by **14.4%**,
but lost **four correct answers**. Neither native arm establishes a cost
advantage over DSGym on these two prefixes. The full arm's aggregate accuracy
gain is largely explained by early baseline failures to submit computation,
not an isolated benefit from saved dataflow state.

The [portable results and audit](clean-context-pilot-20261005.json) contain all
114 valid-run turn records, provider usage, cap checks, input provenance,
reference gates, selected trace findings, and separate component diagnostics.
Raw artifacts, wire captures, reference outputs, analysis scripts and frozen
sources remain at `/var/tmp/dataflow-clean-context-pilot-20261005`.

## Results

Each arm solved the same two natural Q1–Q19 prefixes once:
`community/kaggle-survey-2021/task2` and
`business/netflix_movies_and_tv_shows/task3`. These are 38 questions per arm,
not 38 independent sessions or a benchmark-wide estimate.

| Measure | DSGym Python | Native full | Native on-demand |
| --- | ---: | ---: | ---: |
| Correct answers | 19/38 (50.0%) | 22/38 (57.9%) | 18/38 (47.4%) |
| Survey correct | 13/19 | 18/19 | 15/19 |
| Netflix correct | 6/19 | 4/19 | 3/19 |
| Uniform estimated solver cost | $0.17795 | $0.36145 | $0.30956 |
| Provider calls, including summaries | 106 | 251 | 220 |
| Paid summary calls | 13 | 0 | 0 |
| Sum of per-turn elapsed seconds | 768.760 | 2,092.882 | 1,677.028 |
| Valid finite JSON-object answers | 36/38 | 37/38 | 38/38 |
| Input-budget errors | 0 | 0 | 0 |
| Unjudged valid-run answers | 0 | 0 | 0 |

Full native costs **103.1% more** than Python for three additional correct
answers. On-demand costs **74.0% more** than Python for one fewer correct
answer. Compared with full native, on-demand uses 12.4% fewer calls and 19.9%
less summed turn time. Sessions ran concurrently, so these elapsed-time totals
are descriptive and do not represent controlled single-session latency.

Cost uses captured provider usage and identical frozen rates for every route:
$0.20/M fresh input tokens, $0.02/M cached input tokens and $1.20/M output
tokens, with no additional cache-write surcharge. This includes unsuccessful
solver work and paid summaries; it excludes judging. These are estimates,
not invoices or a claim about current provider pricing. All 577 requests in
the valid comparison have known usage. Missing usage is never assigned zero.

## What changed and what was held constant

The native comparison changes only `nativePromptDetail`: `full` versus
`on_demand`. Both use ordinary native ReAct, the same action schema, DELTA
context, thin question/answer/dependency cards, saved task versions, task-local
operator retrieval with upstream boundaries, and the same observation views.
There is no ledger. `Answer` can name its contributing operators; retrieving
a task uses the saved answer sub-DAG rather than the accumulated whole graph.

On-demand retains role, concepts, action grammar and effects, observation
contracts, and history guidance. It moves detailed operator descriptions and
long worked examples behind read-only `inspect reference` actions. Those
actions are available to both arms and return the canonical, feature-matched
reference. They do not execute operators or change task dependencies. The
full default prompt remains unchanged by this feature.

Both native arms collect statistics and offer `sample_stats` and `full`
retrieval. Samples and statistics each have a 2,000-character budget; full
results have a 5,000-character limit. Automatic flow evidence is disabled.
Some task inspections include statistics directly, so counts of explicit
statistics retrieval alone do not measure every exposure to evidence.

All arms use `gpt-5.6-luna`, medium reasoning, 40 calls per turn, 8,192 output
tokens per call and a 32,000-token estimated cap on the complete input,
including system instructions and tool schemas. DSGym retains its persistent
repository Python kernel, upstream text ReAct protocol and a generic kernel
notice. It pays the same model to summarize complete older messages in bounded
chunks, together with live kernel inventory; its kernel is never reset.

All estimated and observed inputs stayed within 32,000 tokens. The maximum
observed input was 28,936. Summarization was exercised, but neither solver
hit the cap. This therefore does not demonstrate a feasibility advantage
from dataflow memory under a binding token budget.

## Failed or unattempted work and the accuracy gain

DSGym's Netflix Q1–Q6 return explicit execution nonanswers without submitting
Python. Survey Q1–Q3 and Q5–Q6 also submit no Python and fail; Q4 submits a
block and finishes with an empty answer. That is **11 failed tasks without
submitted computation**, or 28.9% of the 38 questions. The narrower automatic
`unattempted_nonanswers` counter finds six explicit errors; it does not count
all guesses, status answers or empty answers. It must not be read as the
total number of unattempted failures.

On survey Q7–Q19, DSGym is correct on **13/13**, full native on **12/13**, and
on-demand on **10/13**. Full native's survey gain comes from getting the first
six questions right, offset by its later Q17 failure. The overall +3 result
is a +5 survey difference and a −2 Netflix difference. A typed Python action
control would help separate protocol/model failure from a dataflow advantage.

The headline cost keeps every turn. A secondary analysis pairs the identical
turns where both arms submit computation, including failed executions:

| Pair and common attempted turns | Python correct / cost | Native correct / cost |
| --- | ---: | ---: |
| Full, 27 turns | 19/27 / $0.16175 | 16/27 / $0.27247 |
| On-demand, 25 turns | 17/25 / $0.15847 | 12/25 / $0.20917 |

These are descriptive subsets conditioned on solver behavior, not a causal
removal of failure bias. They can exclude legitimate native answers retrieved
from existing results without a new execution. The two subsets also differ;
they must not be compared as if they were a single fixed cohort.

## Why time and cost remain high

The full system prompt has 48,559 characters, versus 30,310 on-demand. First
native requests fall from 14,735 to 9,883 input tokens on Netflix and from
16,651 to 11,799 on Survey. The tool schema and state still occupy context.
The on-demand survey run makes six reference inspections; Netflix makes none.

Native full makes 221 successful Inspect actions across the two cases,
compared with 156 on-demand. Recorded model time totals 1,499 seconds for
full and 1,057 for on-demand; recorded post-step time totals 560 and 602
seconds. Post-step includes execution and inspection/retrieval. Context
assembly itself totals only 11.7 and 3.1 seconds. These service phases locate
the overhead in model calls and tool work; they are not a CPU billing model.

The combined Edit payload text is 154,431 characters for full and 154,592 for
on-demand. The largest single Edit is 8,872 and 7,132 characters respectively.
Shorter initial instructions do not impose a bound on generated edits.

Selective retrieval is working, but some early task branches are genuinely
large:

| Native run | Returned sub-DAG blocks | Mean local operators | Maximum local | Mean full upstream |
| --- | ---: | ---: | ---: | ---: |
| Full Netflix | 24 | 5.88 | 25 | 20.67 |
| On-demand Netflix | 11 | 7.00 | 22 | 22.27 |
| Full Survey | 5 | 1.80 | 3 | 3.00 |
| On-demand Survey | 14 | 5.14 | 7 | 5.14 |

These counts are returned blocks, including repeat inspections. They describe
task-local contributions, not unique computation or every inspection call.
Netflix Task 2 can return 25 local operators and 23,804 characters of
definitions; it is inspected repeatedly. Upstream boundary summaries keep
later task contributions smaller without claiming every task needs five
operators. Cached execution outcomes are common—for example, 645 of 725
operator visits in full Netflix—but these are repeated visits, not unique
operators or measured CPU savings.

## Accuracy mechanisms and extended evaluation

Official accuracy uses the existing LongDS binary judge prompt with
`deepseek/deepseek-v4-pro`. Identical question/reference/answer triples share
a cached judgment. Original grades are unchanged. This audit classifies
selected mechanisms; it is not a complete causal labeling of every error.

- **Input coverage and wrong row selection:** Netflix Q1 reports 13 search
  markets in full and 14 on-demand, versus 15 in the reference. On-demand
  also reports 2,676 missing movie durations, versus zero: it counts the TV
  rows whose movie-duration field is inapplicable. Schema/statistics can
  expose those rows, but cannot decide the intended unit of analysis.
- **Changed category definitions:** full Survey Q17 merges eight original
  experience categories into six. For men, 1–3 years becomes 28.11%
  (18.74 + 9.37), and 3–5 years becomes 8.73% (4.84 + 3.89). The question
  asks for the original distribution. The algorithm percentages are right;
  the unrequested recategorization is wrong.
- **Earlier semantic errors survive retrieval:** both native Netflix Q19
  answers substitute Australia for the required Taiwan after inspecting
  Task 17. On-demand retrieves existing results and performs no new
  execution. Full also reports France's difference as 1.2594 rather than
  1.3226. Its process computes decade duration statistics after expanding
  films to country rows, changing the aggregation grain. That is a plausible
  cause of the value discrepancy, not an isolated counterfactual proof.
  Full legitimately reconstructs Task 17's adjustment from Task 16's base;
  merely using that base is not evidence of an incorrect saved version.
- **Wrong answers do not always cascade:** DSGym's Netflix Q17 final ranking
  is wrong, yet Q19 is correct. A wrong parent answer does not establish that
  its internal table is wrong or that the dependent task must fail.

No saved-state corruption or rollback transport bug was confirmed in these
valid traces. Retrieval makes past logic inspectable; it does not make that
logic correct, and the model can reuse an incorrect ranking after inspecting
it. That distinction matters more here than additional memory machinery.

The frozen automatic Q19 component rubric leaves all six answers **unscored**
because their JSON field layouts differ from its expected layout. A separate
post-run manual mapping aligns field aliases without changing values,
membership or order. It averages identity F1, requested-value accuracy and
row-order accuracy; it does not evaluate narrative claims or replace the
official grade.

| Q19 target | DSGym official / component | Full official / component | On-demand official / component |
| --- | ---: | ---: | ---: |
| Survey framework tables | 1 / 1.000 | 1 / 1.000 | 1 / 1.000 |
| Netflix sensitivity | 1 / 1.000 | 0 / 0.733 | 0 / 0.800 |

The Netflix partial scores show mostly correct reported values with a wrong
eligible market, which binary accuracy alone hides. Mappings, per-row facts
and answer hashes are included in the portable audit.

## Input integrity, recovery and verification

The earlier bounded pilot's shared input inventory was unsuitable for a clean
comparison. This round uses only the published raw inventory from
`zjunlp/LongDS` revision `6b448459c333ecc050a2e89fcc65c0e044d763ac`:
77 independently copied files, totaling 148,072,777 bytes. Published blob/LFS
hashes and local SHA-256 hashes were checked; files and directories are read
only. Seven pre-existing `working_tables/*.csv` outputs were excluded, and
the shared original data was left untouched. Questions, contexts and exact
raw paths are the solver inputs; references and gold answers remain outside
that input root. The published reference programs reproduce all 38 expected
prefix answers on separate writable raw copies.

Python mounts its raw case directory read only and writes in private scratch.
Native loaders use the same fresh absolute raw paths, but the engine has
broader host filesystem access. This is input-inventory parity, not identical
security isolation. None of the four audited old-data, working-table,
reference or gold path markers appears in the native Edit payloads.

The valid native phase is frozen at `b008d435a`. Its two completed Python
controls are reused wholesale from the original phase after strict equality
checks for baseline source, inputs and request policy. There is no selection
by score, baseline rerun or rejudging to improve the comparison.

All attempts remain on disk. Four initial native service-creation failures
had zero model requests. After restart, the gateway rejected the reference
schema's unsupported `uniqueItems` keyword: 76 rejected API requests, with
no valid model completions and unknown usage. Those failed native attempts
are reported separately and are not solver scores or zero-cost successes.
Duplicate-name validation was moved into local validation; full and
on-demand then ran the same accepted schema from fresh agents.

The harness previously continued after a terminal API error because it
mistook an end marker for completion. The post-run fix now requires a
successful Answer receipt, persists the failed turn and stops the session.
A deliberate solver nonanswer through Answer remains a completed scored
outcome. This guard was added after the valid pilot and is not claimed as
part of the revision that produced its results.

Verification passed: 1,376 agent-service tests, four new completion-guard
regressions, TypeScript checking, 131 Python harness tests, five optional
transport tests, and 29 focused Python checks after the final harness edit.
Both 190-file frozen source archives and all 77 raw input hashes were checked
again. All owned agents, workflows, computing units and the private agent
service were removed or stopped; shared backend services were preserved.

## Next decision

Keep full prompt detail as default and on-demand as an experimental option.
Before expanding the cohort, reduce redundant inspections and model calls,
and introduce a typed Python action control to separate text-protocol failures
from state-management effects. A later small comparison should use a budget
that actually binds if the intended claim is memory efficiency. The current
pilot supplies no reason to add more state machinery or launch a broad sweep
without first addressing semantic reuse and the remaining call overhead.
