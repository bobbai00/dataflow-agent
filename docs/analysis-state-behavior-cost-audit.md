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

**Behavioral model-cost audit, 2026-09-24.** Saved first-pass traces for six
tasks show avoidable tool-contract errors, repeated history searches, incomplete
answer-table reads, repeated program regeneration and some unproductive repair
loops. They also show corrections that preserve accuracy. A repeated error in
the prompt is not, by itself, another failed attempt.

This is a read-only analysis of saved runs. No model, engine, evaluation, or
judge was run. Existing scores are unchanged. The
[structured audit](analysis-state-behavior-cost-audit.json) contains per-call
usage, action categories, receipt errors, exact duplicate requests/responses,
manual case evidence and source hashes. Costs use the recorded repository
model-only rates, not invoices. All per-call totals reconcile with the frozen
results report, including captured interrupted steps.

**How much actual retrying is established?**

- Strongest `react-entries`: 22 of 360 actual dataflow calls (6.1%) contain at
  least one primary operator validation error. These calls produce 32 primary
  errors and 30 blocked dependent outcomes. Those 62 outcomes are not 62
  retries. This count excludes runtime/data errors and analytical corrections.
- Newer `react-analysis`: 18 of 689 calls have primary operator errors; 21
  additional calls reject oversized inspect/recall requests. The 21 limit errors
  ask for more than six definitions or three task entries in one call.
- Exact repeated tool arguments, ignoring only the rationale, occur once per
  arm within a question. Both cases concern Goodbooks timeout recovery. This
  deliberately narrow string check does not count revised code, changed
  selections, or semantically equivalent attempts as exact repeats.
- The supplemental changed-operator error-block counter finds 57 entries-arm
  actions and 47 newer-arm actions whose edited outputs are shown with errors.
  This is not a complete runtime-retry census: dependent failures, earlier
  attempts and runtime states require case-level interpretation. It must not be
  added to validation counts and labeled avoidable retries.
- Old errors in task-start observations recur without changed result objects.
  Survey 13, for example, replays six old errors among forty unchanged outputs.
  Those are context overhead, not evidence of six new failed executions.

**What the model spends calls doing.** The categories below are mutually
exclusive. Editing includes graph restore/fork operations; successful and failed
attempts are both included. “No tool” includes final-answer generations.

| Generation category | Entries calls | Entries cost | Newer calls | Newer cost |
| --- | ---: | ---: | ---: | ---: |
| Edit without inspect/recall | 338 | $0.967960 | 406 | $1.039204 |
| Inspect/recall without editing | 0 | $0 | 217 | $0.459444 |
| Edit plus inspect/recall | 0 | $0 | 2 | $0.006355 |
| Observe without editing/retrieval | 22 | $0.044442 | 64 | $0.096859 |
| No tool | 174 | $0.348918 | 186 | $0.235330 |
| Total | 534 | $1.361320 | 875 | $1.837192 |

The 217 retrieval-only generations are 24.8% of the newer arm's model calls
and account for 25.0% of its model cost. These are generation-cost buckets, not
causal savings: the generation requesting retrieval pays for its preceding
context, and later generations pay to ingest/replay that retrieval's response.
Some retrieval is necessary because relevant definitions were omitted from the
initial selected memory. It would be incorrect to propose removing all 217.

Within the same active question, the newer arm retrieves 46 definition responses
that exactly duplicate earlier definition text (out of 618 definition responses),
plus six repeated other inspection/task responses. These copies introduce
209,477 characters even though the earlier responses remain in the append-only
context. This is a more direct redundancy finding than labeling all retrieval
as unnecessary. The prior count of 180 inspection and 126 recall calls came
from completed-turn counters; captured interrupted work brings these to 182 and
128, with 219 calls using either or both.

The newer arm has about 52% smaller average input per model call than entries,
but 64% more calls and 35% higher total cost. More newly appended retrieval text
also incurs cache-write cost. DSGym used 424 model calls across these same six
tasks. Some difference from DSGym pays for work that the baseline declined to
perform; it is not all overhead. Coverage also differs under session limits, so
the cross-arm counts are descriptive rather than a matched-call causal study.

**Manually verified cases.**

| Case | Observed behavior | Existing result | Improvement suggested by the trace |
| --- | --- | --- | --- |
| Entries, Survey 30 | Wrong keyword input syntax, then omitted call-local function, then successful calculation and answer: 4 model calls, $0.008685 | Correct | Prevent contract mismatches; make function lifetime explicit and allow validated reuse when only bindings change |
| Entries, Survey 16 | Loader arity error, successful repair, extra filter to fetch the omitted fifteenth industry, answer: 4 calls, $0.008622 | Correct | Prevent arity error; provide complete modest final-answer tables when feasible |
| Entries, Survey 18 | Top-five table mistakenly used as the full-population denominator; reconnect complete table, answer: 3 calls, $0.005160 | Correct | Preserve correction; expose population/completeness contracts to prevent the initial mistake |
| Entries, Water 28 | Six versions of one calculation, five fresh callback failures, unrelated old result read, wrong-question answer: 8 calls, $0.024417 | Incorrect | Inspect underlying population and preserved risk definition after repeated failures; isolate the summary from training; check final answer against current question |
| Newer, Survey 15 | Oversized recall, four CSV previews, four more recall batches, then useful introduction.md read and markdown parse repair: 10 calls, $0.019458 | Correct | Resolve source/history relevance before fetching whole task archives |
| Newer, NFL 32 | Six retrieval-only actions, eight duplicated definition responses, wrong historical combination and revision attempt: 9 calls, $0.032816 | Incorrect | Retrieve exact dependency/version records; avoid rereading visible definitions |
| Newer, Water 32 | Seven retrieval-only actions, duplicate-column merge repair, extra read to complete a five-row result: 12 calls, $0.030258 | Incorrect | Select required evidence streams directly; validate merge schemas; preserve complete small answer tables |

Water 28 is especially informative. Each of six submitted function versions
contains feature assembly, model fitting, score construction and tail summary
logic. The changing error is near the summary: first nullable sulfate conversion,
then comparisons involving null values. A successful intermediate table exposes
zero high-risk potable rows and five low-risk nonpotable rows, compared with
49 and 139 in the reference. The model keeps adjusting missing-value handling
instead of investigating why the populations differ. After the repairs, it reads
an earlier error-lift result and answers that earlier question. The correct
current request remains in the model input at the point of drift.

The question consumes 520,710 input tokens and 9,095 output tokens. Most input
is cached, but repeated code generation and newly appended diagnostics still
cost money. This case supports a diagnosis-first repair policy and smaller
reusable dataflow components. It does not establish that every long function or
every runtime repair can be removed.

NFL 32 exposes a related version-binding failure. The model says its final
revision removes the positive mismatch add-on, but the action references the
existing `build_mixed_middle_players` function without changing its body. The
saved final workflow still contains `+ 0.50 * positive_mismatch_gap`; its new
documentation says the opposite. More history retrieval did not ensure that the
executed code matched the intended historical view. Retrieval and repair should
identify the actual function revision and input bindings, not rely on a changed
description as evidence of a changed computation.

Goodbooks also contains repeated responses to infrastructure timeouts: retrying
the same graph, switching aggregate implementations and trying direct-file
loaders. The traces establish timeout observations and the agent's responses;
they do not prove the agent's diagnosis of the worker/resource cause. Retrying
or rewriting analysis code cannot reliably fix a persistent service failure.
Recovery should distinguish infrastructure health from computational errors,
preserve usable results, and avoid repeated unchanged retries after an explicit
failure persists. A blanket lower step limit could also truncate useful work,
so it is not the proposed accuracy-preserving fix.

**Recommended priorities.** Improve source/version selection and deduplicate
active-context retrieval; prevent deterministic tool-contract mistakes; preserve
complete small answer tables; then add repair behavior that checks population,
schema and failed dependency before regenerating an entire calculation. Keep
the useful verification and denominator repairs demonstrated by Survey 18.
Implementing these behaviors should retain immutable history and append-only
active messages to preserve input-cache reuse.

The earlier [12–19% static savings estimate](analysis-state-cache-savings-estimate.md)
assumed unchanged model calls and output. It credits no savings from fewer
retries, less retrieval, or better behavior. This audit identifies additional
opportunities but does not assign them a fabricated savings or accuracy gain.
