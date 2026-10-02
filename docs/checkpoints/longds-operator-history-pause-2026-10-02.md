<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# LongDS operator history: pause checkpoint

Checkpoint date: 2026-10-02 UTC / 2026-10-01 America/Los_Angeles.
Research is paused at the user's request. All solver, correctness-judge and
error-annotation jobs for this work have completed. No further experiments are
queued.

## Outcome and current direction

Operator history and cached execution have working functional tests, and
reproduced cached-input stalls have been repaired. **The latest matched
experiment does not demonstrate an accuracy gain or fewer state errors.**
Neither history arm used historical inspection or fork. Luna's first two
questions passed, then incorrect population selection and formulas in question
3 propagated into later decisions. Terra's state updates and counterfactuals
were correct; its first-answer failures concern reporting completeness and an
inconsistent judge requirement.

The next useful experiment is a small test of how the agent selects an existing
producer and its population. Adding more state-management machinery is not
supported by this evidence. Cost parity with the script agent is also unproven.

## Workspace, revisions and saved evidence

Work and this checkpoint belong to:

- Worktree: `/home/bob/Desktop/dataflow-agent/.claude/worktrees/operator-history-lean`.
- Branch: `feat/operator-history-lean`.
- Code revision used for the latest experiment:
  `354af3a1425be648c90addb46263a7dca368cd38`.
- Pre-checkpoint HEAD: `7d2079b56`, which commits the completed diagnosis.
- Integrated `dataflow-actions` revision:
  `e85c0512b3ebd923de5b2d722e047b3cbb903501`, through merge `543ca4b7e`.
  This was a merge, not a rebase. The incoming checkpoint already contained
  cherry-picks of our engine repairs; the net incoming changes were benchmark
  comparison/retrieval code and reports. Later dirty work in that worktree was
  left alone.

All implementation changes were already committed before this pause. The only
remaining untracked paths are local dependencies/upstream links:
`agent-service/node_modules` and `benchmark/longds/DataMind`. Do not commit them.
The historical `state-registry` worktree was not changed for this checkpoint.

Tracked evidence:

- [Frozen latest experiment plan](../../benchmark/longds/reports/history-verification-plan-20261002.json):
  source hashes, model rates, judge identity, cases, settings and artifact paths.
- [Latest results and manual diagnosis](../../benchmark/longds/reports/history-verification-results-20261002.json):
  per-arm usage, judgments, error labels, partial checks and anomalies.
- [Engine repair report](../../benchmark/longds/reports/engine-stall-repairs-20261002.json):
  reproduced stalls, deterministic replays and verification.
- [Earlier lean pilot and latency audit](../../benchmark/longds/reports/operator-history-lean-pilot-20261002.json):
  an earlier revision; useful context, not a matched comparison to this run.

## Design retained

The user chose a simple operator-history design:

1. Keep all tasks on one dataflow and use regular ReAct.
2. Preserve past questions, answers, actions and observations in append-only
   conversation history.
3. Retrieve state by operator ID, optionally selecting a completed task's
   version. No task catalog, task-level retrieval or separate graph per task.
4. Inspect versions and lineage when needed; fork an earlier operator and its
   dependency closure when computing from an older state.
5. Start with samples and statistics. Retrieve full records only when the
   required row associations are still unresolved.

The existing predefined computational operator reference remains. The removed
concept is the additional historical task/state catalog.

### Current action contract

The native tool accepts `dataflow(reasoning, actions)` with an ordered action
list. Inspect, Edit, Execute, Retrieve and Answer remain separate actions.
History-enabled sessions additionally expose state inspection and Fork.

- Edits invalidate affected results and do not execute.
- Execute without a selection requests the whole logical graph. With
  `operator_ids`, it executes those operators and their upstream dependency
  closure, reusing valid cached results.
- Retrieve reads an existing result and never computes. Missing, stale or
  incomplete outputs are labeled.
- Inspect/fork can read the exact saved historical producer result without
  substituting the current result.
- Answer is the sole action in its batch; the requested final JSON goes in
  `answer.content`.
- A model writes the entire action list before seeing its results. An edit or
  answer that depends on a new inspection belongs in the next model call.

Implemented history shapes include:

```json
{"type":"inspect","target":"state","operator_id":"score","task_id":null,"include_implementation":false,"view":null}
```

This lists version changes; unchanged versions are grouped. A dependency change
can change the subgraph hash even if the operator expression is unchanged.

```json
{"type":"inspect","target":"state","operator_id":["eligible","score"],"task_id":2,"include_implementation":true,"view":"sample_stats"}
```

This reads definitions, incoming edges and saved results for the selected
completed task. A result view requires a task ID; `view:null` reads definitions
alone. Batches accept up to eight distinct operator IDs.

```json
{"type":"fork","task_id":2,"operator_id":"eligible","new_operator_id":"earlier_eligible"}
```

Fork copies the dependency closure under new IDs and returns the mapping.
Retrieve can read its saved output. Execute the copied branch if materialization
is unavailable or the definition changes. Rewire explicitly when applying an
old formula to today's population; a fork initially preserves the old inputs.

The system prompt already contains generic history examples, including restoring
an earlier population, applying an earlier formula to current inputs and keeping
a sensitivity branch separate. It also distinguishes an authoritative limited
result from a display sample. Benchmark-specific questions or gold answers are
not used as prompt examples. Version preservation does not certify correctness.

Relevant implementation:
[prompt construction](../../agent-service/src/agent/prompts.ts),
[action schema](../../agent-service/src/agent/tools/dataflow-actions.ts),
[action runtime](../../agent-service/src/agent/tools/dataflow-action-runtime.ts),
[execution tools](../../agent-service/src/agent/tools/workflow-execution-tools.ts).

## Completed implementation and repairs

| Area | Delivered | Main commits |
| --- | --- | --- |
| Lean state access | Operator-only version inspection, batched reads, fork and stats-first guidance | `edb9cb1aa` |
| Subset semantics | Preserve explicitly reviewed subsets; distinguish logical limits from output sampling | `15dee1692` |
| Execution scope | Execute selected branches with upstream closure; isolate unfinished siblings | `174e24c12` |
| Cache payloads | Bounded fingerprints instead of large duplicated payloads | `0ca4a7e52` |
| Historical results | Recover the exact cached producer after registry cleanup | `29958c4c1` |
| Cached input stalls | Port-aware cached-reader identity, sender routing and surfaced detached-reader failures | `924e42e90` |
| Statistics lifecycle | Serialize writes and closure; flush before synchronous request completion | `3bede8dd3` |
| Error diagnosis | Distinguish cached-read failures; require real deadline evidence for timeout labels | `574719aca` |
| Trace reproduction | Deterministic multi-input cached fanout replay | `2cf15ca9f` |
| Native context | Preserve multiline thought-only replies instead of truncating at the first line | `49d883c6b` |
| Persistence failures | Drain accepted writes, attempt close and propagate write/close failures | `b1e9255f7` |
| LongDS prompts | Explicit Execute, read-only Retrieve and final JSON through sole Answer action | `354af3a14` |

### Engine findings

The reproduced cached-input stall was an engine problem: one saved table feeding
two destination ports reused a reader/channel identity that omitted the input
port. One mapping overwrote the other, leaving a port waiting for input. Python
and JVM routing now distinguish destination port and internal-port status.
Detached reader failures also reach the worker's error path, including while
paused. A missing cached file produces a prompt infrastructure error, rather
than an unexplained wait.

Statistics writes previously raced with shutdown and table deletion. One executor
now owns the writer, accepted writes drain before close, late submissions are
rejected, and synchronous requests wait for the flush. Failed writes/close are
reported. **Remaining limitation:** the close wait has no independent service
deadline. A storage flush that never returns can still delay HTTP completion.
The latest run did not exhibit this issue.

The deterministic replays separate transport from analysis errors: count
callbacks finish in about 2.1 seconds; the original submitted callbacks still
produce their incorrect-column/input `KeyError`s, now returned in about 1.7–1.9
seconds. Repairing the engine does not repair a generated formula.

### Context and prompt findings

A native-frame extraction regex used a multiline end anchor and silently
truncated a thought-only completion at the first line. It now preserves lists,
blank lines, fenced JSON and the complete reply, while stopping at a real Action
block. This was a real bug, but it is not established as the cause of the latest
Luna failures.

The LongDS native wrapper formerly retained instructions inconsistent with
explicit actions. The TypeScript harness now uses a tested
[shared wrapper](../../agent-service/benchmark/multiturn/longds-prompt.ts).
The [Python driver](../../benchmark/longds/run_longds.py) selects the native or
legacy code-mode contract from the SUT's mode. Task text, context and data
inventory are retained, and solver prompts do not contain gold answers.

## Latest completed experiment

One matched diagnostic repeat per model/case, four sessions and **24 questions**:

- Luna: Restaurants first eight questions, control versus history.
- Terra: Kiva first four questions, control versus history, after Luna completed.
- At most two solver sessions ran concurrently. No solver or SDK retries.
- Each pair used the same engine, model, context and output budgets. Only
  `stateHistory` and its associated prompt/tool additions differed.
- Cases differ across models; this is not a cross-model comparison or a
  statistically significant accuracy study.

Shared experiment settings: `retrievalViews:["sample_stats","full"]`, full cap
5,000 characters, sample budget 2,000 characters / 50 rows, statistics budget
2,000, profile collection on and flow evidence off. These are experiment
overrides; the general service default for full output remains 100,000.
Context uses `delta`, `turnHistory:"full"`, native message layout, the latest
user request at the bottom, no context-window compaction and no thought replay.
Limits were 40 model calls per question, 8,192 output tokens and medium reasoning.

| Arm | Correct | Solver estimate USD | Calls | Cached input | Session seconds | State labels | Cascade labels |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Luna control | 2/8 | 0.0643256 | 41 | 94.795% | 364.100 | 2 | 5 |
| Luna history | 2/8 | 0.0568516 | 47 | 96.143% | 384.195 | 2 | 5 |
| Terra control | 3/4 | 0.1376118 | 10 | 85.932% | 152.804 | 0 | 0 |
| Terra history | 3/4 | 0.1468800 | 10 | 85.872% | 217.061 | 0 | 0 |

Labels count answers with that category, including secondary labels; they are
not mutually exclusive. Luna scores were `[1,1,0,0,0,0,0,0]` in both arms.
Terra scores were `[0,1,1,1]` in both arms. **Historical inspect/fork usage was
zero in all four sessions.** Current graph/operator inspections did occur.

The earlier lean Luna pilot scored control 5/8 and history 4/8, with costs
$0.06430978 and $0.04910366. Its engine and prompt revisions differ, and neither
arm used historical actions. Do not attribute the difference between repeats
to the newer engine or claim a history effect from those snapshots.

## Manual trace diagnosis

1. **Luna control, question 3: incorrect population and gates.** A top-commission
   selection uses `limit` without the required sort. At step 6, `decisions`
   rewires its eligible baseline input to all `unit_rates`. The diagnose rule
   also admits quality-clear units outside the commercial gate. Counts are
   3 advance / 13 diagnose / 15 hold, versus 3 / 15 / 12. These are generated
   algorithm and state-selection errors, not numeric transport corruption.
2. **Luna history, question 3: a report becomes a lookup.**
   `relevant_with_watch` reads filtered `first_watch` instead of full
   `pressured_units`. Other relevant candidates lose their commercial threshold
   and flag evidence. The answer has zero advance units instead of three, even
   though the correct upstream state exists. No historical inspection is used.
3. **Luna control, question 5: customer/order grain mismatch.** The code divides
   149 high-value customers by 1,898 orders, yielding 7.8504%. An independent
   raw-data check finds 580 high-value orders; the required share is 30.5585%.
   Operator history cannot correct this formula on its own.
4. **Luna history, questions 5–6: empty state erases a global constant.** The
   wrong advance set makes `weak_reach_scored` empty. Question 6 uses that table
   as its source and fills both missing unit coverage and missing
   `all_high_value_share` with zero. Missing coverage may be unproven, but the
   global baseline must come independently from `all_customer_value_share`.
   The candidate pool also includes all operating decisions instead of only
   diagnosis units.
5. **Luna control, question 7: limited source and malformed join keys.** It uses
   the prior top-eight report as a complete risk pool. `str.split(" | ", n=1)`
   interprets the separator as regex alternation, corrupting labels and causing
   zero-row joins. Keep explicit key columns rather than parsing display labels.
6. **Question 8: cascades plus new errors.** Control sorts a signed gap instead
   of fallback magnitude and inherits a restricted pool. History compares a
   unit rate to a global slow-rate baseline rather than the two required unit
   rates, selects flag flips and falsely reports service-only risk crossings.
7. **Terra: calculation and reporting differ.** Both arms identify the same five
   Kiva pairs and all five initial pressure scores are correct. Questions 2–4
   pass, including state changes and counterfactual/restoration calculations.
   Initial-answer reporting omissions need a separate audit from state errors.

An important qualification to the Codex labels: history question 5 uses a spend
median over six-plus-order customers. That is a definition mismatch, but the
order-count 90th percentile is three on this data, so those customers already
qualify by frequency. This branch cannot change the high-value set here. The
observed failure is the inherited empty advance state.

### Judge and annotation evidence

Correctness uses `deepseek/deepseek-v4-pro` through OpenRouter and the benchmark's
original appendix E.2 `JUDGE_PROMPT`, loaded from the local upstream module.
The frozen prompt hash is in the plan. Error labels use original appendix E.3
instructions through [the annotation runner](../../benchmark/longds/annotate_errors.py)
and its native trace adapter: Codex `gpt-5.5`, `xhigh`. All four annotation
outputs are valid; 14 failed answers were classified. The seven original
categories are statistical/domain reasoning, planning, instruction following,
coding/implementation, context memory, state management and cascade.

Original answers, traces, references and correctness scores were preserved.
Annotation integrity and frozen source/reference hashes passed verification.
Labels were manually checked against traces, including the inactive cutoff
branch above. Operational engine/code failures are recorded separately.

The Terra first-answer judgments have an inconsistency: control is penalized for
omitting `loan_count`, while history's judgment explicitly calls that field
optional. History instead omits the raw completion/wait/term values and reports
transformed scoring components. Preserve both official zero scores and record
the disputed requirement rather than silently changing the leaderboard.

The report contains an exploratory partial audit of entity membership, group
counts and numerical fields. For example, control question 6 identifies 7/8 risk
entities and 5/8 main shortfalls; history question 7 finds all three true names
but adds three false names. This is not an official partial-score metric and
must not be averaged into an accuracy claim. Control question 3 has one missing
root-closing JSON brace; only the offline parsing audit appends it, with the
repair recorded. The solver answer and official judgment remain unchanged.

## Cost, context and anomaly observations

History was **11.6% cheaper on Luna and 6.7% more expensive on Terra**. The
equal-or-lower-cost goal therefore is not satisfied across both pairs.
Solver estimates use the frozen token-rate tables, counting fresh input,
cached input, cache writes and output including reasoning. They exclude judge,
annotation and infrastructure costs.

| Arm | Fresh input USD | Cached input USD | Output USD | Reads: stats / full | Largest full result chars |
| --- | --- | --- | --- | --- | --- |
| Luna control | 0.0120052 | 0.0218644 | 0.0304560 | 18 / 9 | 1,416 |
| Luna history | 0.0097844 | 0.0243872 | 0.0226800 | 5 / 16 | 4,545 |
| Terra control | 0.0382880 | 0.0233878 | 0.0759360 | 2 / 4 | 1,798 |
| Terra history | 0.0419520 | 0.0255000 | 0.0794280 | 2 / 3 | 2,211 |

No cache-write tokens were recorded in solver usage. Provider-reported
cached tokens establish the cache fractions above; repeated text or matching
prefix bytes alone would not establish a cache hit. There were no missing-usage
calls and no detected within-turn prefix mutations.

The historical DSGym Luna Restaurants run was 2/8 at $0.04757015. Current native
control is about 35.2% more expensive and history about 19.5% more expensive than
that estimate. **DSGym was not rerun for this revision/prompt**, so this is
descriptive historical evidence, not a fresh matched script comparison.

The four solver estimates total $0.405669. OpenRouter's recorded correctness
judge cost totals $0.02727836955. Codex annotation token usage is recorded
separately, without a dollar or billing claim. Annotation usage is substantial
and must be included separately when estimating overall evaluation cost.

Every prior answer appears three times in each final-question context: assistant
text, the Answer tool argument and the Answer observation. **Answers are
present, not missing.** Removing redundant synthetic echoes is a possible cost
improvement, provided the original answer/action/outcome and stable history are
preserved.

Latest run monitoring found:

- Zero engine timeouts, confirmed infinite loops or statistics commit/deletion
  errors. Functional repair evidence does not establish that all stalls are fixed.
- Ten unavailable-result alerts in Luna control and one in Terra history;
  generated schema/code errors were repaired during the runs. Terra's recovered
  error attempted a Boolean sum where native sum expects numeric input.
- One split provider completion in Luna history. The existing recovery selected
  the unique tool-bearing choice and accounted for the entire response usage.
- One malformed final JSON answer, described above.
- The initial annotation launch lacked `codex` in the systemd user PATH. Failed
  attempts made zero model calls, were preserved, and were relaunched with the
  correct PATH. All labels completed. A failed old unit can remain listed even
  though no annotation work is running.

## Validation completed before the pause

- 1,219 Bun tests passed; agent typecheck passed.
- Two Python prompt-contract tests and 15 comparison/annotation tests passed.
- Four statistics lifecycle tests passed, covering drain/close ordering and
  write/close failure propagation. They do not provide a storage service deadline.
- New multiline-context, persistence-failure and prompt-contract regression
  tests failed before their corresponding fixes.
- Latest deterministic state-history smoke passed:
  `/tmp/state-history-e2e-C8WhYF` (historical reads, fork, rewiring and control isolation).
- Latest cached multi-input replay passed:
  `/tmp/cache-stall-replay-fkosHG` (bounded success and prompt callback errors).
- The prior engine repair gate passed 127 Python tests with one expected failure,
  46 distinct JVM tests, 21 agent diagnostic/deadline tests and the stage build.
  See the engine report for exact commands, logs and earlier smoke artifacts.

No extra model experiments or implementation changes were made to create this
pause checkpoint. Documentation/link checks are separate from those earlier
code validations.

## TODO on resume, in priority order

1. **Test producer selection before expanding the campaign.** Add one short,
   generic prompt example: a filtered report is not automatically a full lookup;
   verify its producer, population, required fields and independent global
   constants before joins or imputation. Read current state when it is valid;
   inspect history when the needed state has changed or is uncertain. Keep the
   existing operator-only interface.
2. **Replay one decision question from an identical successful prior state.**
   Compare the current prompt with that generic cue using the same model,
   engine, budgets and frozen prior checkpoint. First implement/verify the
   harness's restoration of exact materializations and history; a fresh run or
   hidden reference recomputation is not an equivalent checkpoint. Inspect
   actual tool use, selected input versions, populations, quantities and cost.
3. **Separate root mistakes from cascades.** Audit the first wrong question
   before interpreting downstream state labels. A preserved wrong formula is
   still wrong. Follow a useful mechanism result with a held-out update/rollback
   case, then repeated matched sessions.
4. **Reduce Answer duplication.** Remove redundant synthesized echoes while
   retaining original actions/outcomes and all past questions/answers. Verify
   append-only prefix behavior and compare cost and accuracy in a matched test.
5. **Reduce repair churn.** Investigate Boolean aggregate guidance or semantics,
   schema assumptions, explicit join keys and narrower projections. Start bug
   fixes with regression tests. Do not widen aggregation semantics casually.
6. **Resolve the storage close deadline design.** Handle stalled storage without
   deleting a table while its writer is still active. The current ordering tests
   cover slow/failing closure but not a nonreturning flush.
7. **Audit final-answer completeness and judge interpretation.** Keep original
   E.2 scores and E.3 labels; add explicit manual field/quantity checks. Distinguish
   raw fields, transformed indicators and optional support fields. Do not
   repeatedly rejudge until an answer passes.
8. **Run a fresh matched script comparison only after a useful signal.** Match
   model, question prefix and budgets, report retries and include judge/annotation
   costs separately. Accuracy gains and cost reductions remain hypotheses.
9. **Preserve local evidence before cleanup.** Full snapshots are roughly 1.2 GiB
   in this campaign, and annotation bundles repeat extensive trace/context
   evidence. Consider a compact annotation index with full raw evidence still
   accessible and original E.3 semantics preserved. No trace deletion or context
   compaction was done at this checkpoint.

No TODO above has been launched. Avoid a full benchmark campaign until the small
mechanism experiment shows that the agent actually uses the relevant state.

## Local artifacts and service state

Latest runtime root: `/var/tmp/texera-history-verification-20261002`.
Each `runs/<arm>/<case>/` contains per-question prompts, answers, usage/stats,
ReAct steps, workflow/snapshots, original judgments, summaries and anomaly logs.
Controller, judge and annotation launch scripts are also saved in that root.

Case IDs:

- `business__nyc_restaurants_data_food_ordering_and_delivery__task2`.
- `social_good__data_science_for_good_kiva_crowdfunding__task1`.

Prepared data, inputs and references are under
`/var/tmp/texera-state-history-20261001/{prepared,inputs,references}/<case>`.
The upstream DataMind/data revision is
`bf41bb28474fa9540d98922a6f5e6310ed014e51`.
The reviewed paper text is at
`/home/bob/Desktop/dataflow-agent/.claude/worktrees/state-registry/logs/longds-classification-review-20260930/paper-raw.txt`.

Ignored evidence in this worktree:

- `logs/history-verification-20261002/`: frozen campaign, report builder, smoke
  output and `annotations-{luna,terra}/aggregate.json` plus per-arm labels/usage.
- `logs/engine-stalls-20261002/`: regression logs, deterministic replay manifests
  and final repaired-engine log checks.
- Earlier pilot: `/var/tmp/texera-operator-history-lean-20261002/pilot`.
- Earlier broader runs: `/var/tmp/texera-state-broader-20261001`.

Original annotation bundles are
`/tmp/longds-annotation-20260930-9h3i3ifq` and
`/tmp/longds-annotation-20260930-1q0nnf6y`. `/tmp` is ephemeral. The compact reports
are committed; raw traces, datasets, local scripts, credentials and logs are
not. Copy required raw evidence to persistent storage before deleting local
runtime directories. Do not commit credentials or private profiles.

### Paused private stack

`longds-engine-stall-repair.service` was stopped for this pause; systemd reports
inactive/dead with successful shutdown. There are no listeners on its agent
3037, engine 38086 or Pekko 32558 ports. Other stacks and worktrees were not
stopped or modified. In particular, the older agent on 3036 points to engine
38085 and must not be used as a matched control for the repaired engine.

The private launcher is
`/var/tmp/texera-engine-stall-repair-20261002/stack/start-engine.sh` and uses
`bin/local-dev.sh`. It requires port-discovery offset 30001 and the private
profile in the same directory. The profile contains credentials: do not print
or commit it. The old web/compiler/database/proxy dependencies belong to their
separate private stack and remain running at this checkpoint.

After the user asks to resume, check the branch/status and retained artifacts
first. For the same built revision, the owned services can be restarted through
the supported launcher with the existing private profile:

```bash
cd /home/bob/Desktop/dataflow-agent/.claude/worktrees/operator-history-lean
export TEXERA_LOCAL_DEV_PROFILE=/var/tmp/texera-engine-stall-repair-20261002/stack/profile.sh
export TEXERA_LOCAL_DEV_PORT_OFFSET=30001
bin/local-dev.sh up computing-unit-master --skip-build
bin/local-dev.sh up agent-service --skip-build
```

Keep lifecycle ownership explicit if using the saved systemd wrapper. Rebuild
when changing engine code, and regenerate Python protos on a fresh clone or
after proto changes. Verify private endpoints and current settings before
launching anything. The previous campaign is complete; do not rerun its launch
scripts automatically when resuming.
