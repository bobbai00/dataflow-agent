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

# LongDS annotation diagnosis and next experiment

September 30, 2026. **Complete: 178 failed turns annotated across 16 Terra run/session bundles; 35 selected cases audited against the traces.** The original 542 correctness scores remain unchanged: DSGym 180/271, smolagents custom 184/271. This pass changes no engine or solving-agent behavior.

## Diagnosis

The strongest opportunity is to make working populations, current definitions, and actual dependencies explicit, then test correction propagation. The evidence supports a small intervention before expanding the state registry.

The paper-style annotations add upstream error IDs, concrete explanations, overlapping categories, and confidence to binary accuracy. They also introduce interpretation errors of their own. We preserve their original output and keep audit findings separately.

## What the original annotation procedure found

We used the paper's **Codex GPT-5.5, x-high** configuration and its Appendix E.3 prompt. Existing **DeepSeek-V4-Pro** correctness judgments selected the failed turns. There were 15 annotation jobs; DSGym Netflix had no failures and needed no model call. [Paper, Appendix C.5](https://arxiv.org/html/2605.30434v3#A3.SS5), [original prompt, PDF pages 27–33](https://arxiv.org/pdf/2605.30434v3#page=27).

**Raw primary labels, before manual adjudication:**

| Primary error | DSGym | smolagents custom | Total |
|---|---:|---:|---:|
| Cascade | 48 | 49 | 97 |
| Instruction following | 12 | 12 | 24 |
| Statistical / domain reasoning | 8 | 12 | 20 |
| State management | 11 | 9 | 20 |
| Coding / implementation | 9 | 5 | 14 |
| Context memory | 3 | 0 | 3 |
| Planning | 0 | 0 | 0 |
| **Total** | **91** | **87** | **178** |

- Cascade is primary on **97/178 turns (54.5%)**, and appears as any label on **117/178 (65.7%)**. Secondary categories overlap; they are not additional failed turns.
- State, context, and cascade together account for **120/178 primary labels (67.4%)**. This is a description of this purposive eight-session pilot, not an estimate for all LongDS tasks.
- **56 of the 97 primary cascades** come from just two runs: DSGym NFL (34) and smolagents WiDS (22). These counts reflect many affected answers from a few early faults.
- Context memory is primary on three turns and appears on eight. Planning appears once as a secondary label. Neither zero nor small primary counts prove a mechanism is absent.

## Mechanisms that matter for Dataflow

| Case | Trace evidence | Concrete intervention to test |
|---|---|---|
| **WiDS, smolagents, turns 1–20 and 37–40** | Annual gas use is built from `qq_dict` instead of `consumption`; later calculations reuse that column. A separate footprint calculation affects another branch. | Preserve producer/input links and test whether correcting a producer refreshes its actual consumers. Metric interpretation still needs validation. |
| **Survey, DSGym, turns 14 → 18 → 23** | Turn 14 asks for a temporary AutoML comparison. Turn 18 explicitly treats the most recent hybrid as active; turn 23 uses its top-three scores. | Keep the default result distinct from comparison results. Verify the actual role-table reference consumed later. |
| **Kiva, smolagents, turns 12 → 13** | Turn 12 answers correctly but does not retain the surviving population. Turn 13 joins poverty data to the broad 411-row table. | Return the full updated cohort as a reusable result; derive the answer report from it. |
| **NFL, smolagents, turn 24** | The correct 33-player candidate pool exists. The agent fits, applies, and ranks on that pool, although scoring should cover all 86 players before selecting candidates. | Separate fit, apply, and report populations. Check actual key coverage at the boundaries. |
| **Restaurants, both agents, turn 29** | The baseline gate loses its quality condition. Smolagents has the correct saved flag in its table and ignores it. | Pass an eligible cohort or explicitly apply its gate; catalog visibility alone does not ensure a predicate is used. |
| **Kiva, DSGym, turns 25–26** | The initial 55% demand / 45% partner-efficiency rule is dropped when earlier scoring views are revisited; partner matches are ranked by country-sector demand alone. | Preserve the score's entity grain and composition rule with the reusable computation. |

The Survey branch mistake is an additional finding from this annotation pass. The traces distinguish it from smolagents Survey, which uses the intended strict branch but inherits wrong score components. Similar accuracy losses can therefore need different repairs.

The earlier Luna audit provides related examples: a correct BI report failed to retain changed rows, while a University correction propagated through Dataflow consumers but left a Python distance field stale. Those observations support these targeted tests. This pass adds labels to Terra only; historical release and protocol differences still prevent treating the Luna/Terra comparison as a controlled model experiment. [Earlier comparison](longds-error-classification-and-luna-2026-09-30.md).

## What the trace audit changed

I checked 33 deliberately selected failed turns plus two follow-ups suggested by the annotations. **29 of 35 concrete mechanisms were supported; six required qualification or were unsupported.** Six primary labels were disputed or not established. This is a focused review by the coordinating assistant, not blind human validation or a representative classifier-accuracy estimate. All original annotations remain unchanged in the saved results.

1. **A judge error became a classification error.** In smolagents Survey turn 27, the answer correctly reports `1878 − 1118 = 760` for AutoML-only and `1878 − 896 = 982` for the strict view. The judge reverses the two meanings, and the annotator repeats the wrong-answer premise as a high-confidence state error. Keep the official score, but flag the disagreement before using this case to justify an algorithm change.
2. **Some labels assert more than the trace shows.** DSGym Restaurants turn 10 has no new executed calculation supporting its answer; the classifier asserts wrong state selection without identifying an executed artifact. DSGym University turn 20 similarly receives a coding label without code showing that implementation. Netflix's secondary context-memory label is also weak: the agent deliberately reinterprets the requested components while retaining their weights.
3. **Reference precision matters.** For WiDS building B021945, exact decimal exterior-ring area is **18577.38**. The saved agent function gives **18577.375** and the saved reference gives **18577.390625**. Both suffer floating-point cancellation. The resulting numeric cascade should not be counted as evidence that a catalog fixes invalid state. [Reproduction results](../logs/longds-annotation-20260930/footprint-precision-check.json).
4. **Category boundaries vary across runs.** Both Survey agents replace global anchors with role-specific anchors. One annotation calls this primarily state management; the other calls it statistical/domain reasoning. The underlying population mistake is clearer than the primary-category distinction.
5. **Operational causes need separate evidence.** smolagents LearnPlatform turn 1 has an empty answer after a provider output-limit error. The original seven-category procedure labels it instruction following. Its serialized trace omits the harness exception; the manual audit reads `t01/answer.json` and records that cause separately.

A passing answer also does not certify its produced state. Kiva's missing population update begins on passing turn 12, and the NFL pressure-definition problem is already visible on passing turn 1 before its failed reintroduction on turn 2. The classifier's upstream IDs are useful starting points, not guaranteed earliest origins.

## Concrete next iteration

The current implementation and evaluation plan is [LongDS task Dataflows](longds-task-dataflows-experiment-plan.md), including Codex error classification and proactive loop and prefix-cache checks. The proposals below record the earlier direction from this diagnosis.

### 1. Test a small policy change in persistent Python

Use **DSGym Survey**, **smolagents Kiva**, and **smolagents NFL** as diagnostic sessions, with **smolagents Netflix** as a successful historical-composition control. Run complete sessions. Keep Terra medium, dataset/input hashes, executor, output and step budgets, and the DeepSeek-V4-Pro judge fixed.

Add these behaviors to the existing prompt:

> Keep the full working population separately from its answer report. Apply a change to the default analysis only when the request makes it persistent; retain one-off comparisons under separate names. Before fitting thresholds or scoring, identify the fit population, the apply population, and the reported population. Use the complete eligibility rule when selecting a cohort.

The existing prompt already asks for code-based calculations and evidence. Repeating that generic instruction does not address the observed cohort and branch mistakes. Measure those mistakes directly, alongside accuracy, calls, and token usage. Treat a first comparison with the saved runs as exploratory; repeat matched arms before making causal accuracy claims.

### 2. Add only the computation boundaries supported by these cases

Use existing coarse Dataflow computations for working cohorts, fitted quantities, scores, and reports. Record actual input and output result references at execution. Render a small catalog from those records, showing the selected current results and their producers.

For NFL, the useful boundary is:

```python
caps = fit_caps(candidate_players)
all_scores = score_players(all_players, caps, pressure, play)
answer_rows = select_players(all_scores, candidate_keys)
```

Check keys and populations, not just labels saying “full table.” A graph records which table was supplied; it does not prove that arbitrary Python applied every column or predicate. Compare the same computation boundaries with and without catalog visibility to isolate the catalog's contribution.

The earlier state-registry experiment did not improve aggregate accuracy and increased recorded cost. These annotations do not justify replacing it with another large registry. They justify testing explicit result reuse and updates at these specific boundaries. [Earlier implementation results](analysis-state-implementation.md).

### 3. Test repair separately

Give Python and Dataflow the **same correction** to a known bad producer, starting with the WiDS gas field and summaries before the geometry tasks. Check whether affected consumers update, intentionally historical results remain fixed, and unrelated computation is avoided. Report this as a controlled repair diagnostic, separately from original benchmark accuracy.

For subsequent annotation passes, retain the published labels and add a small diagnostic supplement: judge disagreement, runtime cause, intended versus consumed artifact/population, and the producer turn. Revisit disputed or newly changed traces first. No further engine changes or solver runs were made in this pass.

## Reproducibility and artifacts

- [All 178 annotations, 35 audits, counts, source hashes, and experiment specification](longds-annotation-diagnosis-2026-09-30.json).
- [Annotation runner](../benchmark/longds/annotate_errors.py) and [validation tests](../benchmark/longds/test_annotate_errors.py).
- [Campaign and archived evidence locations](../logs/longds-annotation-20260930/campaign.json), [manual audit](../logs/longds-annotation-20260930/manual-audit.json), and [final integrity checks](../logs/longds-annotation-20260930/final-verification.json).

Each isolated bundle contains `code.py`, unmodified reference `ground_code.py` and `task.ipynb`, scored rows with complete recorded per-turn trajectories, and separate trace files. Original score fields remain identical. The PDF prompt wording is preserved; only its duplicate heading and form feeds were removed. A neutral file-layout wrapper and JSON schema adapt it to our traces. Local Codex instructions/installed skills still apply, as documented in the JSON protocol; this matches the published model, effort and annotation prompt, not the authors' unpublished environment.

Validation passed for every bundle: exact failed-turn coverage, category/schema checks, valid earlier upstream IDs, count consistency, unchanged original fields, and unchanged source hashes. **622 source files and 742 archived bundle files were verified; 9 tests passed.** Saved annotation files equal the final structured responses; no annotation retry or label rewrite was needed.

The 15 jobs reported **21,023,948 input tokens**, including **19,304,832 cached**, and **320,788 output tokens**, including **162,509 reasoning tokens**. These are totals across internal Codex steps, excluding the setup probe. The CLI did not return a billed dollar amount.

```bash
python benchmark/longds/annotate_errors.py collect
python benchmark/longds/annotate_errors.py verify
```

These commands summarize and verify the frozen campaign without making model calls. New campaigns can use `prepare --control <new-directory>` followed by `run --control <new-directory>`; the runner expects the frozen pilot source artifacts and the local PDF extraction.
