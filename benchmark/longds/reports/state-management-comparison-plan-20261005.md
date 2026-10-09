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

# LongDS state-management pilot: revised comparison

Date: 2026-10-05. Status: all 24 pilot probes completed; no larger campaign.

**Execution update:** the generated prefixes failed the reference-correct
fixture gate. They were frozen without gold-state injection or answer repairs,
and the probes were reported as natural-state recovery diagnostics. The
controlled versioning comparison described below was therefore not achieved.
See the [actual results and deviations](state-management-pilot-20261005.md).
The original plan below records the intended protocol; it does not override
that limitation. Two initial Python setup runs were invalidated for omitted
public historical contexts, and their costs remain included separately.

**Follow-up decisions, 2026-10-05:** keep the initial inventory to file paths.
Agents discover headers and sample data through their own actions. Both prompts
ask them to account for potentially relevant files even when names are unfamiliar.
Native profiles and `sample_stats` were already enabled in the completed pilot;
automatic flow injection remains off.

The task catalog now includes compact metadata for recorded outputs: shape,
up to three column types and null/distinct counts, and available numeric ranges.
Native scan summaries distinguish recorded file reads from declared source paths
and show measured file-selection omissions. These entries contain no sample rows,
use the saved output's identity, and label unavailable or partial statistics.
Python records comparable summaries when a table is written. More fields and
actual records remain available through inspection. This changes future contexts;
it does not revise the frozen pilot results.

Working-table improvements use generic prompt guidance: publish the complete
table from a custom calculation, connect its inputs, and put sorting/limits
downstream. Answer-source declarations remain prompt guidance; no new mandatory
tool check or automatic splitting of Python functions is introduced.

The proposed correctness check is evaluator-only: compare important saved tables
with the private reference by keys and requested columns, separating an incorrect
starting table from a retrieval error. It never supplies correct tables, answers
or reference code to the solver. No new paid prefix generation or retry campaign
has been started.

The [Lite-only search](lite-state-retrieval-candidates-20261005.json) reads exactly
the 24 v1.1 Lite conversations (777 turns). It finds 138 annotated rollback
questions. Shortlisted candidates are Netflix task3 Q29/Q31 and NFL task1 Q33.
Their questions combine earlier rules with current inputs or candidates; an
actual overwritten value must still be confirmed in solver traces. Ordinary
Python with a catalog remains the baseline and may freely retain copies.
The existing ordinary-Python checkpoint still retains the earlier narrow-market,
full-claim and entropy working tables at Q27 (`scan`, `full_scan`, `ent_scan`).
That keeps Netflix Q29/Q31 as mixed-rule candidates, not confirmed missing-state
cases. Check the actual starting checkpoint before treating either as a test of
automatic versioning.

Local verification of this revision: 1,390 Bun tests and 38 relevant Python tests
pass, as does TypeScript checking. A real persistent-kernel smoke verifies that
current-table summaries change after mutation while saved-copy summaries remain
unchanged, and that catalog entries contain no sample rows. No model calls were
used for these checks or the Lite search.

We will compare automatic versioned dataflow state with ordinary Python state
management on **LongDS v1.1 Lite**, using **Terra and Luna**, **no added input
token cap**, and **no automatic compaction**. The pilot is an illustration with
one attempt per question and condition; it cannot establish a benchmark-wide
accuracy advantage or statistical significance.

Here, “task” in the agent interface means a question/turn. A LongDS conversation
is one benchmark task containing many turns.

## 1. Python baseline and the context sent at each task

Each Python condition uses **one persistent kernel** for a session. Starting a
new task replaces the old model transcript with a catalog; it does not reset
variables, functions, imports, or files. Ordinary ReAct continues within the
current question. This is a modified DSGym-style baseline using structured
Python, script-inspection, and answer tools, not a stock DSGym reproduction.

Both agents receive the current question/context, input paths, common analytical
instructions, and an append-only prior-task index containing earlier questions,
their own answers, completion status, and artifact references. Old reasoning,
full code, and execution outputs are retrieved on demand rather than pasted
into each new question. Long answers are visibly clipped; task retrieval can
return the original. Stable message boundaries support caching on both sides.
Provider cache use is measured, not assumed.

| Catalog information | Python | Dataflow |
| --- | --- | --- |
| Computation artifacts | Executed script IDs, status, observed bindings written, declared answer variables | Answer-root operator IDs, saved versions, result availability |
| Historical retrieval | Exact executed scripts and optionally captured stdout/errors | Task-local answer computation, versioned earlier inputs, definitions and selected results |
| Current state inspection | Print live variables and inspect retained copies/files | Inspect current operators and results |
| Provenance | Runtime reads in agent scripts/helpers, conservatively attributed at script-block granularity | Operator/result/definition receipts and graph inputs |

“Bindings written” records an event, not a promise that a name still has that
value. Earlier answers and dependency hints are unverified evidence. Gold
answers, reference code, and benchmark dependency annotations remain evaluator-only.
The catalogs have equivalent purposes but different granularity; this pilot
compares frameworks and does not isolate provenance discovery from addressing.

Run two Python retention conditions:

- **Ordinary:** the agent freely chooses whether to overwrite, keep named copies,
  or save files. Existing copies are preserved. It is not forced to overwrite;
  our previous Netflix trace retained three-year and four-year versions.
- **Disciplined:** add generic guidance to retain independent historical copies
  under meaningful names, for example `score_t7 = score.copy(deep=True)`, before
  replacing or mutating a reusable value. These copies live in the same kernel.

Both conditions can manually preserve history, adapt/replay earlier scripts,
and inspect their own saved objects. Neither has automatic `score at task 7`
heap lookup. An overwritten value without a retained copy must be reconstructed;
old stdout provides only what was printed. Version names alone do not protect
aliases from mutation. Report retention/storage and bookkeeping alongside results.
The ordinary-versus-disciplined gap measures a retention strategy intervention;
it does not by itself prove the value of automatic dataflow versioning.

A generic catalog entry is:

```text
Task 3: answered
Question: Recalculate the report using revised eligibility.
Answer: <this agent's answer>
Scripts: t3_s1 [executed successfully]
Bindings written: eligible_rows, report
Answer sources: report
```

Python execution retains complete stdout for selected retrieval but bounds each
observation. Shapes, samples, and statistics are available through ordinary
Python calculations. Input parsing, null treatment, and table-observation
budgets are matched to the dataflow condition.

## 2. Dataflow capabilities and effects

The versioned unit is an **operator/output**, not every local Python variable.
Snapshots preserve definitions, wiring, provenance, and available bounded result
observations; full engine materializations are managed separately.

| Capability | Current semantics | Expected benefit |
| --- | --- | --- |
| Inspect task | Read the local answer sub-DAG; unchanged previous computations appear as versioned boundary inputs | Locate relevant work without dumping the session graph; expand only needed inputs |
| Inspect state | Select an exact task/operator version, definition, immediate inputs, and retained observation; or list versions | Check earlier rules and values after overwrite/deletion; inspection does not execute |
| Restore rule | `update operator score from task 3` restores its old definition on today's inputs/edges | Return to an earlier rule while retaining later data changes; affected outputs require execution |
| Fork branch | `fork operator score from task 3 as score_old` copies its complete historical upstream closure | Compare or repair an old computation without mutating the current branch |

A fork names the root `score_old` and upstream copies
`score_old__<original_id>`. It remaps historical edges, copies shared ancestors
once, excludes unrelated/downstream branches, and rejects collisions atomically.
Task retrieval can display five new operators plus one historical boundary input;
forking that root can still copy a larger closure. Display size and execution
size are measured separately.

Restore is selective rule rollback, not whole-session checkout. Recreating a
deleted operator can reconnect historical input IDs that still exist; missing
parents require repair. Fork preserves the old upstream computation, whereas
restoring an existing definition uses the current inputs. Mixed-state questions
may require an old component combined with selected current components.

Saved state is not necessarily correct. The generic system prompt instructs the
agent to check input coverage, filters, date windows, grouping, units, and scope;
reuse a complete working table rather than a limited report; repair a faulty
step; execute and verify affected outputs; and preserve a main branch during
counterfactual analysis. Examples remain generic and contain no benchmark tasks.

**Current limitation:** fork clones definitions and wiring and can immediately
read compatible saved observations. It does not bind new downstream execution
directly to an old full materialization. Fresh IDs have different cache identities;
executing the copied branch may recompute its ancestors. Record actual execution
and cache evidence rather than claiming computation-free rollback. Historical
replay also depends on frozen inputs and deterministic code. A graph snapshot
is not an external-file byte snapshot.

The agent remains ordinary ReAct, with `stateLedger: false`, automatic flow
injection off, and the existing inspect/edit/execute/retrieve/answer actions.

## 3. Pilot and evaluation plan

### Questions and checkpoints

Use only `business/netflix_movies_and_tv_shows/task3`, a 36-turn v1.1 Lite
conversation. Predeclare four probes:

| Probe | Annotated dependencies | Maximum span | Start from | Purpose |
| --- | --- | ---: | --- | --- |
| Q8 | 4, 7 | 4 | after Q7 | Simple temporary full-claim comparison retaining category entropy |
| Q14 | 12, 13 | 2 | after Q13 | Simple selective maturity rollback using current candidates |
| Q24 | 21, 23 | 3 | after Q23 | Remove director penalty while retaining niche and other current treatments |
| Q28 | 7, 26, 27 | 21 | after Q27 | Compose the old entropy score with the current market screen and shortlist |

Q8 and Q14 are controls. Q24 tests selective composition and Q28 is the
long-range case. Q6 remains only a functional smoke test. Q29/Q31/Q34/Q35 are
reserved for a later reviewed expansion. The original paper's Figure 2 showcases
Q24 but names a different old anchor; the pinned v1.1 specification governs here.

“One prefix to Q27” means one trajectory with four checkpoints. Each probe
receives only its preceding checkpoint/history. Q8 never receives the Q27 heap,
future scripts, answers, or dependencies. Identical final leader sets under
different rules do not alone demonstrate correct historical selection.

### Generate and freeze realistic prefixes

Generate one prefix through Q27 per condition using Terra. Keep natural script
names and operator granularity, then reuse the same verified fixtures for **both
Terra and Luna continuations**. This avoids duplicate Luna prefix generation;
it measures both models on fixed Terra-generated histories, not Luna's natural
full-session performance. Up to 81 prefix-generation turns precede **24 probe
turns**: four questions × three conditions × two models.

Use one predeclared prefix run per condition. Keep original traces, answers,
costs, and failures. If repairs are needed, record a separate repair log and
repaired fixture; do not select a best-of-many perfect trajectory. Benchmark
reference code stays private. Correct final answers are necessary but do not
prove that all intermediate state is correct: verify the reusable tables and
rule settings required at the checkpoints. Unavailable semantic anchors remain
explicitly unknown. A fixture is labeled verified only after its checks pass.

Replay the recorded agent-authored scripts/actions to initialize each probe;
this replay makes no model calls and excludes all future steps. Report replay
CPU/time separately. Prefix preparation and repair spending is charged once,
reported separately, and included in amortized cost calculations. Prefixes are
substantial work and spending, not free setup. Review total spending between
turns and stop on unknown usage; do not expand or search for more successful runs.

### Shared settings and free verification

Pin model identifiers/reasoning settings, source revisions, tool definitions,
Python/pandas/NumPy versions, raw input hashes, observation budgets, answer
contract, retries, and timeouts. Both models use medium reasoning, up to 40 calls
per turn and 8,192 output tokens per call. The added input budget is zero and
compaction is off; the provider's actual context window still applies.

Before paid probes, verify historical inspection, overwrite/deletion, fork
closure/names, branch isolation, restore on current inputs, stale-result
invalidation, missing observations, atomic collisions, Python alias mutation,
manual copy survival, bounded outputs, and historical script retrieval. Use a
real-engine fixture to observe actual cache/execution behavior. A checkpoint
smoke must prove that future task entries are excluded.

Use the pinned published raw-file inventory rather than walking shared data
folders, which can contain earlier generated outputs. Verify reference replay
privately against all published answers. Observer exports stay outside the
kernel mount; temporary exports are removed immediately after capture so the
scorer cannot accidentally supply automatic historical snapshots to Python.

### General scorer and reported measurements

Build reusable value/table comparison, version comparison, update classification,
and dependency-set agreement. Semantic-anchor adapters identify corresponding
analytical objects; do not assume arbitrary agent variable/operator names align
or compare entire heaps. Specify keys, required columns, tolerance, ordering,
null handling, and coverage before interpreting scores. Validate the machinery
on Netflix first, without claiming automatic coverage of all 777 turns.

| Measurement | Evidence and interpretation |
| --- | --- |
| State match | Actual intermediate values/rules versus private reference anchors; distinguish matched, incorrect, and unknown |
| Update propagation | After a rule change, affected state matches current, matches obsolete previous state, is otherwise wrong, or cannot be checked |
| Historical recovery | Correct old rule/value obtained by observation, retained Python object/file, or recomputation; record wrong-version choices |
| Branch preservation | Main-branch definitions/values remain intact after a temporary scenario |
| Dependency agreement | Task-level precision/recall against annotations at the same closure depth, with consultations separate and unresolved-reference coverage |
| Recovery/retrieval effort | Requests, regenerated code, edits, executions, repeated inspections, and returned characters/tokens |
| Actual reuse | Separate reuse of code/definitions, saved observations, and engine full-result materializations; cache hits and execution evidence |
| Answer quality | Pinned upstream binary judge plus separately labeled deterministic field/table partial credit |
| Resources and coverage | Cache-aware model cost, prefix/repair/judge/replay cost separately, latency, tokens, retained state size, completed/missing/error turns |

Compute update and stale-state measurements on the **original unpatched prefix
traces**; they already contain natural updates and inheritance. Repaired prefixes
then isolate selection/recovery during the probes. The natural 36-turn follow-up
can expand these measurements after pilot review.

Dependency agreement is not ground truth for a unique valid algorithm. Correct
recomputation may use different dependencies. Runtime Python reads are recorded
at script-block granularity, and dataflow is operator-level; external effects
or uninstrumented accesses remain unknown. Equal table values cannot uniquely
identify a version. Report consultations, data reads, definition reuse, and
compute lineage separately; do not count exploratory inspection as answer use.

Use the same pinned DeepSeek binary judge configuration for both models and all
conditions. Preserve original verdicts and flag independently verified judge
anomalies separately. Additional state and partial metrics are diagnostics, not
new official LongDS metrics. Include spending on failures; compare aligned
questions and both-correct pairs so skipped work cannot appear as savings.

Classify wrong version, incomplete retrieval, stale rule after update, unintended
branch mutation, wrong old/current composition, semantic/input error, and
infrastructure/provider failure. Link cascades to their earlier root error and
count root errors separately from affected descendants. Unknown causes stay
unknown; no new agent ledger or semantic-check tool is introduced.

### Review before expansion

Report all 24 planned probe cells, preparation/repair outcomes, coverage gaps,
and the first meaningful trace divergence. One attempt per cell is an
illustration, not a reliable estimate of expected performance. No significance
claim, full Lite score, automatic retry campaign, or scale-up follows this pilot.

If the pilot is useful, review one natural 36-turn conversation per condition
and a later native-history-off control to isolate version primitives. Those
runs and broader Lite evaluation require a separate scope decision.

### Sources and implementation

DataMind source pin: `a814927159470ad1624602d233f57b7c0be5882e`.
Dataset pin: `6b448459c333ecc050a2e89fcc65c0e044d763ac`. v1.1 Lite contains
24 complete conversations/777 turns; this pilot uses four checkpoint probes.
Historical inspect/fork/restore and native dependency context already exist.
The pilot adds explicit version/split preparation, isolated Python catalog
instrumentation/retrieval, checkpoint replay, and reusable state diagnostics.
Their verification/results are reported separately; this plan does not assert
that the paid pilot has completed.

Sources: [upstream README](https://github.com/zjunlp/DataMind/blob/a814927159470ad1624602d233f57b7c0be5882e/longds/README.md),
[Netflix questions](https://huggingface.co/datasets/zjunlp/LongDS/blob/6b448459c333ecc050a2e89fcc65c0e044d763ac/task/longds_v1.1/business/netflix_movies_and_tv_shows/task3/task.json),
[Netflix metadata](https://huggingface.co/datasets/zjunlp/LongDS/blob/6b448459c333ecc050a2e89fcc65c0e044d763ac/task/longds_v1.1/business/netflix_movies_and_tv_shows/task3/metadata.json),
[previous Terra audit](terra-pilot-accuracy-audit-20261005.md),
[task-context implementation](../../../docs/observation-format/task-dependency-context.md),
and [fork implementation](../../../agent-service/src/agent/state-history.ts).
