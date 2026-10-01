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

# LongDS task Dataflows pilot: checkpoint at shutdown

The first matched session does **not** support an accuracy benefit from the initial task layer. It reduces input tokens, but the agent often reconstructs earlier definitions incorrectly instead of importing available state. Kiva also exposes a runtime defect that can prevent a correctly requested working-table export.

This is an interim diagnosis. The pilot stopped at the user's request on October 1, 2026, at 07:31 UTC. Survey is complete across all three arms; Kiva B and C are partial, and the remaining runs are unfinished. The approved pilot contains four full sessions per arm, 12 runs and 435 planned turns. Saved traces, result archives, and data remain available. [Saved aggregate](../logs/longds-task-dataflows-20260930/aggregate.json), [frozen protocol](../logs/longds-task-dataflows-20260930/campaign.json), [shutdown record](../logs/longds-task-dataflows-20260930/shutdown/shutdown.json), and [implementation](task-dataflows.md).

## Matched Survey result

All arms use GPT-5.6 Terra at medium reasoning effort, the same action framework, inputs, task text, limits, and answer contract. A is the baseline; B adds the shared state policy; C adds fresh task graphs, request/answer history, task inspection, and exact result imports. These are single development runs, not replicated estimates.

| Survey task 2 | A: baseline | B: policy | C: task Dataflows |
| --- | ---: | ---: | ---: |
| Original judge score | 21/30 | 20/30 | 14/30 |
| Model calls | 87 | 89 | 153 |
| Input tokens | 3,713,647 | 4,449,516 | 1,886,177 |
| Cached input tokens | 2,352,242 | 2,747,703 | 1,571,404 |
| Uncached input tokens | 1,361,405 | 1,701,813 | 314,773 |
| Output tokens | 38,034 | 40,875 | 64,081 |
| Largest input | 93,577 | 106,984 | 22,682 |
| Elapsed seconds | 819.5 | 862.3 | 1,184.8 |
| Model request seconds | 518.6 | 575.1 | 866.3 |
| Other elapsed seconds | 300.9 | 287.2 | 318.5 |

Usage comes from actual provider responses. C uses 49% less input and 77% less uncached input than A, but 76% more calls and 45% more elapsed time. This is not a measured dollar-cost comparison. No solver retries were selected based on outcomes.

Extra model request time accounts for about 348 of C's additional 365 seconds. Request timing includes transport through complete response capture; the remainder includes tools, engine work, context assembly, retention, and harness work. These are wall times, not CPU measurements. The materialization audit also records 36 CSV reads inside C's successfully observed Process outputs; A and B use graph inputs for these calculations. Failed computations may contain additional unrecorded reads. [Materialization evidence](../logs/longds-task-dataflows-20260930/materialization-audit.json).

### What worked

C retained the complete 4,672-row strict cross-tool population at task 8. Tasks 10 and 11 imported and consumed its exact saved version. Across the session it made 16 successful imports; eight task records have consumed imports. An unused import at task 18 was correctly excluded from its computational dependencies.

The runtime therefore captures actual result use. Inspection, copied code, and constants copied from previous answers remain outside computational lineage.

### Why accuracy fell

- **Reconstruction introduced errors.** At tasks 6 and 19, C compared full survey question labels with the short string `No / None`. Empty opt-out lists silently broadened the adopter population. The earlier AutoML mask had not been saved as a reusable population before task 6; at task 19, the correct strict population already existed in task 8. These are different failures of producing and selecting useful state. Tasks 21 and 22 then imported and propagated the wrong size-lift table.
- **A graph preserved the wrong interpretation.** All three arms used role-specific experience anchors at task 13, where the reference requires the earlier global anchors. Later concentration and resilience answers inherited the mistake. C inspected the faulty implementation and copied it; task isolation did not repair its meaning.
- **Working outputs were still incomplete.** A and C retained only five role-score rows and later rebuilt the full population. B preserved the complete role table and connected later calculations to it. That useful behavior does not require the task layer.
- **Discovery and observations added work.** C made 45 inspection actions and split seven edits from an immediately following Execute call. Task 7 spent 12 calls rediscovering survey blocks and still returned an incorrect category map. The shared action interface permits Edit–Execute–Retrieve batching.

The immediate opportunity is a stronger rule for selecting previously computed inputs and preserving complete working outputs. More catalog structure alone would not address these traces.

## Judge and annotation limits

Correctness uses the original Appendix E.2 prompt with DeepSeek V4 Pro. Error annotation uses the original E.3 instructions with Codex GPT-5.5 at xhigh, through a separately recorded native-trace adapter. Original judgments and annotations remain unchanged.

The classifier adds useful upstream-error links and explanations, but its labels need trace checks. For example, it calls B's task-11 ordering a context-memory failure. B actually preserves its task-6 order exactly; the correctness judge compares it with the reference's different order. A changes its earlier order and receives credit. This one-point A/B difference is not evidence that the policy damaged memory.

Other numerical-presentation concerns include task 12's `7.03125` rounding tie and C task 16's `13.40996` versus reference `13.41`. Preserve the published-protocol scores and distinguish these cases from wrong populations or formulas.

See [manual annotation reviews](../logs/longds-task-dataflows-20260930/manual-annotation-review.json), [judge concerns](../logs/longds-task-dataflows-20260930/judge-disagreements.json), and [trace audit](../logs/longds-task-dataflows-20260930/manual-audit.json). Category totals are classifier outputs, not a count of errors that a state mechanism would necessarily fix.

## Kiva runtime findings

The deployed engine differs from the current action-branch source. Bytecode inspection of the frozen JAR confirms that its preview collector still iterates and renders the remaining rows to retain a small tail sample. The action branch already has a `tailRows`/`getRange` optimization, but that code is absent from this deployment. All three arms use the same frozen engine; the manifest records its actual JAR hashes. A/B retain large active loan tables, so this runtime behavior affects their latency much more than C's small fresh graphs. Treat Kiva timing as a runtime-confounded comparison, and build from the intended source before a repeat. [Deployed collector evidence](../logs/longds-task-dataflows-20260930/deployed-result-collection.json).

The engine materialized a 727-row pressure table and its five-row report, but the agent received no completed downstream results. Logs show workflow cleanup occurring during the long synchronous result-collection response. The agent repeatedly rewrote definitions and eventually moved the calculation into a standalone file-reading function. This is a recovery loop with changing code, so exact repeated-action detection alone misses it.

C later tried to retain the full cleaned loan table. Retention returned HTTP 404, and the next answer dropped the working export. A read-only check established that the cached result and its physical data still existed, while cleanup had removed the producing execution's result-registry rows. The retention endpoint resolves through those rows only.

These are separate observations: cleanup during collection is the leading explanation for the missing observations; the cache-versus-execution-registry mismatch directly explains the retention lookup failure. An isolated database regression reproduced the latter. A small lookup fallback, restricted to the exact producing execution and output port, now passes all 44 tests in `WorkflowExecutionsResourceSpec`. It rejects a mismatched producer and does not substitute the latest result for a missing historical consumer. The fix is prepared in the separate `fix/task-result-lifetime` worktree and has not been deployed into this campaign. [Operational evidence](../logs/longds-task-dataflows-20260930/operational-audit.json).

### State boundaries still fail after successful execution

B repeats the earlier Python failure at tasks 12–13 despite the shared preservation policy. Task 12 returns the excluded country-sector pairs without producing the complementary supported population. Task 13 connects the older broad social-priority table directly to the poverty computation. Its reported ranks extend into the hundreds; the reference working population contains 21 pairs. C reconstructs the required support filter at this boundary, but also retains only the report.

At tasks 18–20, C inspects earlier outputs and implementations, then rebuilds the entire concentration calculation because the saved output has only five report rows. During the stress test, it changes the HHI coefficient from 55 to 5500 while HHI remains on a 0–1 scale. The next task successfully imports the resulting table and propagates the empty dropped/restored-set conclusion. This is evidence for separating a complete scored table from its report, and evidence against treating successful import as correct state management. These cases remain subject to the original judge and annotation after Kiva finishes.

## Prefix caching and resources

A and B rewrite the start of their large historical message at each task boundary. Their first calls at those boundaries reuse only a small prefix. C preserves many earlier request/answer messages, but also shows limited cache reuse on the first call of each new task. The captured client requests establish what changed in the application; they do not reveal the proxy's outgoing body or prove a provider cache defect.

Before shutdown, the resumed stack used bounded JVM heaps and two concurrent solving sessions. Runtime artifacts are on `/var/tmp` on the root filesystem because `/home` is nearly full. The [recorded resource breakdown](../logs/longds-task-dataflows-20260930/resource-breakdown-current.json) distinguishes proportional memory from summed process RSS. All experiment jobs, evaluators, Texera services, and 17 Docker containers were stopped at the user's request. Shutdown verification found no remaining project services; available memory was 28 GiB.

## Direction to test after this pilot

1. Fix and test materialization lifetime and result lookup before interpreting Kiva as a clean state-management comparison. Execute should avoid scanning large unrequested tables just to prepare observations; Retrieve should control which results are displayed.
2. Make historical input selection concrete. For continuation tasks, inspect the known task's outputs and use its existing population or metric table before rebuilding from raw files. Keep explicit inputs even when the computation itself is a coarse Python function.
3. Preserve the complete working table before deriving a top-k report. Avoid a new catalog ontology; start with clear working-output and answer-output boundaries and verify actual downstream consumption.
4. Reduce redundant inspection payloads and unnecessary model turns. Test these changes separately from stronger state-selection instructions so token savings do not conceal accuracy losses.
5. Test correction replay separately after result reuse is dependable. Supply the same correction to Dataflow and a persistent Python control with comparable saved outputs. Measure corrected descendants and unnecessary recomputation; do not assume graph lineage prevents an initial semantic error.

The incomplete pilot leaves the next matched experiment undecided. The completed Survey scores and annotations, partial Kiva traces, and selected passing controls provide the evidence for this checkpoint. The old Luna traces and earlier Terra Python runs remain diagnostic references; release, prompt, and runtime differences prevent treating them as matched causal controls.
