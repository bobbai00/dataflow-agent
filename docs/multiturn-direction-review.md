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

**Research direction review, 2026-09-20.** Reviewed `e410903c5` on
`feat/task-history-dataflow`, including the local campaign artifacts. At the
start of review there were no staged or unstaged tracked changes; the two
untracked paths were the existing `.venv` and `agent-service/node_modules`
symlinks. This review adds documentation and an
[evidence ledger](../agent-service/benchmark/multiturn/DIRECTION_REVIEW_EVIDENCE.json).
It does not change the runtime or run a new model campaign.

Follow-up, 2026-09-21: the user's proposal to study marginal task cost in long
conversations is analyzed in [LONG_HORIZON_REVIEW.md](../agent-service/benchmark/multiturn/LONG_HORIZON_REVIEW.md).
That analysis finds a successful reuse case hidden by session totals and
recommends testing bounded catalog context as the next milestone.

The subsequent [implementation and testing plan](long-horizon-catalog-plan.md)
separates the completed ReAct cleanup from the proposed bounded-memory and
switching experiments. The findings below describe the earlier recorded runs.

**Revised recommendation: test bounded catalog context and the cost of later
tasks before adding more maintenance operations.** The branch establishes
useful runtime capabilities. It does not establish a general multi-task accuracy
or model-cost advantage. The follow-up analysis makes cost at increasing history
depth the primary outcome, with comparable task difficulty and accuracy; setup
spending and cumulative break-even remain secondary outcomes. Separate the
benefit of reusing a correct analysis from the reliability of constructing it.

My September 18 review proposed dependency maintenance, compact context,
demanded execution and a retention control. Those have largely been implemented.
Repeating that proposal would not advance the investigation. The outstanding
work is a controlled test under increasing reuse and history depth, actual
execution measurement, and an honest comparison against persistent Python,
including a control with bounded memory.
The latest recommendation to grow `membership_values` is plausible for studying
historical memory, but its claimed kept-frame mechanism does not survive trace
inspection.

The attempts so far form a coherent progression:

| Attempt | What we learned |
| --- | --- |
| Catalog/context experiments and chronological batching | Representation and cache behavior can dominate model cost. Older Dataflow-versus-Dataflow results do not establish a CodeAgent win. |
| Saved recipes and reusable-function control | Reusing a computation is possible in both interfaces. The early recipe prototype added binding and cloning mistakes and did not beat the function control. |
| Explicit state registry | Publication, revision and branch behavior worked, but the interface imposed additional model work. |
| Task history, complete results and direct return | `atTask` supplies immutable values; direct return removes a copying step. These simplify the interface without proving semantic correctness. |
| Cache boundaries and reuse guidance | Cache accounting improved and historical preservation showed a signal. The candidate still lost the overall comparison. |
| Compact index, receipts, dependency maintenance and demanded execution | These implement most of the earlier research proposal. They reduce overhead against our own Dataflow control. |
| Kept frames and return guards | Some real-session intermediates became accessible, but reuse remained inconsistent. One guard also obstructs legitimate reuse. |

Sources: the earlier [research review](../agent-service/benchmark/multiturn/RESEARCH_REVIEW.md),
[state milestone](../agent-service/benchmark/multiturn/STATE_MILESTONE_REPORT.md),
[cache comparison](../agent-service/benchmark/multiturn/TASK_CACHE_LIVE_REPORT.md),
[maintenance implementation](dependency-maintenance.md), [frame implementation](kept-frames.md),
and the sibling worktree's [recipe study](../../multiturn-dataflow-research/agent-service/benchmark/multiturn/REPORT.md).
The recipe study already proposed explicit boundary bindings and atomic
fork/override/observe. That is unfinished prior work, not a new discovery here.

**The recorded totals reconcile, but several interpretations need correction.**
I checked all 1,575 answer/evaluation records and reaggregated usage from all
144 sessions in `dev-run2`, `frames-run1`, `synthetic-run1` and `dev-run3`.
The ledger preserves campaign revisions, manifest hashes and trace references.
These are 144 executions, not 144 independently authored workloads.

The six-family controlled campaign gives:

| Arm | Strict correct / 144 | Entire sessions correct / 18 | Recorded model cost |
| --- | ---: | ---: | ---: |
| `code` | 139 | 15 | $0.0960 |
| `coderetain` | 139 | 15 | $0.1162 |
| `tasks` | 139 | 14 | $0.1638 |
| `reuse` | 140 | 15 | $0.1839 |
| `maint` | 134 | 10 | $0.1651 |
| `demand` | 141 | 15 | $0.1790 |
| `frames` | 135 | 14 | $0.1737 |

Strict scoring uses the existing exact key/list comparator and absolute numeric
tolerance of `1e-4`; it accepts parsed Python literals and numeric strings.
Costs use recorded repository rates, include the recorded attempts, and exclude
engine/storage costs. Usage on every task does not prove that every failed
provider request reported usage. There are only 48 distinct requests per arm,
repeated three times. Cluster uncertainty by session/template; the report's
independent-answer standard-error calculation is not an appropriate inference.

1. **The baseline description is wrong.**
   [The latest report](multiturn-findings.md) says `code` carries no state and
   `coderetain` adds variable persistence. Both use one agent, with
   `reset=False` after task 1 in
   [run-task-code.py](../agent-service/benchmark/multiturn/run-task-code.py).
   The installed `LocalPythonExecutor.send_variables` updates its existing
   dictionary. A local, model-free probe confirmed persistence; the current
   wrapper hash matches the saved campaign config. `coderetain` adds automatic
   historical snapshots, `retained(task, name)`, and a prompt index. Its gap
   measures that bundle, not basic persistence. The earlier reports described
   the ordinary persistent baseline correctly.

2. **The 24/24 result does not demonstrate a kept-frame benefit.**
   All three `frames-membership_values` traces contain zero `{operator, frame}`
   references. In fact, the entire controlled `frames` campaign contains zero
   such references. In this family the arm uses ordinary native operators and
   `atTask` references. All five ordinary CodeAgent failures have correct
   current counts/values and wrong `baseline_count`/`baseline_value`; all four
   retention-control failures in this family have the same pattern. Both code
   arms pass every original-membership/current-values task at positions 3 and 6.
   One failing retention-control trace explicitly loads task-2 data and applies
   the current threshold to reconstruct the original publication. That is wrong
   historical selection, despite available snapshots.

   Thus the observed signal is preservation of an original publication. It is
   not evidence that latent intermediate tables caused the gain. A prompt or
   trajectory effect remains possible. Also, `frames = maint + frames` and
   `demand = maint + demand`; they are sibling treatments, not a cumulative
   mechanism ladder. Three successful repetitions are useful observations,
   not feature attribution.

3. **The stale-answer guard penalizes a correct reuse case.**
   In `synthetic-run1/frames-membership_values/t08`, the question asks to repeat
   current totals and the original publication. `task5_json` was refreshed at
   task 7 and already contains exactly the task-8 gold answer. The first return
   of that operator is refused because task 8 edited/executed nothing. The
   agent creates `task8_json` and returns the same values. This is directly
   visible in the prior result, refusal and subsequent tool call recorded in
   the ledger. The final pass hides an unnecessary call and duplicate operator.

   [The guard](../agent-service/src/agent/texera-agent.ts) tests operator/task
   identity rather than answer relevance or result freshness. Its second-return
   escape prevents a hard prohibition, but still taxes read-only reuse. Before
   another cost comparison, add this case as a regression and distinguish
   actual stale materializations from a heuristic about an irrelevant answer.
   A semantic warning must not be reported as an engine freshness guarantee.

4. **Kept frames expose replayable locals, not universally saved values.**
   [The Python hook](../agent-service/src/agent/native/python/runtime.py) records
   names, schemas and row counts at return. A frame reference creates a new UDF
   using the parent's code and inputs; historical references replay the sealed
   definition over retained inputs. Accessing two frames can execute the parent
   twice. This is useful discoverability and code reuse, but exact historical
   equality requires deterministic code with all inputs declared. Randomness,
   external reads and side effects are material limitations. Persisting actual
   intermediate outputs would be a distinct implementation and cost tradeoff.

5. **Cost varies with trajectories too.**
   `maint` university cost changes from $0.0705 to $0.1311 in the repeat, an 86%
   increase; `frames` NFL changes from $0.3059 to $0.4632, a 51% increase.
   Accounting is deterministic after a run; expected arm cost is not. The
   reported 28% Dataflow-control saving is a valid observed comparison, not a
   stable estimated treatment effect. Two scores of 10/21 and 2/21 establish
   variability, not a statistical band of plus/minus eight. Three trials are
   a development starting point, not an automatic adequacy threshold.

6. **Interface and evaluation changes remain mixed with the graph question.**
   Complete return and guards apply to direct-return arms beyond `maint`.
   Receipts' `Executed` sets are populated from result callbacks, which can
   include cached results; count physical execution separately. The demanded
   policy also executes edited operators even if nobody demands their output.
   These are qualified capabilities, not full tuple-level incremental execution.
   The LongDS adapter already gives both arms a JSON contract, derived from
   gold shape. Its field names and array lengths can reveal answer information;
   it is an adapted track, not official LongDS scoring. Future contracts should
   come from the public request, with entity naming and order explicit where
   genuinely required. A reference program reproducing gold does not certify
   that public wording uniquely determines it.

**The research needs to distinguish three forms of reuse.**

| Request | Required capability | What would explain a win |
| --- | --- | --- |
| Repeat the original report | Retain and select an old value | Artifact memory; a transcript or snapshot may suffice |
| Use original membership with today's measurements | Select historical keys, join current values, compute | Version selection and correct column binding |
| Apply the old scoring rule to today's cohort and refresh dependent reports | Reuse a computation with new boundary inputs, propagate and execute | Executable dependencies and reusable definitions |

The current strongest controlled difference concerns the first row. The third
row is where a dataflow has more work to take away from the model. A Python
agent can also define reusable functions, so the comparison must allow that.
Neither historical tables nor a larger catalog resolves which rule or population
the user intended. State selection remains a model problem. Correct runtime
retention and failed agent reuse do not establish that state management is
irrelevant or that the abstraction has exhausted its possible value.

**The next experiment should establish the conditional value of maintenance.**
Use two small workload families: a shared source/assumption correction, and a
temporary scenario that must leave the active analysis and original publication
intact. Require named output tables/reports, with the same artifact requirements
for every arm. After a change, verify every requested current report and the
unchanged historical/independent reports. Repeating a scalar answer is too weak
a test of maintaining an analysis.

Start each system from a checked equivalent analysis: normal Python functions,
variables and snapshots for the code control; matching operators and retained
tables for Dataflow. Give both the same definitions and information. Label this
as an assisted maintenance diagnostic, excluded from ordinary benchmark scores.
It measures whether runtime maintenance helps once construction succeeds. Do
not supply only Dataflow with a correct program or cripple Python's ability to
rerun a function or loop over reports.

Initially vary dependent reports at 1, 4 and 16, holding analytical difficulty
and output budgets comparable. Compare persistent Python with snapshots,
Dataflow maintenance, and the same Dataflow with demanded execution. Two
families × three sizes × three arms × three full trials is 54 sessions. Choose
one size for a subsequent irrelevant-branch control; do not start with a large
cross-product. Fix the guard and freeze the answer contract before the run.

Measure correctness first, then model calls/dollars, generated edits, actual
CPU and wall time, source bytes read, materialization hits, and retained bytes.
Record the initial artifact set and fresh-source recomputation as the oracle.
For a supplied correct program, construction cost is explicitly excluded; it
must be restored in the following end-to-end experiment. Report repeated-run
variation and whole-session failures, not best retries.

Then let the agents build those analyses themselves and run the same revisions.
Charge all construction and failed repair work. Compare the assisted and
unassisted results, and retain ordinary persistent CodeAgent alongside the
snapshot control in the end-to-end comparison. Snapshot-index overhead must not
make the chosen baseline artificially easy to beat. A benefit only with the supplied graph identifies an
acquisition/interface bottleneck. A benefit in execution time alone supports
a compute claim, not lower model cost. If there is no useful benefit even from
a correct reusable analysis, stop expanding this maintenance approach on these
workloads. More prompts or extra history mechanisms would lack a demonstrated
opportunity to recover.

**If maintenance has value, choose one implementation direction from the traces.**

| Operation or change | Why try it | Evidence required before a larger build |
| --- | --- | --- |
| Edit a shared input and refresh demanded outputs | Already implemented; tests propagation and selective execution directly | Correctness plus lower measured maintenance work as reuse grows |
| Rebind a saved computation to explicit new boundary inputs, with overrides in the same batch | Addresses old-definition/new-data tasks without regenerating the whole program; builds on the earlier recipe prototype | Fewer edits/calls than ordinary reconstruction, against Python functions; no current/default mutation |
| Preserve an intermediate table once, as an actual output | Avoids repeated UDF replay and makes identity exact for later reads | Repeated use of that intermediate in real traces; compute/storage savings exceed capture cost |
| Expose ordinary Python backed by dependency tracking | Removes the requirement to choose a native graph decomposition before useful work exists | The correct graph helps, but agent-built graphs remain stars or regeneration dominates |

For rebind, make membership keys, current values, computation version, and fixed
publication distinct bindings where the task needs them. Validate native join
cardinality and column origins; mark UDF-internal lineage unknown. Keep this a
small operation over the existing graph. The previous publish/revise/registry
interface and unrestricted recipe IDs already demonstrated the cost of extra
state vocabulary.

The Python direction is an interface pivot that retains the dataflow hypothesis.
An executed cell can become a versioned computation with declared inputs and
outputs; the runtime handles freshness and affected consumers. Start with
bounded cell/UDF boundaries instead of claiming exact dependencies through
arbitrary mutable Python. Existing [ipyflow documentation](https://ipyflow.readthedocs.io/en/latest/index.html)
describes dependency tracking, staleness, slicing and reactive execution, so this
needs an agent integration and measured contribution, not a novelty claim for
reactive notebooks. This is a proposed direction, not something this review
implemented or evaluated.

**Keep LongDS for transfer; change the diagnostic task before changing the entire
benchmark.** The official [LongDS release](https://huggingface.co/datasets/zjunlp/LongDS)
currently recommends v1.1 Lite: 24 complete sessions, 777 turns, with revised
scope and output conventions. It uses semantic judging and does not require
our JSON format. Pin and audit that version rather than pooling it with existing
adapted results. Select complete sessions by public state operations before
seeing new scores, disclose prior exposure, and retain independent-analysis
controls. Netflix and survey still need their recorded reference discrepancies
resolved. Policing was already reference-clean in both checked environments and
is a sensible additional development case; recheck any new version before use.

A useful extension would ask the agent to maintain an analysis as data exports,
metric definitions and scenarios change, and verify the resulting artifacts.
It should contain realistic historical/current compositions and repeated source
updates, not obscure wording or artificial memory loss. Increase data size only
when source reads or recomputation are the hypothesis, and include storage and
engine overhead. Expanding only the family where an arm happened to win risks
selecting a memory benchmark while claiming a dataflow result.

**Completion should mean resolving the claim, including a negative result.**
Freeze the practical target and evaluation size after the development variance
is known. Promote a claim only when the relevant feature is actually used,
matched ablation removes its benefit, quality remains acceptable, and the
advantage survives complete unseen sessions with construction costs included.
If snapshots explain the improvement, call it artifact memory. If automatic
propagation saves compute only, report that. If a Python interface recovers the
benefit, move the abstraction into that runtime. If all three comparisons remain
negative, close the general cost/accuracy claim and retain the useful engineering
without another round of speculative knobs.

Validation for this review: 41 relevant Bun tests passed across eight files;
39 Python runtime tests passed; `bun run typecheck` passed. The Python suite
reported one dependency deprecation warning. These checks support the inspected
contracts; they do not certify all graph semantics or the research conclusion.
No stack was restarted, and no source implementation was modified.
