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

# LongDS task Dataflows implementation and evaluation plan

The research direction is approved; the task layer and new experiments are pending. This plan incorporates the requested Codex error classification and proactive checks for stalled loops and prefix caching anomalies.

## Core design

Each user request starts a fresh working Dataflow. The agent initially receives the current request, previous task requests and answers with stable task IDs, and the system prompt and tool definitions. Previous graphs, code, tables, and internal ReAct steps are retrieved when needed. The current task's actions and observations remain available while it runs.

The agent identifies relevant historical tasks, inspects their saved Dataflows and outputs, and explicitly reuses the required results or computations. When it answers, the runtime captures the Dataflow that produced its declared outputs. Those outputs become available to subsequent tasks.

For the first experiment, preserve previous request and answer text, including the benchmark's context field. This tests the user's proposed memory structure without introducing a lossy summarizer. A smaller task directory or fully on-demand discovery can be tested later.

Dataflows provide explicit computational dependencies. Ordinary Python scripts would need additional instrumentation or enforced function boundaries to expose equivalent reusable subgraphs. Neither representation proves that a computation correctly answers the user. The runtime can identify the ancestors of declared outputs; the agent still has to produce and identify useful working outputs.

## Challenges and expected mechanisms

| Challenge | Trace evidence | Intervention to test |
| --- | --- | --- |
| Working state missing behind a correct answer | Kiva turn 12 produces the lost-pairs report but does not retain the narrowed population for turn 13 | Export the eligible population and derive the report separately |
| Temporary result becomes the ongoing default | Survey turn 14's comparison is treated as active at turn 18 | Separate task graphs and explicit default updates |
| Wrong population selected | NFL turn 24 applies scoring to the fitting pool | Name and inspect fitting, scoring, and reporting inputs; check actual key coverage |
| Earlier conventions or precision lost | Earlier score weights disappear or historical values are reconstructed from rounded answers | Retrieve original instructions, definitions, and exact results |
| Incomplete correction | The earlier University comparison leaves a Python distance field stale after another value is corrected | Follow actual consumers and replay the selected computations |
| Early error inherited repeatedly | WiDS aggregates the incorrect gas field from an earlier turn | Preserve producer links and measure repair after the same correction is supplied to both systems |

These are hypotheses grounded in the [annotation diagnosis](longds-annotation-diagnosis-2026-09-30.md) and [earlier trace review](longds-trace-review-2026-09-30.md). Wrong formulas and ignored eligibility rules remain reasoning problems. A catalog or graph can preserve a wrong calculation.

## Implementation

Build in an isolated branch from the inspected dataflow-actions revision, a1ccb4829880b7b1dd926983a1c4ce7f8faf02ae. Keep the explicit operator and named-port edge syntax and ordered action runtime.

### Task records and execution scope

Start with one task per user request. Each record stores the original request, final answer, named exports, exact producing definitions and functions, consumed result references, schema and row counts, artifact hashes, and explicit default changes. Full exploration traces and graph snapshots remain available for audit.

At Answer, follow the ancestors of declared exports and answer sources to capture the reusable computation. Extraction is a runtime operation, so the model does not have to reconstruct the graph. Dependencies come from the executed ancestors and their actual input versions, rather than every historical task inspected.

Retain complete output tables independently of evictable caches. Reuse the existing retention and historical-source machinery in state-registry, adapting its backend endpoint and port metadata into the action branch. That branch does not currently contain this task retention implementation. A sampled observation is not a retained table.

A fresh task activates its own working graph. Archived task graphs remain outside it because Execute runs every component of the active graph. Imported historical results are fixed inputs. Updating the ongoing default changes an explicit binding after successful output retention; it does not rewrite historical task results.

### Model capabilities

Extend the existing dataflow tool rather than introducing a second controller:

- **Inspect tasks:** list or search earlier task requests and answers; useful when an ID is unclear.
- **Inspect a task:** return its original instructions, exports, graph, exact implementation, or dependencies at the requested detail.
- **Reuse a result:** import an exact saved task output into the current graph under a local name, without reexecuting its producer.
- **Reuse a computation:** instantiate a saved subgraph with explicit replacement inputs and new local IDs. Unchanged boundary inputs remain pinned. Execute remains explicit.
- **Answer with exports:** identify the answer sources and reusable working outputs, plus any ongoing default updates. Validate and retain those outputs before finalizing the task.

Implement result reuse first, then computation reuse and correction replay. Task graphs must retain the precise imported output references beneath their task-level dependency view. The runtime cannot extract a DataFrame discarded inside a custom function; the function must return the working table, with reports downstream.

Cross-task repair requires session-level traversal and replay. Give the controller affected-consumer information, rebuild the selected current analyses under corrected inputs, and retain the original historical results. Amber's current-graph invalidation alone does not supply this behavior across archived task graphs.

### Prompt and context

Keep the generated operator API reference and the new action contract. Replace context instructions that assume all earlier tables remain in the active graph. Explain how to retrieve past task state, preserve reusable populations, select current versus historical inputs, and distinguish temporary comparisons from persistent updates.

Add one persistent-update example and one temporary historical comparison. Permit coarse process operators for meaningful calculations. Do not require a node for every pandas statement. Keep the general state-management instructions shared with the prompt-only control.

Previous task records are immutable in the rendered context. Append completed request-answer records in a fixed order, and preserve current-task observations as originally received. Record deliberate changes at task boundaries or compaction separately from unexpected changes within a task.

## Experiment sequence

### Deterministic checks

Before model trials, test complete-table retention, missing exports, fixed imports, export validation, default updates, temporary comparisons, stale-result rejection, preserved observations, and task dependency extraction. Later tests cover computation reuse and correction propagation. Include a boundary where a working population has more rows than its report.

### Initial model comparison

Run four complete sessions: Survey task 2, Kiva task 1, NFL task 1, and Netflix task 3. They contain 30, 37, 42, and 36 turns respectively: 145 user turns per arm.

| Arm | Configuration | Purpose |
| --- | --- | --- |
| A | Frozen action framework and current prompt | Establish the new framework's baseline |
| B | A plus the small state-management policy | Measure the prompt contribution |
| C | B plus task graphs, exports, inspection, and reuse | Measure the added task structure |

Use GPT-5.6 Terra with medium reasoning, the existing pinned LongDS v1.1 revision bf41bb28474fa9540d98922a6f5e6310ed014e51, identical official input snapshots, and matched model-call and output limits. Record actual requests and resolved settings; freeze timeout and retry policies before running. The earlier pilot used 40 model calls per turn and an 8192-token model output ceiling; verify the new runner applies these consistently.

Start with one complete trial per arm for diagnosis. Interleave arm order where practical and record scheduling and concurrency. Repeat matched arms before making causal accuracy claims; then evaluate sessions not used to design the intervention. The existing Python runs remain frozen diagnostic references. Outcome-dependent retries are not part of this LongDS protocol. Record infrastructure recoveries separately and preserve their original attempts.

### Repair and context comparisons

Test WiDS gas repair separately from official accuracy, before the geometry cases with reference-precision concerns. Supply the same correction to Python and Dataflow, using comparable initial faulty state. Measure corrected descendants, historical preservation, unnecessary recomputation, model calls, and elapsed time. A Python control with equivalent saved outputs and task retrieval helps isolate dependency-driven replay.

After the task mechanism works, compare the agreed request-answer context against a compact task directory and fully on-demand discovery. Count retrieval overhead and provider-reported usage across the whole session.

## Correctness and Codex error evaluation

Use two separate evaluations on every experimental arm:

1. **Correctness:** DeepSeek V4 Pro with the benchmark's Appendix E.2 prompt. Keep binary scores, reasoning, missing-field explanations, raw responses, and judge usage.
2. **Error classification:** Codex GPT-5.5 at xhigh with the original Appendix E.3 prompt, as in the completed annotation pass. Cover every judge-failed turn in a completed session and include the full earlier trajectory so passing upstream turns can still be identified as origins.

Preserve the seven categories: instruction following, statistical/domain reasoning, coding/implementation, planning, context memory, state management, and cascade. Save primary and overlapping categories, upstream error task IDs, confidence, and evidence. Report both root mistakes and affected downstream turns; category counts alone do not measure how many mistakes Dataflows could fix.

Adapt the existing [annotation runner](../benchmark/longds/annotate_errors.py) to accept a campaign manifest and native action traces. Include exact graph definitions, input/output references, action receipts, runtime exceptions from answer artifacts, timeout and cancellation records, and the unmodified reference files. Distinguish submitted code from successfully executed code. Preserve the E.3 wording and keep the file-layout adapter and any supplemental diagnostic prompt separately versioned.

Annotation is offline. Reference solutions, ground truth, and benchmark dependency labels never enter the solving agent's context. Preserve original scores and raw annotations; record judge disagreements and annotation corrections separately. Validate failed-turn coverage, upstream IDs, schemas, source hashes, and aggregate counts. Keep the existing frozen campaign intact.

Start classification after each complete session is scored, so diagnosis proceeds during the campaign. If a session terminates early, retain its partial trace and operational cause, report annotation coverage explicitly, and do not present it as a complete-session comparison.

## Proactive trace monitoring

Monitor each completed model call and action receipt, with a periodic heartbeat while work is in flight. Manually inspect the first completed task of each arm, the first cross-task reuse, the selected state-change boundaries, every anomaly alert, and every completed session. Include passing answers at these boundaries: correct answer text does not certify correct retained state.

For each alert, save session, arm, task, model-call and action indices, artifact paths, graph/result versions, relevant request and observation hashes, error details, timing, and a proposed mechanism with confidence. An alert is a screening signal until the trace establishes its cause.

### Loops and stalled progress

Initial thresholds are monitoring rules to freeze before the pilot:

- Flag three consecutive identical action-and-observation pairs, or a two-action cycle repeated three times, when no new result version or relevant information appears.
- Flag five consecutive inspections or retrievals that revisit the same objects and versions without new evidence.
- Record repeated rejected edits, repeated unchanged executions, recreation of failing branches under new names, and repeated stale retrievals without a successful execution.
- Record step-limit termination without Answer, repeated empty model output, provider output-limit failures, execution timeouts, failed cancellations, and missing progress events.
- During a stall, identify whether the system is waiting for the provider, engine, result transfer, or controller. A long legitimate computation is different from a repeated action cycle.

Normalize only diagnostic identifiers and the explanatory reasoning field for repetition detection; retain substantive code, action arguments, and result identities. Keep the raw events for review. Monitoring alerts do not inject hints, silently repair a run, or selectively grant more budget. Use the predeclared limits consistently; any intervention becomes a separately recorded diagnostic run.

### Prefix caching

Capture the actual outbound model request body at the client transport, alongside the assembled input messages. Preserve ordered messages and tool schemas, model and generation settings, call IDs, task boundaries, timing, returned usage, and finish reasons. Never log authorization headers or provider keys. If an intermediary rewrites requests and its outgoing body is unavailable, state that visibility limit.

For adjacent calls, record the first changed prompt-bearing field or message and the longest identical message/content prefix. Compare those facts with provider-reported input, cached-input, cache-write, and output tokens. Character or byte overlap is not a measurement of cached tokens.

Check for changing system prompts or tool schemas, re-rendered historical results, changing IDs or timestamps inside stable context, reordered history, redundant retrieval payloads, unexpected context growth, and drops in cache reuse. Separate cold starts, deliberate task-boundary changes, compaction, request timing, and provider routing from application-side prefix changes. Missing usage is unknown, not zero.

Record prompt-cache reuse separately from engine result-cache reuse. A new backend execution request does not prove that every operator recomputed. Use producing execution IDs and materialization records to identify actual recomputation.

The inspected action e2e harness checks assembled-message prefixes. Reuse that check, and extend request capture to the serialized transport body before diagnosing SDK or proxy effects. A stable prefix with low reported cache reuse is a provider/cache diagnostic candidate, not proof of a context-construction bug.

## Reporting and decisions

Report accuracy, task-macro accuracy, classification coverage and category counts, originating mistakes and cascades, observed state-selection errors, retention completeness, correction completeness, model calls, cached and uncached input, output tokens, execution reuse, and elapsed time. Use verified provider charges when available; label repository accounting estimates explicitly.

Audit every A/B/C accuracy disagreement at the relevant state boundary, major token/latency outliers, detected loops, suspected cache regressions, and a sample of successful controls. Preserve confidence and alternative explanations. A second automated annotation is not independent human validation.

Continue beyond the diagnostic pilot when the intended saved outputs are actually retained and consumed, historical comparisons preserve defaults, and observed gains survive matched repeats without disproportionate retrieval overhead. Revisit the design if improvements come only from the prompt, if the model repeatedly selects the wrong task output, or if task discovery dominates calls and tokens.

The final artifacts should include the frozen campaign manifest, exact prompts and schemas, full request/action traces, original correctness judgments, Codex annotations, operational anomaly records, manual audits, and a compact report linking findings to trace locations.
