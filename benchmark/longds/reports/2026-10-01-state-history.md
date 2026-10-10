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

# LongDS historical state: results and trace diagnosis

## Conclusion

**The combined goal is not met: higher accuracy, fewer state errors, and no
greater solver cost than DSGym.** The initial Terra history arm costs about the
same as saved DSGym, but answers only 43/100 questions correctly versus 77/100.
The subsequent repairs improve some concrete mechanisms and reduce cost on
the selected follow-up, but do not establish an accuracy advantage.

The strongest finding is about **choosing the correct existing state**.
Several failures occur while both the correct and incorrect tables still
exist. Dataflow exposes the wrong edge and makes the error diagnosable; merely
preserving versions does not make the model select the right population,
aggregation grain, or scoring definition.

**No solver invoked historical inspect, historical retrieve, or fork in these
runs.** Their definitions were present in the history arm's actual wire
requests. These results evaluate offering the tools, not their effectiveness
when used. Keep the feature optional; the evidence does not support expanding
it into a task catalog.

## Scope and protocol

- Initial comparison: 14 sessions, 264 planned questions, 258 recorded answers.
  Terra has 100 questions in each native arm. Luna has 32 baseline answers and
  26 history answers; six Restaurant questions were never submitted after a
  transport failure. Comparisons use matching question IDs.
- Follow-up: four fresh sessions, 46 questions: Restaurants 1–8 on Luna and
  Terra, Kiva 1–26 on Terra, Netflix 1–4 on Terra. Earlier results remain intact.
- Each native session uses one persistent workflow, ordinary ReAct, append-only
  DELTA history, 40 calls per question, and a 2,000-character result budget.
  Models are `gpt-5.6-luna` and `gpt-5.6-terra`, medium reasoning effort.
- Correctness: original Appendix E.2 prompt, `deepseek/deepseek-v4-pro`.
  Prompt SHA256: `5bb32f993b72cb515a675f55808145247bc81211dd05e7253135bb01b0d2c300`.
- Error classification: original Appendix E.3 rubric through Codex `gpt-5.5`,
  `xhigh`. The adapter supplies saved traces, code, reference code and frozen
  correctness judgments. It validates coverage of every incorrect question,
  categories, upstream IDs and summary counts. Manual findings remain separate.
- Dataset revision: `bf41bb28474fa9540d98922a6f5e6310ed014e51`.
  The solver's prepared input excludes reference answers and code.

The saved DSGym Terra run is historical: its gateway version, temperature and
execution interface differ. This is a diagnostic comparison, not a controlled
leaderboard result. Each configuration has one stochastic run. Follow-up cases
were selected after trace inspection and combine several repairs.

## Initial Terra results: identical 100 questions

| Session prefix | Questions | DSGym correct | Native baseline correct | Native history correct |
|---|---:|---:|---:|---:|
| NFL | 3 | 1 | 3 | 2 |
| Restaurants | 29 | 21 | 18 | 19 |
| Kiva | 26 | 19 | 16 | 6 |
| Netflix | 19 | 19 | 7 | 6 |
| Survey | 23 | 17 | 19 | 10 |
| **Total** | **100** | **77** | **63** | **43** |

| System | Estimated solver cost | Primary State errors | Any State label | Primary Cascade errors |
|---|---:|---:|---:|---:|
| DSGym Terra | $5.0165 | 7 | 7 | 5 |
| Native baseline Terra | $5.4587–5.6257 | 4 | 4 | 17 |
| Native history Terra | $4.8588–5.0094 | 7 | 10 | 30 |

Fewer primary State labels alone would be misleading: baseline has fewer than
DSGym but lower accuracy and many more cascades. A root error can occur in a
passing question and become visible only in later answers. The classifier
labels incorrect answers rather than certifying every intermediate state.

For Luna's matching 26 questions, baseline scores 5/26 and history 10/26;
DSGym Terra scores 18/26. This is not a same-model comparison. Repricing saved
DSGym usage at Luna rates also shows that lower Luna prices alone explain its
apparent dollar advantage: on the 23 matching Restaurant questions, native
baseline/history cost $0.2473/$0.1985 versus $0.1634 for DSGym usage at Luna rates.

The initial Restaurant runs were affected by an engine heap failure. NFL and
Restaurants used the earlier engine; Kiva, Netflix and Survey used the cache
fingerprint fix. Treat the initial table as observed campaign outcomes, not an
engine-controlled estimate of the history feature's causal effect.

## Follow-up after repairs

Each row uses the same question prefix before, after and in saved DSGym.
Costs include unsuccessful answers and repair calls; none were removed.

| Model / prefix | Before correct | After correct | DSGym correct | Before cost | After cost | DSGym cost |
|---|---:|---:|---:|---:|---:|---:|
| Luna Restaurants 1–8 | 5/8 | 4/8 | 8/8 | $0.0594 | $0.0583 | $0.4778† |
| Terra Restaurants 1–8 | 6/8 | 5/8 | 8/8 | $0.4482 | $0.3061 | $0.4778 |
| Terra Kiva 1–26 | 6/26 | 14/26 | 19/26 | $1.2511 | $1.1511 | $1.1330 |
| Terra Netflix 1–4 | 0/4 | 1/4 | 4/4 | $0.2048 | $0.2191 | $0.2806 |

† DSGym used Terra; the same usage at Luna prices is $0.0478. Do not count this
as a same-model cost improvement.

Across the 38 Terra questions, accuracy rises from **12/38 to 20/38**, while
DSGym scores **31/38**. Estimated solver cost falls from **$1.9041 to $1.6763**,
versus **$1.8915** for DSGym. That is about 12% below the previous run and 11%
below DSGym, with a substantial accuracy gap remaining. Kiva alone still costs
about 1.6% more than DSGym.
Pricing every unknown uncached token as a cache write raises the follow-up
Terra estimate to $1.7354, which remains below the saved DSGym estimate.

| Terra follow-up: 38 questions | Primary State | Any State label | Primary Cascade |
|---|---:|---:|---:|
| Before repairs | 2 | 3 | 18 |
| After repairs | 2 | 2 | 9 |
| Saved DSGym | 0 | 0 | 3 |

State errors are not reduced below DSGym. Codex labels the new Kiva rollback
mistakes primarily State Management; the similar DSGym mistakes are primarily
Context Memory. The new labels are consistent with the observed wrong score
columns, but a single category count is not a reliable measure of comparative
state handling. All **304 recorded native answers** are judged, and all **158
incorrect answers** have validated classifications across 18 sessions. Critical
mechanisms were manually checked against traces; schema validation does not
guarantee that every causal label is correct.

## What the traces show

### Kiva: an eligibility edge was repaired, then a rollback formula was lost

In the initial history run, Task 5 connects `country_quality` directly to
`country_quality_with_region`, bypassing `qualified_countries`. The stricter
population becomes 75 countries instead of 48. Task 5's answer passes, but the
wrong population changes later percentiles; Task 7 is the first visible numeric
failure. The classifier assigns 15 later primary Cascade errors.

The follow-up uses `eligible_countries` as the actual input to the regional
filter: 53 eligible countries become 48, with 602,308 loans and 658 cells.
Task 7's five rows and component scores now match the reference. For example,
Indonesia/Housing social priority is 66.323, correcting the earlier 67.337.
This verifies an improved population in this run, not an isolated prompt effect.

The final rollback questions still fail a different contract. Tasks 25–26 keep
the complete-data population and Task 26 correctly references
`complete_final_top10`. But they sort `poverty_priority`/`social_priority` directly,
omitting the required 55% demand plus 45% specialized partner-efficiency blend.
The older native runs retained that blend; DSGym also forgot it. Preserving the
right population and an old column is insufficient to restore the old scoring
definition.

Two other follow-up errors explain why fixing eligibility does not eliminate
the gap. Task 2 feeds an unsorted score table directly into `early_top10`, and
Task 13 percentile-ranks the high-MPI-region share although the formula requires
the raw share. Both are visible in the expressions; later poverty-stage
comparisons inherit the second error.

### Restaurants: the correct table exists, but the agent selects another one

Follow-up Luna Task 3 creates `advance_filter_t3`. Task 4 builds a separate
sensitivity branch and leaves Task 3 intact. Task 5 nevertheless connects the
unfiltered `decision_final_t3` to `advance_keys_t5`, admitting hold/diagnose units
into an advance-only analysis. This is wrong state selection with intact history.

Earlier Luna traces also copy eight displayed names into Python sets instead of
using the full 84-unit pool. Dependencies embedded as literals cannot be recovered
from graph edges alone. An operator graph records declared dependencies; it
does not reveal arbitrary hidden dependencies inside Python.

Follow-up Terra repairs the state selection behind Task 7 and reduces cost,
but introduces threshold/priority coding errors in Tasks 4 and 6, followed by a
Task 8 cascade. Primary State labels fall from one to zero on this prefix while
accuracy falls from 6/8 to 5/8. This is why accuracy must remain a joint criterion.

### Netflix: source coverage, semantic errors, and a report reused as state

Both initial native runs omit the United States input `multiTimeline.csv`,
leaving 14 markets instead of 15. Missing a source changes percentile ranks
and credit gains. The follow-up includes all 15 markets and gets Task 4's
credit gains right, including the US gain of 488.

It still counts missing movie duration over all titles, including series,
and maps `UR` to adult rather than unrated. These are semantic mistakes that
historical forking cannot repair by itself.

The initial history run also connects an eight-market report into subsequent
freshness scoring, using a display subset as the full ranking population.
The full population and the final top-N report need distinct operator identities
and careful input selection.

### Survey: scripts also retain alternative states

Raw DSGym code keeps both `hybrid_ranked` and `strict_ranked`. Its later Task 18
nevertheless rebuilds the temporary hybrid interpretation instead of using the
standing strict view. It is inaccurate to describe this as simply overwriting
all previous script state.

The native history run uses the standing strict branch later, but Task 13 has
already recomputed role-specific experience anchors instead of using the global
anchors. The wrong aggregation grain then propagates. Native baseline preserves
the global anchors and scores 19/23 versus history's 10/23 and DSGym's 17/23.

Codex labels the similar Task 13 mistake primarily Statistical/Domain in native
history and State Management in DSGym. Counts require mechanism-level review;
the original labels are preserved rather than silently harmonized.

### Grading disagreements are retained

Kiva Task 6 exposes a concrete inconsistency in the correctness judge. DSGym,
both original native arms, and the follow-up report the same requested seven
pairs, pressure values and regional-quality shares. DSGym and the follow-up
pass; the original native judgments demand additional loan-count, wait and
completion fields that the passing judgments explicitly call unrequested.
This contributes to the observed before/after score difference. All original
scores remain unchanged; the manual audit records the disagreement. It does
not explain the much larger overall accuracy gap.

## Context, cost, and operational checks

**Prefix caching is functioning.** The wire audit finds zero changed historical
prefixes. Initial Terra cached-input shares are 97.43% baseline and 97.27%
history; follow-up Terra is 96.45%. No historical catalog is appended.

Caching does not make growing history free. Kiva follow-up grows from 7,535
input tokens to 66,980 on the last call, of which 66,196 are cached. In the
initial Terra history cost, cached reads account for $2.1446 of $4.8588, output
for $2.1117, and unclassified uncached input for $0.6024. Savings need fewer
unnecessary calls and less repeated content as well as a stable prefix.

The earlier compact-receipt change avoids returning the full submitted edit
program again in the model-visible tool receipt. Full receipts remain in the
audit artifacts. This reduces duplicate content without rewriting prior messages.

Cost accounting uses frozen repository rates per million tokens:

| Model | Ordinary input | Cached read | Cache write | Output |
|---|---:|---:|---:|---:|
| Luna | $0.20 | $0.02 | $0.25 | $1.20 |
| Terra | $2.00 | $0.20 | $2.50 | $12.00 |

These are estimates, not invoices or current price quotes. Saved DSGym summaries
incorrectly applied Luna rates to Terra; all comparisons above reprice its raw
calls. LiteLLM 1.83.10 drops cache-write usage during Responses-to-Chat conversion.
Native base estimates price unknown writes as ordinary input; the range's upper
end prices every unknown uncached input token at the write rate. Cached-read
counts are observed. Judges, annotation, infrastructure and earlier revisions
are excluded from matched solver cost and accounted for separately.

Across all recorded native attempts in this private runtime, including earlier
revisions and repairs, solver usage is estimated at **$13.18–13.60**. Recorded
correctness calls report **$0.6445** in provider cost. Codex annotation records
24.12 million input tokens (21.69 million cached) and 412,562 output tokens;
its billed dollar cost is unknown. These totals exclude the coordinating
assistant, historical DSGym and unrecorded provider attempts. They are separate
from the matched solver comparisons above.

Operational findings and fixes:

- **Heap exhaustion:** recursively embedded Python definitions made cache
  fingerprints enormous. SHA256 fingerprints reduced a 91-operator replay from
  11,986,349 to 55,171 bytes (99.54%). The private engine's patched run has no new
  `OutOfMemoryError`. Cache identity and invalidation checks pass.
- **Dropped WebSocket completion:** the client now recovers only an acknowledged
  current message's terminal answer from REST. It never resubmits that question
  or returns an old initialization answer. Original Netflix Tasks 18–19 continued
  on the same agent after Task 17 recovery. Follow-up Kiva Tasks 25–26 recovered
  automatically. The original interruption and exit code remain recorded.
- **Misleading sample position:** a retained sample index was presented as a
  stored row position. Netflix treated the fourth displayed sample as full-table
  row four, although it was row five. Labels now say `Sample record`; nine
  engine probes confirm sort/cache ordering was correct.
- **Tool friction:** cross joins accept omitted/empty keys; single-input process
  ports accept `.in` and canonicalize it to `.in[0]`. Offline replay accepts
  seven of ten previously failed edits; the other three have additional real
  errors. This is not a measured dollar saving by itself.
- **Repeated attempts:** Survey's nine Task 7 probes and Luna Restaurant Task 8's
  retries are finite repair attempts. No confirmed infinite loop was found.
  An unrelated failed branch can still block whole-workflow execution. Repeated
  stats-persistence `ConcurrentModificationException` logs also remain an engine
  issue; neither is claimed fixed here.

The experiment uses the private `longds-state-history` Docker project, dedicated
ports (agent 3015, web 28080, engine 28085), and bounded experiment cgroups.
Existing shared Texera services are not restarted or reconfigured.
The native experiment's enforced cgroup v1 limits are four CPU cores and 10 GiB
memory (8 GiB soft limit). Memory reached the hard limit and incurred allocation
pressure; the kernel recorded zero cgroup OOM kills. These bounds prevent
unbounded growth, but do not imply an absence of resource pressure.

## Implementation and validation

| Commit | Change |
|---|---|
| `757f07580` | Optional historical inspect, retrieve and fork in the persistent workflow |
| `c8251faed` | Compact model-visible action receipts |
| `e985bf29d` | Share frozen snapshot definitions |
| `1d2e7e1d7` | Recover tool choice from gateway multiple-choice responses |
| `7919176cd` | Recover missing completion notifications; initial solver revision |
| `638e2b80f` | Bound engine cache fingerprint payloads |
| `0f9d1970d` | Recover dropped terminal steps with current-message safeguards |
| `8fab7431b` | Tool fixes, sample labels, source coverage and state-selection guidance; follow-up solver revision |

Validation: **1,161 Bun tests pass**, typecheck passes, **14 Scala tests pass**,
real-engine historical fork/retrieve/rewiring/invalidation preflight passes,
six cache-identity/invalidation transitions pass, and nine sort/cache probes pass.
The follow-up freezes 232 source-file hashes at `8fab7431b`; no solver-source
changes were made during the run. Its private WorkflowCore JAR is from
`638e2b80f`; unrelated service JARs remain at the recorded base revision.

## Recommended next experiment

Keep one workflow and the small optional history interface. Prioritize proving
**selection of the intended population and scoring definition** before adding
more storage or retrieval concepts.

1. Start a small diagnostic comparison from the same verified warm-up state.
   Include wrong-existing-table cases and cases that genuinely require a prior
   version after an update/deletion. Separate these strata in the results.
2. Compare ordinary ReAct against one intervention: before extending a prior
   result, select its source operator and inspect its actual incoming edges and
   expression. Check the full population, earlier eligibility gates and scoring
   grain. Existing inspection should return the local dependency slice on demand;
   do not append a catalog to every turn.
3. For rollback, inspect the historical scoring expression and its upstream
   closure. Preserve its original percentile-rank domain, then restrict
   candidates to the requested current eligibility set. These are separate
   choices: rebuilding historical ranks after filtering can change the scoring
   definition. Retrieving an old score column alone is not sufficient. Measure
   whether the model actually invokes these operations.
4. Retain identical model, budget, gateway and both original judges. Report
   accuracy, primary/any State labels, root-to-cascade chains, all solver cost,
   and task-entry correctness. Use held-out cases after the diagnostic run;
   repeated prompt tuning on these same prefixes cannot establish generalization.

Separately, evaluate an explicit execution target that runs only its ancestor
closure if unrelated broken branches continue to dominate retries. That would
change execution scope and needs its own correctness/invalidation experiment.
It is not implemented in this follow-up.

## Evidence

Portable aggregate results: [metrics](2026-10-01-state-history.metrics.json).
Repository-local control files and host-local raw traces remain available:

- [Initial manifest](../../../logs/longds-state-history-20261001/compact/campaign.json),
  [accuracy and cost](../../../logs/longds-state-history-20261001/compact/cost-comparison.json),
  [error labels](../../../logs/longds-state-history-20261001/compact/label-comparison.json).
- [Follow-up manifest](../../../logs/longds-state-history-20261001/followup/campaign.json),
  [paired repairs](../../../logs/longds-state-history-20261001/followup/repair-comparison.json),
  [manual audit](../../../logs/longds-state-history-20261001/followup/manual-audit.json).
- [Judge disagreements](../../../logs/longds-state-history-20261001/compact/judge-audit.json),
  [gateway audit](../../../logs/longds-state-history-20261001/compact/gateway-audit.json),
  [context growth](../../../logs/longds-state-history-20261001/followup/context-size-audit.json),
  [all recorded experiment spend](../../../logs/longds-state-history-20261001/experiment-spend.json).
- Raw initial runs: `/var/tmp/texera-state-history-20261001/compact/runs/`;
  follow-up runs: `/var/tmp/texera-state-history-20261001/followup/runs/`;
  wire requests: `/var/tmp/texera-state-history-20261001/wire/`.
  Each annotation directory preserves its input prompt, Codex log, raw and
  validated labels, and validation status.

After evaluation, the private stack was shut down through its local-dev profile;
its containers were removed while volumes and evidence were preserved. Both
campaign controllers exited successfully. Shared web/master PIDs 936256 and
938118 remained running with unchanged start times. The portable metrics and
this report are committed; large local logs and traces remain outside Git.
