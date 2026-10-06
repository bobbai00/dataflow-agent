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

# Saved versions: bounded Lite pilot, 2026-10-06

The implementation passes its mechanical checks. This pilot **does not show
a Dataflow accuracy or model-cost advantage** over ordinary persistent Python.
Seven arms score 4/8; Terra Dataflow with trajectory scores 3/8. Dataflow costs
1.59–2.05 times Python within the same model and context policy. Every question
was attempted and answered: this difference is not caused by the baseline
giving up or skipping expensive questions.

The useful observation is narrower: catalog agents used exact saved inputs
successfully, but sometimes selected the wrong stage of an earlier analysis.
Keeping a version and selecting the version the question means are separate
problems. Python retained the relevant original state too; automatic retention
was not necessary to win these short sessions.

## Scope and frozen configuration

Two **LongDS v1.1 Lite** sessions were selected before solving, validated
against the upstream Lite manifest, and run continuously from empty state:

| Session | Questions answered in every arm | State operation tested |
|---|---|---|
| `geoscience/marmara-region-earthquakes-apr-2324-2025/task1` | Q1–Q5 | Q3 cleaning changes the working population; Q4/Q5 compare with original events. |
| `education/world_university_rankings/task3` | Q1–Q3 | Q1 recomputes a score; Q2 compares original and recomputed scores; Q3 keeps the recomputed rule. |

Each of the eight arms solves all eight questions: 16 fresh sessions and
64 answers, one attempt per session. No questions were skipped, no answers
were patched, no reference solution entered an agent, and no score-selected
prefix fixture was reused. The reference code runs only in the private
evaluator; all eight reference answers reproduced the published references.

Axes are **Terra/Luna × Dataflow/Python × catalog/trajectory**. Python is our
DSGym-style persistent-kernel control, **not an unmodified upstream DSGym
reproduction**. It can freely retain copies, use versioned names, print current
variables, reread files and retrieve prior scripts. It receives script IDs,
written bindings, shapes and columns in catalog mode; script text and printed
output are retrievable. Trajectory mode preserves earlier ReAct frames. There
is no forced overwrite policy and no separate disciplined-retention arm.

Both implementations receive the same questions and first-request analysis
instructions. Framework system prompts and tools differ. Both preserve the
same task boundary across later requests within their own run.

- No added input token cap or compaction. Generation allowance is 8,192 tokens
  per call; the question limit is 40 calls/steps. Two sessions run concurrently.
- File inventories contain paths only. Agents discover headers and samples
  themselves. No file-header hints are injected.
- Catalog statistics and record snippets are off. Shape/schema remain.
  Dataflow profiling and opt-in `sample_stats` retrieval are enabled; flow
  evidence is off. Python can compute statistics in its kernel.
- Native `full` retrieval and Python printed output are bounded at 5,000
  characters. These are result presentation limits, not input context caps.
  Private observers capture complete small tables independently of prompt
  presentation, without executing or exposing evaluator state.
- Saved-version references and declared answer sources are enabled in both
  Dataflow context policies. The ledger is off.
- The same `gpt-5.2` judge uses the upstream binary rubric for every answer.
  This is not the paper's judge/model configuration and does not support a
  published-leaderboard comparison. Exact duplicate judge inputs reuse a
  verdict; unique inputs get one call, without retries.

Solver revision: **`e3b340738230d732b7b0710cfc3581ca34b6028d`**. The actual
416-file source archive and source/input hashes were frozen before solving.
Upstream checkout: `4b49ef052500c73b07b5a4955e1115da6cd9da16`. All raw input
and prepared-manifest hashes still match. The only untracked files at the
freeze were the upstream checkout symlink and an unrelated text file.

An earlier preflight request at `c2d669993` was rejected for unsupported
`uniqueItems` in the new provider tool schema, before any question was solved.
The wire keyword was removed while local duplicate validation was retained;
the full grid was then frozen afresh. Its diagnostic artifacts remain in
`pilot-schema-rejected`. That request returned no billable usage, so we do
not claim an invoice-level zero cost. It is not an accuracy retry.

## Accuracy, tokens and model cost

Costs apply the configured gateway rates to reported usage, including cached
tokens. They are estimates, not invoices. They include failed tool attempts
and model recovery within a question. They exclude local infrastructure,
building services, reference execution and observer capture.

| Model | Solver | Context | Judge correct | Solver USD | LLM calls | Input tokens | Cached input | Output tokens |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Terra | Dataflow | catalog | 4/8 | 0.3984 | 31 | 430,030 | 370,857 (86.2%) | 17,158 |
| Terra | Dataflow | trajectory | 3/8 | 0.3756 | 25 | 484,559 | 431,582 (89.1%) | 15,278 |
| Terra | Python | catalog | 4/8 | 0.2506 | 29 | 126,487 | 78,971 (62.4%) | 11,644 |
| Terra | Python | trajectory | 4/8 | 0.1843 | 23 | 142,651 | 118,807 (83.3%) | 9,408 |
| Luna | Dataflow | catalog | 4/8 | 0.0440 | 38 | 536,077 | 465,516 (86.8%) | 17,110 |
| Luna | Dataflow | trajectory | 4/8 | 0.0404 | 31 | 613,253 | 570,751 (93.1%) | 17,094 |
| Luna | Python | catalog | 4/8 | 0.0234 | 26 | 109,949 | 61,014 (55.5%) | 10,299 |
| Luna | Python | trajectory | 4/8 | 0.0197 | 24 | 152,309 | 127,681 (83.8%) | 10,202 |

Solver total: **$1.33638984**. Judge total: **$0.45365425**. Combined reported
model-cost estimate: **$1.79004409**. All 64 answers were judged, without
judge failures. The predeclared $8 solver guard was not reached; there are
no unknown-usage calls in the scored grid.

Rates in USD per million tokens (ordinary input / cached input / output):
Terra **2 / 0.2 / 12**; Luna **0.2 / 0.02 / 1.2**; judge **1.75 / 0.175 / 14**.
Reported cache writes are zero. Within-model comparisons matter; aggregating
Terra and Luna into one relative-cost claim would mix different price levels.

Dataflow catalog reduces total input tokens by **11.3% on Terra** and
**12.6% on Luna** versus trajectory, but costs **6.1% and 8.7% more**. It makes
more calls and has more uncached input; fewer total input tokens alone do not
establish a saving. Python catalog also costs more here. The experiment
demonstrates actual provider prefix reuse, not a guarantee that every
immutable frame will be cached.

Across the grid, Dataflow uses 125 model calls, 2.06 million input tokens
(including cache hits) and 66,640 output tokens; Python uses 102 calls,
0.53 million input tokens and 41,553 output tokens. The richer native
system/tools, receipts and recovery steps have a cost even with good caching.
This experiment does not isolate the catalog from those framework differences.

Measured solve time, summed over the eight questions, is 236/220 seconds for
Terra Dataflow catalog/trajectory versus 137/113 for Python; Luna is 292/261
versus 125/136. These include the solver's tool execution and result access,
but not setup/observer work. They are not isolated engine timings, and two
concurrent sessions introduce scheduling noise.

For the matched questions both solvers judge correct, the cost gap remains:

| Model | Context | Both correct | Dataflow question USD | Python question USD |
|---|---|---:|---:|---:|
| Terra | catalog | 4 | 0.15731 | 0.08943 |
| Terra | trajectory | 3 | 0.11968 | 0.03818 |
| Luna | catalog | 4 | 0.01723 | 0.00902 |
| Luna | trajectory | 4 | 0.01582 | 0.00652 |

This supplementary slice is conditional on each natural prefix. It does not
subtract unsuccessful prefix questions from the headline full-session cost.

## What the misses mean

All university Q1/Q2/Q3 answers pass in every arm. All earthquake Q1/Q2/Q4/Q5
answers fail the binary judge. Earthquake Q3 passes except on Terra Dataflow
trajectory. The resulting totals are 31 correct of 64; these are not 64
independent benchmark tasks.

**Answer contract and judge sensitivity.** Earthquake Q1/Q2 answers often
have correct counts and geometry but describe their own equivalent column
names. The judge demands reference names such as `origin_time`, `event_day`,
`hour_bucket` and `minute_bucket`, which the question does not prescribe as an
output schema. Some answers also give an hour without its date or omit seconds.
We keep every official zero; a naming-sensitive zero is not evidence that the
old state was inaccessible. There are genuine Q2 deviations too: Luna
Dataflow trajectory misclassifies four place-family rows, Luna Python
trajectory misbins one bearing, and Luna Dataflow catalog omits empty compass
sectors from its report.

**Wrong earlier population, despite successful retrieval.** Six of the eight
earthquake Q4 runs use 265 events after the distance filter where the reference
comparison starts from all 289 original events. Terra catalog explicitly
connects `earthquake_sequence_grid@3`; Luna catalog connects `eq_not_far@3`.
The engine serves those saved values correctly. They are the wrong stage for
the question. The affected-hour comparison loses E067 and reports 30 rather
than 31 original main-belt events. All six have complete observed
wrong-population tables, including Python's selected working tables after
rebuilding earlier calculations.

The other two Q4 runs fail differently. Luna Dataflow trajectory has the full
289-row original population, but its earlier place classification has already
excluded E067 from the main belt. Terra Python trajectory counts all events
instead of the requested main-belt events. These are a cascade from an earlier
transformation and a new scope/filter mistake, respectively.

**Cascades and fresh computation errors.** The missing original event carries
into Q5's removed-pressure denominator: several runs report 2.2101% instead of
4.3145%. Luna Dataflow trajectory also selects far removals rather than all
non-retained reports, producing no removed events and 0%. Terra Python
trajectory gets the share and removed events right but omits required
`pressure_rank_if_retained` values. State availability does not fix any of
these automatically.

**Clock basis across operators.** Terra Dataflow trajectory explicitly
localizes reported timestamps to Europe/Istanbul. The engine transports the
instants in UTC; a downstream function derives hour/minute buckets without
converting back, shifting 13→10 and 14→11. This explains its extra Q3 miss.
It is a transformation/interface mistake, not failed historical retention.
The source-time anchor uses the declared timezone; it does not certify the
correctness of those downstream buckets.

**Tool recovery costs.** Dataflow has 20 failed tool calls across its four arms
versus one Python script execution error. Examples include null arithmetic in
row callbacks, timezone-naive or nested output cells, unconnected inputs,
wrong columns across a batched read and invalid edit grammar. Python's
vectorized numeric operations tolerate missing numeric values more naturally.
All agents ultimately answer every question. These errors consume calls and
tokens even where the final university answer is correct.

One invalid current-column request was labelled
`HISTORICAL_RESULT_UNAVAILABLE` by the client. The result still existed. The
follow-up fix **`9792c9a66`** distinguishes invalid requests, actual missing
materializations and service failures, with a regression test. We did not
rerun paid solvers after that fix; the table above remains the frozen run.

## State measurements and their coverage

The private scorer uses 88 explicit, trace-audited table adapters, with
numeric tolerances of 1e-8. Renames align equivalent column names; masks can
represent a materialized retained population. No adapter guesses a table's
meaning from its ID or chooses the best-scoring candidate. Missing columns or
an unmaterialized working table remain **unknown**, rather than a pass or fail.

| Model | Solver | Context | Anchor matches | Misses | Unknown | Earlier-task dependency precision / recall |
|---|---|---|---:|---:|---:|---:|
| Terra | Dataflow | catalog | 9 | 1 | 1 | 1.00 / 1.00 |
| Terra | Dataflow | trajectory | 10 | 1 | 0 | 1.00 / 1.00 |
| Terra | Python | catalog | 10 | 1 | 0 | 1.00 / 1.00 |
| Terra | Python | trajectory | 11 | 0 | 0 | 1.00 / 1.00 |
| Luna | Dataflow | catalog | 9 | 1 | 1 | 1.00 / 1.00 |
| Luna | Dataflow | trajectory | 8 | 2 | 1 | 1.00 / 0.958 |
| Luna | Python | catalog | 9 | 1 | 1 | 1.00 / 1.00 |
| Luna | Python | trajectory | 9 | 2 | 0 | 1.00 / 1.00 |

Overall: **75 matches, 9 misses, 4 unknown**. These are selected analytical
roles and columns, not 88 complete-answer accuracy checks. Earthquake Q3/Q4
population checks compare event-ID sets, not every derived column. Q2 checks
place family, distance, bearing, near/far flags and, separately, main-belt
membership. University checks distinguish original and recomputed scores on
named universities and compare 2015 country assignments and scores.

The raw university file has one unnamed 2013 placeholder that the reference
explicitly skips: most agents retain 4,897 rows versus 4,896. Named-university
anchors explicitly exclude that placeholder; the difference is recorded here
and is not presented as an old-version failure.

Three of four Dataflow Q5 runs compute the complete pressure table inside a
callback and expose only reports. Their full pressure state is unmeasured.
Python exposes complete pressure tables in all four runs. The remaining unknown
is Luna Python catalog's Q2 main-belt flag, which was not stored in that table.
This is a material limitation of graph granularity: a saved operator cannot
expose an intermediate table that never became an operator output.

Dependency scores compare declared answer-root graph closures or observed
script-block reads with the benchmark's annotated earlier-task closure.
Dataflow's table uses the **definition-introducing task**, and the JSON also
reports literal checkpoint agreement. Reading `x@3` when its definition came
from task 1 does not imply a dependency only on task 3. This is task-level
annotation agreement, not proof of row/column lineage or a uniquely correct
algorithm. All reported references resolve. Luna Dataflow trajectory Q5
hardcodes Q4's candidate IDs instead of wiring its result, explaining its
missing graph dependency on Q4.

Post-run evaluator corrections exclude future same-value Python writes from
earlier lineage, traverse immutable saved handles omitted from the visible
operator delta, and count actual nested execution receipts. Each correction
has regression coverage. Evaluator revisions do not alter solver traces.

Additional observed checks:

- All eight Q3 cleaned populations match the reference's 262 event IDs. This
  is an update-result check; it does not establish a general stale-rule rate.
- Original and recomputed named-university scores are separately correct in
  all eight Q2 runs. The named recomputed score table is unchanged from Q1 to
  Q2 in all eight. This verifies visible default preservation, not every
  hidden object in the kernel.
- Catalog Dataflow completes **12 saved-result reads** and receives
  **24 cached historical-input appearances** in execution receipts. An
  appearance is an outcome in an execution, not a distinct version or measured
  time saving. Trajectory Dataflow uses current retained operators and makes
  no explicit saved-address reads/edges.
- No pilot agent uses `diff`, editable-definition variants or definition
  reapplication. Those operations are verified mechanically, not by this
  benchmark table.
- All **32 Dataflow task deltas** match the successful edits in first-edit
  order, including working operators that are not answer ancestors. All
  **52 comparisons** with later captures preserve the earlier TaskRecord;
  all **52 prompt comparisons** preserve its canonical boundary content in
  catalog and trajectory. Trajectory wraps that content in its original tool
  receipt. These are actual-trace checks, separate from provider caching.

At earthquake Q5, the four prior catalog boundaries occupy 12,979 characters
on Terra and 13,214 on Luna. They include definitions, inputs, schema/shape
and answers, with bodies and records off. This is measured size on five-turn
sessions; do not extrapolate a long-session saving from it.

## Implementation verification and next decision

The revised state contract separates exact `operator@task` values, old rules
on current inputs, and editable variants with saved direct inputs. The live
five-task fixture verifies all three, in-place updates, a diff with an old
cached input, changing the original file without changing the old table, and
immutable prior records. Deliberate eviction fails explicitly without
rebuilding historical ancestors. Three migrated live engine suites pass:
`task-context-run`, `observation-format-run`, `history-retention-run`.

Final checks: **1,444 agent tests**, typechecking, **49 Python runtime tests**,
**41 focused harness/scorer tests**, and **18 tests in the latest two focused
engine suites**; earlier fingerprint checks also passed. The live fixture
found and fixed cached-handle lookup by registered port, and full observer
pagination found and fixed small JSON row-count deserialization. The paid
preflight found the provider-schema keyword issue. All eight owned pilot
agents/workflows/computing units were removed after capture; shared services
were preserved.

The pilot is an illustration, with one attempt on short sessions and no
uncertainty interval. The longest reach-back is four turns. University Q2's
correlation rounds to 1.00, so comparing a score to itself can also pass the
answer judge; the separate original-score anchor is essential. Neither session
forces loss of an old value, and both Python variants retain useful originals
or rebuild them cheaply from unchanged files. These are weak conditions for
a historical-retention advantage.

**Do not scale this configuration yet.** The next useful work is to reduce
native null/output-contract recovery and expose complete derived working
tables, then predeclare one natural Lite sequence that changes a reusable rule
and later requests its earlier values and a downstream update. Keep Python's
free retention policy. Measure whether the needed version actually survived,
whether each solver selected the correct stage, what remained stale after an
update, and the compute/read cost of recovery. Automatic versioning has a
defensible governance and recovery claim; this pilot does not justify selling
it as higher accuracy or lower cost.

## Artifacts and evaluator replay

Machine summary: [saved-versions-lite-pilot-20261006.json](saved-versions-lite-pilot-20261006.json).
Explicit state mappings: [saved-versions-lite-adapters-20261006.json](saved-versions-lite-adapters-20261006.json).
Contract: [state-versions-design-2026-10-06.md](../../../docs/observation-format/state-versions-design-2026-10-06.md).

Local root: `/var/tmp/versions-lite-pilot-20261006/`. `pilot/protocol.json`
and `source.zip` pin source/settings/data; `pilot/runs/<session>__<model>__<solver>__<context>/tNN/`
holds each answer, judge, trace and private observation. `private-oracle/`
holds reference tables, and `pilot/postrun-audit.py/.json` records the actual
delta/frame/preservation checks. Model-free validation artifacts are
`/var/tmp/lean-versions-live-check-6/verification.json`,
`/var/tmp/lean-versions-eviction-check/eviction-result.json`,
`/var/tmp/versions-lite-observer-check-3/` and
`/var/tmp/versions-lite-python-check/`. These local artifacts are not tracked
in git; their compact summaries and adapter hashes are tracked here.

Recompute state metrics from the existing observations, making **no model calls**:

```bash
.venv/bin/python benchmark/longds/context_state_score.py evaluate \
  --root /var/tmp/versions-lite-pilot-20261006 \
  --adapters benchmark/longds/reports/saved-versions-lite-adapters-20261006.json \
  --no-judge
```
