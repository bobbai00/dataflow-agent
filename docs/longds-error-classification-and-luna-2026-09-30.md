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

# LongDS error classification, Luna traces, and Dataflow opportunities

September 30, 2026. This review checks the paper, the current upstream repository, and saved traces. It launches no agent or judge runs and changes no runtime code. “DS-1000/DSGene” is interpreted here as the existing Luna DSGym runs on LongDS; a separate DS-1000 experiment is not included.

## Conclusions

The paper does use a coding agent to classify failures. Its annotation instructions are published in the PDF. I did not find a released implementation of that annotation workflow in the current LongDS repository.

The strongest opportunity for Dataflow is maintaining an executable analysis through changes: preserving the full working result, selecting the intended historical inputs, and recomputing affected consumers after a correction. The traces also contain failures that a catalog alone would leave untouched, including incorrect formulas and ignoring an available eligibility rule. Terra's successful historical compositions make persistent Python a stronger control than the old Luna scores suggest.

## What the paper and repository actually provide

### The paper's annotation procedure

Appendix C.5 specifies **Codex, GPT-5.5, x-high reasoning** for annotating 3,207 incorrect turns. This is separate from DeepSeek-V4-Pro answer scoring. Inputs are `code.py`, `ground_code.py`, `results_eval.json`, and `task.ipynb`.

Appendix E.3 defines **seven categories**, combining statistical and domain reasoning. It requests a primary category, additional categories, upstream task IDs, evidence, and confidence in `error_ana.json`. Cascade requires actual use of an incorrect upstream artifact; an earlier wrong answer alone is insufficient. New local errors take priority. The blind human check reports 81.5% agreement, κ = 0.7535, and macro-F1 = 0.6177. [Paper C.5](https://arxiv.org/html/2605.30434v3#A3.SS5), [annotation prompt, PDF pages 27–33](https://arxiv.org/pdf/2605.30434v3#page=27).

The HTML rendering omits the prompt text beneath the E.3 heading; the PDF contains it. The task-construction skill described in §3.2 serves a different purpose from error annotation.

### Repository inspection

I checked upstream `zjunlp/DataMind` at **`a814927159470ad1624602d233f57b7c0be5882e`**, including the complete file tree and 170 LongDS source/document/configuration files. Our pilot used the older checkout `4b49ef052500c73b07b5a4955e1115da6cd9da16`; I downloaded changed upstream files into an audit directory without updating that checkout.

| Released component | What it does |
|---|---|
| [`runners/src/judge.py`](https://github.com/zjunlp/DataMind/blob/a814927159470ad1624602d233f57b7c0be5882e/longds/runners/src/judge.py) and [`judge_prompt.py`](https://github.com/zjunlp/DataMind/blob/a814927159470ad1624602d233f57b7c0be5882e/longds/runners/src/judge_prompt.py) | Compare answers with references and parse binary scores plus free-text explanations. They do not assign the seven research categories. |
| [`agent_agnostic/longds_bench/SKILL.md`](https://github.com/zjunlp/DataMind/blob/a814927159470ad1624602d233f57b7c0be5882e/longds/runners/agent_agnostic/longds_bench/SKILL.md) | Have the current agent solve sequential benchmark turns and score its answers. This is the only `SKILL.md` in the checked LongDS tree. It is not an error classifier. |
| [`runners/codex`](https://github.com/zjunlp/DataMind/tree/a814927159470ad1624602d233f57b7c0be5882e/longds/runners/codex) | Run Codex as the system being evaluated. |
| [`runners/custom`](https://github.com/zjunlp/DataMind/blob/a814927159470ad1624602d233f57b7c0be5882e/longds/runners/custom/README.md) | Adapt an agent with `respond(message)`, keeping one instance per complete session. This could reduce future harness work. |

Searches for annotation/category terminology found generic exception categories in vendored DSGym, such as evaluation failures. Those are unrelated to the paper's taxonomy. No annotation runner, classifier skill, or `error_ana` path was found in the checked tree. This finding is limited to that repository revision; it does not establish that the authors lack private analysis code. Other DataMind subprojects contain skills, but their presence is not evidence of a LongDS error-classification pipeline.

## Comparing the saved Luna and current Terra runs

The table aligns the **same eight session IDs**, each containing all its turns. Scores are retained exactly as saved.

| Session | Luna DSGym | Luna DSGym shared text | Luna Dataflow | Terra DSGym | Terra smolagents custom |
|---|---:|---:|---:|---:|---:|
| Netflix 3 | 0/36 | 5/36 | 1/36 | 36/36 | 35/36 |
| Restaurants 2 | 11/33 | 7/33 | 5/33 | 23/33 | 24/33 |
| Survey 2022 2 | 18/30 | 20/30 | 17/30 | 21/30 | 19/30 |
| LearnPlatform 2 | 6/30 | 17/30 | 16/30 | 21/30 | 26/30 |
| University 3 | 20/23 | 14/23 | 17/23 | 17/23 | 19/23 |
| WiDS 1 | 22/40 | 20/40 | 19/40 | 34/40 | 16/40 |
| Kiva 1 | 0/37 | 0/37 | 9/37 | 24/37 | 19/37 |
| NFL 1 | 12/42 | 2/42 | 2/42 | 4/42 | 26/42 |
| **Task-macro accuracy** | **35.48%** | **34.26%** | **34.80%** | **67.87%** | **69.48%** |
| Correct turns | 89/271 | 85/271 | 86/271 | 180/271 | 184/271 |

### Limits on this comparison

- **Release differences:** relative to the current v1.1 records, the historical cohort has 8 changed questions, 16 changed contexts, and 35 changed reference answers. Their union covers 50 of 271 turns. An early context change can affect later turns whose own text is unchanged, so filtering out changed rows would not create a controlled model comparison. Upstream also cautions against comparing releases as interchangeable. [Release notes](https://github.com/zjunlp/DataMind/blob/a814927159470ad1624602d233f57b7c0be5882e/longds/README.md#whats-new-in-v11).
- **Protocol differences:** the shared-text Luna arm adapts the task wrapper for comparison with Dataflow. The historical sessions have a one-hour limit; the current pilot allows two hours. Executor protocols, prompts, runtime revisions, and model behavior also differ.
- **Historical input exposure:** original Luna DSGym Netflix turn 23 reads seven pre-existing `working_tables` files. The session's earlier turns did not create them, and they are absent from the pinned official input list. Retain the historical score, but exclude this run from claims about a clean matched model experiment. The current Terra pilot's scored runs used verified inputs; its contaminated initial attempts were excluded.
- **Sampling:** each table entry is one run. There is no Terra Dataflow arm in the current pilot.

On these eight historical sessions, Luna Dataflow has only one more correct turn than Luna DSGym with shared text. The earlier 68-session aggregate likewise provides little evidence of a general accuracy advantage: 34.57% versus 33.91% task-macro accuracy, with higher recorded accounting cost for Dataflow. [Earlier review](longds-trace-review-2026-09-30.md).

## What changes when we read the traces

### 1. Some Luna failures happen before useful working state exists

Original Luna DSGym Netflix turn 1 claims it cannot access the files without attempting Python. Across the session, 35 of 36 turns contain no Python call. Turn 23 finally lists and reads files, including the pre-existing working tables, but cannot recover the current score. This is weak evidence for a retrieval problem: most of the required computations were never performed.

In Luna Kiva turn 1, a file-listing call returns six input files and their sizes. The agent then says the needed execution output was not returned. The shared-text arm declines on turn 1 but loads and processes data on turn 2. Both score 0/37, but that sequence of zeros does not by itself prove a single numerical cascade.

Terra constructs substantial state and handles Netflix's long historical mixtures, reaching 36/36 and 35/36. Luna's shared-text Netflix run does execute 45 Python cells and still scores 5/36, so tool use alone is also insufficient. Terra sometimes skips useful execution too, as documented in LearnPlatform. These behaviors motivate a small execution/answer policy before treating every failure as a catalog problem.

### 2. Missing persistent updates recur across models and interfaces

Luna Dataflow BI task 1 turn 10 computes correct age-replacement statistics inside a function but returns only the report. The changed student rows do not become a reusable output. Turn 19 correlates an imputed table that retains the old ages.

Terra smolagents Kiva turn 12 has the same structural problem: it correctly reports excluded pairs without materializing the surviving population. Turn 13 joins poverty data to the broad social table.

**Opportunity:** make a changed working population an output in its own right. Produce its report downstream. A catalog cannot recover an update that remained local to a function or existed only in answer prose. Audit passing origin turns as well as failing descendants.

### 3. Correction propagation has a concrete positive example

In Luna University task 2 turn 5, both agents recognize a mistaken ratio interpretation after obtaining an empty cohort. Dataflow modifies `mahalanobis_all`, recomputes distances and connected filters, and retains 721 rows. Python changes the screening field but keeps old `squared_mahalanobis_distance`, retaining 718.

This is an observed mechanism supporting Dataflow: the corrected computation reaches its represented consumers. The old ratio wording is ambiguous, and the runs differ in other implementation details, so the score difference is not a controlled causal estimate.

**Opportunity:** test repair after giving both systems the same correction. Measure which dependent values update and whether intentionally historical results remain unchanged. A graph helps propagate a correction; it does not supply the correct formula.

### 4. Exact historical values help, but names and passing scores are insufficient

Luna Dataflow BI task 2 turn 19 compares saved computed correlations and returns a shift of 0.0351. Python types earlier four-decimal display values into code and returns 0.0350. An exact saved result prevents this loss of precision; Python can also preserve the unrounded object.

WiDS supplies a counterexample to interpreting a pass as correct state use. Luna Dataflow turn 29 uses old equal-share weights and returns a wrong cutoff. Luna Python uses the correct reduced weights and receives a pass, but its code compares against `equal_score` leaders instead of the preceding weighted-score leaders. The overlap count happens to match the reference value, 9. Both current Terra Python arms use the updated weights correctly.

**Opportunity:** inspect the actual values and versions consumed. A task-to-operator label or an answer match cannot establish that the intended historical component was used.

### 5. Terra exposes precise population mistakes that storage cannot settle

NFL smolagents turn 24 has both the correct 33-player candidate pool and the full 86-player table. The current instruction says to fit caps on candidates, apply them to all players, rank across each full side, and report current candidates. The agent fits, applies, and ranks on the candidate copy.

A useful computation boundary would make these roles explicit:

```python
caps = fit_caps(candidate_players)
all_scores = score_players(all_players, caps, current_pressure, current_play)
answer_rows = select_players(all_scores, candidate_keys)
```

The recorded inputs can then show which population was used at each stage. Checks derived from the public request can verify that `all_scores` covers all player keys. A description saying “full population” remains a model claim until checked against the actual result.

The Restaurant stress case adds a limit: smolagents joins the correct eligibility flag and then ignores it. Merely passing a table does not prove that the code applied every required predicate. A filtered eligible population or explicit cohort-key input is a more useful boundary than a wide table whose flags may be ignored.

## How to use error labels in our research

The taxonomy is useful for organizing cases. Our intervention should target the observed operation that failed. For example, NFL turn 24 is a current instruction/population error, while smolagents WiDS turn 2 is a clear inherited-error case: it correctly aggregates the gas column created incorrectly at turn 1. These should not receive the same proposed repair.

| Diagnostic category | What to test in our system |
|---|---|
| Instruction | Completion of the requested calculation and output fields; availability of an executable result alone is insufficient. |
| Stats/domain | Correct metric, denominator, entity grain, and population. Lineage preserves these choices but cannot determine their meaning. |
| Code | Clear execution errors and focused repairs; rerun affected consumers after a code correction. |
| Planning | Coarse reusable computations with explicit inputs; evidence does not justify a separate planner. |
| Context | Keep relevant earlier rules and definitions visible with their results. Test against persistent Python before expanding retrieval. |
| State | Select the intended current/historical result, retain updates, and isolate temporary changes. |
| Cascade | Identify the incorrect producer, correct it, and recompute the intended consumers. Count the originating mistake separately from affected answers. |

Our existing [`dsgym-roots.py`](../logs/registry/dsgym-roots.py) screens for failed turns whose declared dependency answers passed. That is useful case selection, but it is not a causal classifier. BI's missing age update starts in a passing answer. Conversely, a failed earlier answer may have left perfectly usable state. Benchmark dependency annotations describe intended task dependencies, not the actual values read by an agent.

For selected cases, record both the paper-style label and a compact causal account:

- The failing operation and any new error in this turn.
- The intended input, the input actually consumed, and their producer turns.
- Whether the wrong state originated in a turn whose answer passed.
- The concrete correction and which descendants should change.
- Evidence locations, confidence, and any reference/judge concern.

Use the paper prompt for an offline annotation workflow if a category census becomes necessary. Adapt our trace and workflow files into its evidence bundle, retain operator IDs and actual execution references, and audit a sample of labels independently. Do not feed reference code or benchmark dependency labels to the solving agent. Preserve the official scores alongside manual concerns. No classification service or new online skill is needed to test the algorithm.

## Recommended next experiment

1. **Keep the current Terra Python baseline and test the small policy first.** Preserve full working outputs, verify population/metric scope before reuse, isolate temporary changes, and support answers with executed results. Fix model, dataset revision, input snapshot, executor, limits, and answer protocol across the pair.
2. **Test explicit result dependencies with ordinary Python inside each computation.** Reuse three records: immutable results, per-turn consumed/produced/answer references, and current component choices. Render the catalog from those execution records. Prioritize working populations and their relevant definitions alongside answer projections.
3. **Separate the effects.** Compare policy alone against the baseline, then explicit boundaries, then the same boundaries with catalog visibility. Test correction replay separately with the same correction supplied to both arms. Otherwise a better prompt or changed execution interface could be mistaken for a catalog benefit.
4. **Transfer only supported behavior to native Dataflow.** Existing process operators and historical results already provide much of the machinery. Carry exact `answer_from` references through task finalization, and align the `supersede` prompt with its actual metadata-only behavior before making repair claims. The earlier analysis-state implementation already tested much of this design space and did not improve aggregate results; rebuilding it under new names is not evidence of progress.

The primary research question is whether explicit executed dependencies improve **state selection and repair** beyond a well-prompted persistent Python agent. Use accuracy, actual state consumption, repair completeness, recomputation, and cache-aware token usage. The existing eight sessions are development diagnostics; freeze held-out complete sessions before another comparison. The [Terra pilot plan](longds-terra-python-pilot-2026-09-30.md#proposed-next-experiment) supplies the staged design.

## Evidence

- [Comparison data, diagnostic cases, source hashes, and trace locations](longds-error-classification-and-luna-2026-09-30.json).
- [Current Terra pilot and 40-case audit](longds-terra-python-pilot-2026-09-30.md).
- [Earlier Luna/native trace review](longds-trace-review-2026-09-30.md).
- [Repository tree/provenance](../logs/longds-classification-review-20260930/upstream-provenance.json) and [content-search results](../logs/longds-classification-review-20260930/upstream-content-search.json).
- [Pinned Netflix input list](../logs/longds-classification-review-20260930/netflix-pinned-input-list.json).

The new evidence file includes eight diagnostic cases, links to five earlier paired cases, and relevant current-pilot cases. This is a selected manual audit, not an exhaustive error-frequency analysis. Raw run artifacts and downloaded upstream sources remain local and gitignored.
