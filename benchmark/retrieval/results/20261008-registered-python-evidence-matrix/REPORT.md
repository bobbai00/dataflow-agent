# Stopped evidence matrix: trace audit — 2026-10-08

The execution and observation path worked in the inspected traces. All 25 completed answers were correct, independently checked against the local input files. That does not establish flawless model behavior: formatting violations, unnecessary calls, calculations outside the graph, and model-gateway timeouts remain. No new model or scoring calls were made for this audit.

## Scope and interpretation

- 72 attempts were planned; 25 completed, two were canceled by the user, and 45 never started. The canceled attempts remain unscored.
- These are three unique questions repeated across models/settings: five archaeology, eleven legal, and nine biomedical completed attempts. Coverage is uneven; model averages are not a balanced ranking.
- Each setting had one planned repetition. No model/task combination completed all four configurations. Observed paired differences are descriptive, not evidence of an accuracy gain.
- The runtime source remained fixed: all 1,011 captured files under `agent-service/src` and `amber/src` match their launch hashes. Two offline audit files changed to handle developer-role prompts and distinguish actual statistics from suppression notices; execution code did not change.

Independent answer checks: archaeology selected São Paulo (population 23,086,000) from 4,095 eligible rows among 44,691 cities; legal computed 1,135,291 / 86,250 = 13.162794202898551; biomedical matched all 95 score rows to metadata and found the unique minimum for S019 (−2.15300777), age 60.

## Model behavior and cost

The table describes completed attempts only. Dollar amounts use the launch manifest’s frozen token rates and captured cache reads/writes; they are estimates, not invoices. Task and evidence-setting mixes differ. Latency is agent-turn wall time, excluding scoring. DeepSeek’s cost range covers only its three fully accounted completed attempts.

| Model | Correct completed | Unique questions | Requests/task | Agent seconds/task | Estimated USD/task | Cache-read share* |
| --- | ---: | ---: | --- | --- | --- | ---: |
| GPT 5.6 Luna | 6/6 | 3 | 3–5 | 13.2–33.4 | $0.0013–$0.0034 | 77.7% |
| GPT 5.6 Terra | 4/4 | 2 | 3–7 | 11.7–42.7 | $0.0145–$0.0692 | 78.7% |
| GPT 5.6 Sol | 4/4 | 2 | 3–7 | 15.5–44.0 | $0.0432–$0.0955 | 78.0% |
| Claude Opus 4.8 | 4/4 | 3 | 3–10 | 15.0–51.9 | $0.0476–$0.3144 | 81.4% |
| Qwen3.8-27B | 3/3 | 2 | 5–12 | 62.3–69.3 | $0.0077–$0.0250 | 84.0% |
| DeepSeekV4.1-Flash | 4/4 | 3 | 3–7 | 12.4–228.9 | $0.0037–$0.0073 | 70.0% |

*Cache-read shares use attempts with complete usage accounting. They include initial calls and can benefit from earlier runs sharing a prefix; these were not cold-cache measurements.

- **Luna:** lowest observed cost and fewest calls in its completed cohort; no failed tool calls. Two archaeology responses omitted the explicitly required Markdown bolding.
- **Terra:** solved its completed cases, but the biomedical flow-only run guessed the key column twice before inspecting actual names. This produced four failed actions across two calls, including downstream retrieval failures.
- **Sol:** generally efficient and accurate. One call used Python `true` instead of `True`; validation rejected it before applying the edit, and the next call repaired it.
- **Opus:** no failed tool calls, but biomedical used ten calls, including repeated preview retrievals. Both legal runs retrieved the yearly values and then computed the final ratio in the answer, without an executed ratio operator. Answers were correct, but the final computation was not represented in the Dataflow.
- **Qwen:** correct in all three completed cases, but biomedical needed eleven and twelve calls. Across its three runs, ten calls contained edits without execution/retrieval, with another inspect/edit call similarly separated. Many operations could have been batched. One biomedical answer omitted the required final-answer label.
- **DeepSeek:** four completed answers were correct. Three biomedical attempts encountered model-request timeouts: one recovered and completed; two were later canceled by the user. One canceled run had already computed age 60 but combined retrieve and answer, causing envelope rejection; its repair request was canceled. This is not an incorrect final answer, but it shows an instruction-following problem.

Only 22/25 completed responses satisfied the exact required `**Final Answer: <value>**` last line. Official scoring awarded all 25 a full score, so format compliance must be reported separately. Six completed tool calls contained ten failed actions; these were recovered, and the action count includes downstream consequences of a single underlying error.

### Accounting and caching

- Across all 27 started attempts: **143 requests, 137 responses with usage, four 180-second timeouts, and two requests canceled by the user**. The 25 completed attempts contain 128 requests and 127 model decisions/responses; the extra request is a timeout retry.
- All **116 adjacent request prefixes** were preserved, with no changing tool schema within an attempt. The four timeout retries were byte-identical to the timed-out requests.
- Fully accounted completed runs had **79.6% cache-read input tokens**. Cache reuse is established by returned usage, not prefix equality alone.
- Captured input/output totals for completed attempts are **1,263,924 / 26,841 tokens**; the input total includes repeated cached context and the one incomplete attempt’s known responses. Largest single reported input was 27,844 tokens, and largest single output was 666 tokens. There was no runaway output generation.
- The 24 completed attempts with complete usage sum to **$1.102160** at frozen rates. Known-response subtotals across all 27 started attempts sum to **$1.117108**; this is **not the total cost**, because six requests returned no usage.
- OpenRouter response costs remain separate from frozen-rate estimates. Qwen’s three completed runs report **$0.026482** in total, versus the frozen-rate estimate of **$0.054883**. DeepSeek’s observed provider subtotal across all six started attempts is **$0.018144**; whole-run totals remain unknown where requests timed out or were canceled.
- OpenAI responses omit cache-creation classifications; recorded estimates disclose the assumption that remaining unclassified input uses the normal input rate. Cache reads and writes are not double-counted; reasoning is already included in output. Scorer and infrastructure costs are excluded.

## What worked at the system level

All 143 wire requests matched the captured registered-Python system prompt for their settings. Tool view choices and prompt guidance switched together. There were no evidence-exposure violations in the inspected completed or canceled traces.

| Evidence configuration | Completed | Runs that actually showed table statistics | Runs that showed flow evidence |
| --- | ---: | ---: | ---: |
| Neither | 6 | 0 | 0 |
| Flow only | 5 | 0 | 5 |
| Data only | 8 | 6 | 0 |
| Both | 6 | 6 | 6 |

Data statistics were available in fourteen completed attempts, but two used only full retrieval. Seventeen sample_stats targets produced fifteen statistics tables and two explicit, correct complete-table suppression notices. Availability must not be confused with actual use.

Flow evidence included twelve ancestor references across five biomedical attempts. For example, join measurements exposed 95/95 matched score rows and 95/153 matched metadata rows without requiring separate retrieval of every ancestor. The four deterministic probes also established that cast losses cross custom-function boundaries as version-bound ancestor measurements, while explicitly leaving row correspondence unknown.

Other verified behavior:

- Qwen biomedical data-only step 5 failed one column-list operator while an independent sheet-list operator still completed. The same retrieval batch returned the valid result alongside the failure; the next edits repaired the failed function.
- Cached results were reused; completed traces report 38 cached operator outcomes. The synthetic probe verified unchanged result-version IDs for all six cached nodes and zero engine requests from retrieval-only actions.
- Completed traces retain 93 engine requests, including four execution failures; all have the currently implemented phase telemetry. The two canceled attempts add twelve successful engine requests.
- Final snapshots retain 112 available profiles and 51 scan source identities. Sixteen optional source-detail truncations did not erase source identity.
- Largest individual retrieved text was 5,029 characters, and largest tool receipt was 10,231 characters. Character budgets apply separately to records, evidence, and each retrieved operator; they are not a whole-call cap.
- Sixty-two host samples showed at least 13.29 GiB available RAM and 407.66 GiB free artifact disk, zero swap, and maximum one-minute load 7.63 on sixteen logical CPUs. No observed memory or disk pressure explains the waits.

## Where the implementation still falls short

**Semantic filter statistics are missing from the registered protocol.** Filtering is custom Python, which exposes input/output counts and bounded diagnostics but not retained/rejected/null-predicate counts or rejected-value frequencies. Custom pandas merges and conversions likewise do not acquire native join/cast semantics automatically. Built-in joins, casts, and aggregates are measured. The paper’s filter example is therefore not fully implemented. See [registered operator selection](../../../../agent-service/src/agent/native/registered.ts:66) and [retrieval contract](../../../../docs/retrieval-views.md).

**Wide-schema and workbook discovery create avoidable work.** Schema display currently caps the automatic column list at sixteen. Models authored custom functions to list columns, guessed nonexistent names, and repeatedly retrieved workbook previews. A complete or paginated schema view and a compact sheet/header discovery result would address the observed behavior without expanding ordinary result samples.

**Gateway waiting is the largest observed reliability issue.** Four requests reached the 180-second client deadline. The two canceled runs spent 360 and 180 seconds on completed timeout waits, respectively, before their last requests were canceled. Their engine work succeeded. Successful preceding/retried responses identify Wafer, but absent responses do not establish the backend cause of the stalled requests. The synchronous proxy has no explicit deadline/cancellation propagation in this resource; client cancellation does not prove provider work stopped. See [request timeout](../../../../agent-service/src/agent/llm-drivers/request-timeout.ts:33) and [proxy](../../../../access-control-service/src/main/scala/org/apache/texera/service/resource/AccessControlResource.scala:291).

**Some evidence and engine work is repeated.** The synthetic flow-only case expanded the execution receipt from 319 to 2,429 characters and the raw retrieved views from 460 to 2,826 characters. Facts recur across execution and retrieval, or across multiple retrieved descendants. Same-call deduplication keyed by producing versions would save tokens while retaining scope labels. An all-cached explicit execute still took 1.19–1.24 seconds, versus 12.5–16.7 ms for retrieve-only; a future shortcut must verify cache materializations and input versions before skipping dispatch.

**Telemetry is not yet a full phase breakdown.** Retained phaseMetrics currently report compilation outcome/duration and runtime-start status. They do not separate UDF computation, profiling, transfer, and result persistence. Do not interpret their presence as complete engine cost attribution.

## Recommended order of work

1. Add complete/paginated schema inspection and compact workbook discovery. This directly addresses observed repeated calls and failed column guesses.
2. Propagate explicit request deadlines and cancellation through the gateway, and retain per-attempt provider timing/usage. Keep missing usage unknown.
3. Restore a measured semantic filtering contract that fits registered functions, including rejected-value frequencies; continue marking unrestricted custom Python opaque.
4. Tighten the general examples: register/edit + execute + retrieve together when arguments are known; answer alone; compute the final requested quantity in a result operator. Add offline checks for final formatting and graph-grounded numeric answers alongside the official score.
5. Deduplicate repeated flow facts, then consider verified all-cached dispatch avoidance and richer engine phase timings.

For these traces, Luna gives the strongest observed cost/call-count combination. Terra and Sol behave adequately with ordinary recoverable mistakes. Opus is accurate but more expensive without a demonstrated accuracy gain here. Qwen is inexpensive at the provider but inefficient in orchestration. DeepSeek demonstrates task-solving ability and low reported response costs, but its current route is not yet consistently low-latency. These are local observations on an incomplete, easy-to-saturate sample, not general model rankings.

## Reproducibility and artifacts

All four arms collected full-row profiles internally. Data-off offered sample/full; data-on offered sample_stats/full. Flow was independently disabled/enabled. Sample, statistics, and flow budgets were 2,000 characters each, sample rows five, full-view cap 5,000, maxSteps 25, with two workers. This isolates evidence exposure with collection held fixed; it does not measure turning profiling work off, nor does it test an unbounded full-table baseline. The current API selects a view per retrieval batch; sample size is a session setting.

No complete model/task 2×2 comparison survived the stop. The six available matched contrasts contain only one or two tasks each, all with identical scores. Luna used one fewer call in two data-on comparisons; other cost differences mix strategy, cache warmth, and extra evidence. The traces establish correct switching and useful diagnostics, not a causal accuracy or cost advantage.

- [Model summary and exact costs](model-summary.json)
- [Per-task metrics](per-task.csv) and [analysis with descriptive contrasts](analysis.json)
- [Contract audit](contract-audit.json), [deep audit](deep-audit.json), and [resource/source summary](summary-audit.json)
- [Interrupted-attempt audit](interrupted-audit.json)
- [Deterministic probe summary](probe-summary.json) and [both-enabled execution example](probe-data1-flow1-execute.md)
- [Stop record](STOPPED.md)

Raw traces remain in `benchmark/retrieval/runs/20261008-registered-python-evidence-matrix/system_scratch/`. Representative evidence: Qwen data1/flow0 biomedical step 5 (partial failure); Terra data0/flow1 biomedical steps 3–6 (column guessing); Opus data0/flow1 biomedical steps 2–5 (repeated previews); both Opus legal runs, final step (arithmetic outside graph); DeepSeek data1/flow1 biomedical wire request 000002 (timeout). Canceled attempts preserve user-stop-react_steps.json and their wire files.
