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

# C8: targeted evidence improvements and full-workload protocol

**Superseded on 2026-09-16:** the user removed `inspectResult` from every
configuration. The partially completed campaign below is exploratory only;
its sources, traces, scores and costs are retained unchanged. No recovery or
supplemental first attempts will run under its labels. See
[C9: observe-only correction](native-python-dataflow-c9-observe-only.md).

2026-09-15. Implementation checkpoint, **not a benchmark result**. The user
authorized implementation and all 104 KramaBench tasks after reviewing C7.
The 14 one-task pilot attempts and their report remain unchanged.

## Changes from the measured pilot

No new engine statistics, SQL operators, model-authored profiling tool, or
benchmark-specific key rules are added. The V2 operator API remains the one
documented in [the implementation plan](../native-python-dataflow-plan.md).

1. **Relevance and one shared budget.** Declared downstream dependencies can
   cross projections/renames, derives, aggregates, joins and other supported
   contracts. Python bodies are never parsed; UDF mapping is opaque. The walk
   is bounded to eight hops and 64 examined edges after indexing the event DAG.
   One representative stored sample remains high priority. Compact per-column
   null/nonnull/distinct counts precede extra samples and detailed ranges/value
   lists. Useful declared columns rank first; without a future plan, compact
   counts cover columns deterministically rather than inventing task relevance.
   Schema, samples, version labels and evidence still share **2,000 characters
   per observed operator**, not independent budgets. Whole-table visibility still
   suppresses redundant column profiles. No schema or small-table guarantee
   is weakened to make evidence appear.
2. **Bounded upstream calculation summaries.** An observed descendant may
   include at most three relevant upstream calculation summaries, searching up
   to eight hops/32 operators. These expose declared grouping/join/filter keys
   and validated existing row-effect/denominator measurements, never unrequested
   input rows or a dump of column profiles. Every traversed edge requires the
   exact stored result version, workflow, port and current operator revision.
   UDFs stop traversal, including when the observed root is a UDF. A summary is
   calculation context, not proof that the user intended that grain or population.
   Flow-off disables this exposure. DELTA freezes the selected summary in its
   original event; later edits cannot add new facts to historical observations.
3. **Observation guidance.** The common V2 prompt teaches the model to observe
   parsed data at uncertain column/key/null decisions, batch known chains, reuse
   cached observations, and check what the final count actually counts. It
   distinguishes row counts, group counts and nonnull counts. No task answers
   or task-specific entities are present. All three V2 evidence arms use this
   same prompt; the historical batching baseline is untouched.
4. **Repeated validation repair.** Per-agent, task-local tracking covers
   deterministic schema and Python preflight failures. After two failures of
   the same pattern, the receipt supplies a compact, schema-derived example.
   An identical already-invalid submission is paused until current-diagnostic
   inspection or corrected arguments. Changed submissions and independent valid
   edits remain eligible. Successful correction, operator deletion, checkout,
   and new task reset the corresponding state. Historical diagnostics cannot
   acknowledge a current failure. Callback source remains behind revision-pinned
   `inspectError`; ordinary receipts retain bounded identity/coordinates/hints.
   Runtime, graph and infrastructure errors are deliberately not gated by this
   deterministic-validation policy.

## Testing and freeze

Regression tests precede each change. Cases include shared budget competition,
multi-hop rename/derive relevance, join suffix/coalesced-key ambiguity, wide
fan-out, stale input versions, direct/ancestor UDF boundaries, hidden-row
canaries, and DELTA/LATEST invalidation with immutable historical frames.
Repair tests cover exact repeat gating, valid independent work, schema example
validity, current versus historical inspection and agent/task reset boundaries.

The pre-dispatch gates passed on candidate source
`791c535113b564f5c89914459276e9cd1160b6e9`:

- Complete Bun suite: **1,149 tests passed**, followed by successful typecheck.
- Matching-engine worker E2E: **20 cases across six suites**, covering both
  DELTA and LATEST, richer operators, evidence, profiles, shapes and diagnostics.
- Real **Terra-medium** smoke: dependent batches, cached observation, execution
  failure and repair passed in both DELTA and LATEST (four turns per layout).

Local gate index:
`/tmp/native-c8-campaign.HILOqM/qualification/qualified.json`.
The campaign manifest freezes source/harness SHAs, live service/process
identities, gateway routes, task/input bindings, settings and gate artifacts.
The unchanged candidate engine was already loaded; no master restart was
performed for these agent-only changes.

## Registered comparison

All **104 canonical tasks**, six workloads, through the built-in KramaBench
runner and official evaluator. Exactly four arms per model:

| Arm | Source and tools | Data evidence | Flow evidence |
| --- | --- | --- | --- |
| BatchParent / no stats | Actual V1 batching parent `41cd8ae97e30edfec90c847886ed4068dd0fa9b0` on :3012 | Off | No V2 evidence |
| DataOnly | Frozen V2 on :3011 | On | Off |
| FlowOnly | Same V2 | Off | On |
| Combined | Same V2 | On | On |

Models are exact `gpt-5.6-luna` and `gpt-5.6-terra`, both **medium** reasoning,
verified against the live gateway. Thus 832 first-pass task admissions, not
104 total admissions across all arms. Shared Texera backend, isolated fresh
workflows/agents, and explicit campaign CU registration. No engine restart is
needed for these agent-only changes. DELTA, 25 steps, native batching, explicit
observe, 2,000-character result budget and other pilot settings remain fixed.
V1's old L1/L1 schema/source structure is not V2 data/flow evidence; legacy
column statistics remain off everywhere. V2 profile collection is on for all
three V2 arms, independently of exposure. Provider parallel tool calls are off.

This is an **end-to-end system comparison**, not a pure evidence-only ablation
against V1: V2 also changes the operator catalog, common prompt and repair.
DataOnly/FlowOnly/Combined compare exposure within that same V2 implementation.
There is no fifth V2Control arm in this user-requested campaign, so marginal
evidence benefit versus an otherwise-identical V2 no-evidence system cannot be
isolated by these four arms alone.

**Interpretation clarification found during the trace audit:** the data/flow
settings above control automatic evidence in observed dataflow results, not
all possible tool access. The common V2 `inspectResult(stats: true)` tool can
explicitly retrieve collected data profiles even in FlowOnly; its existing
implementation and tests deliberately allow this. Two early FlowOnly traces
used that path. Thus the current campaign compares automatic-exposure policies
with a common pull tool, **not a strict prohibition on data-statistics access**.
Count these explicit requests and their actual later-input exposure separately.
Do not describe FlowOnly as never seeing data evidence, or silently change this
capability in the middle of an arm. A strict capability ablation requires new
configuration/run labels and consistently gated tools.
The historical V1 batching baseline also permits explicitly requested legacy
column statistics: one early Luna baseline trace requested and received them.
Accordingly, its "no stats" shorthand means **no automatic statistics**, not
absence of an on-demand statistics capability. This is a limitation of the
initial arm labels, not an unrecorded implementation change.

## Data and result integrity

Keep the native harness's oracle-file-subset policy fixed. A read-only audit
found 99/104 tasks with complete resolved references before restoration. An
exact local 2016–2022 weather file is restored by link (SHA-256
`442e0782494c4eb746b669bebc9511be21bf4f7aa96d029deae3e3526703a4cb`).
Document the query-supported `omni2.txt` → `omni2.text` spelling correction
and SP3 timestamp wildcard-width correction identically in every arm's frozen
input bindings; original workload JSON and questions are unchanged. These
corrections yield 103/104 input-ready tasks. `astronomy-hard-7` has six unresolved
dated references plus inconsistent question intervals; do not silently replace
them with differently dated files. Retain that task in the 104 denominator
and report its input-readiness failure separately from model accuracy.

Preserve first attempts and two common failed-task recovery rounds in distinct
artifact locations. Disable hidden empty-turn retries. Official answer-type
metrics at threshold >=0.9 determine success, not max of unrelated metrics.
Report first-pass and recovery-assisted accuracy separately, with first-pass
and cumulative cache-aware token cost. Unknown/partial usage is not zero cost;
record completeness and reason. Record any long-context pricing qualification.
Scoring costs, model-smoke costs and experiment task costs remain separate.

Retain actual model inputs, tools, snapshots, answer, settings, official score,
token/cache usage and resource journals. Only delete task-owned agents/workflows
after capture and terminal-state verification; never terminate the shared CU
from per-task cleanup. Full campaign runs may use the backend directly, so do
not claim recorder-derived backend-request metrics from these attempts.

Post-run diagnosis should stratify tasks/domains, parse/schema/repair errors,
wrong population/grain, missing-data failures, step/timeout limits, redundant
observations and missing useful evidence in **later actual model inputs**.
No improvement claim is made until the new full-workload results exist.

## Run checkpoint and administrative amendment

The eight native full-workload drivers were launched on 2026-09-15, with at
most eight task processes in total. Local supervisor/artifact index:
`/tmp/native-c8-campaign.HILOqM/`. Native task artifacts are under
`benchmark/Kramabench/system_scratch/DataflowSystem{Luna|Terra}NativeCampaign{BatchParent|DataOnly|FlowOnly|Combined}20260915Rep1/`.

After **102 completed model attempts**, an over-strict harness provenance
guard rejected admissions because official scoring legitimately writes
`benchmark/fixtures/paraphrase_cache.json`. No frozen agent, engine, setting,
task or input-file change was found. Harness commit
`be3371f3b7781d75eb475b756e914622c4904008` excludes only that exact mutable
cache from the source-dirty check. All other benchmark files remain guarded;
**21 harness regression tests passed**. The original manifest, cache diff,
rehash verification and amendment audit are preserved under `amendment-1/`.

All 102 dispatched attempts, answers, costs and original qualification fields
are retained. Six completed attempts have a failed postflight check; the
cache-only explanation is an audited inference, not a rewritten historical
qualification. **87 zero-model-dispatch preflight rejections** were moved
recoverably to each SUT's `_preflight_rejections/<task>/cache-guard-before-first-model/`,
with file hashes and exact move mappings. They are administrative admissions,
not hidden model retries. The remaining **730 first-pass tasks** resumed via
native `kb tasks`; completed tasks were not replaced. Both common recovery
rounds remain scheduled after first-pass completion.

Some completed tasks retain pending cleanup because old superseded execution
records still say RUNNING despite the current agent being idle and the latest
execution being completed. Their ownership journals are retained; no forced
deletion, status edit or shared-master restart is used to conceal this. The
final report must count pending cleanup separately from answer completion.

A second administrative issue was detected when the first native drivers
finished: the shared dataset loader reads both a domain's canonical workload
and its `-tiny` fixture. `legal-tiny.json` overwrites `legal-hard-1` metadata,
so strict campaign validation rejects the canonical task before reserving an
attempt or allocating an agent. The native driver still returns exit zero
after reporting a failed child; exit status alone is therefore not a coverage
check. All canonical slots must be checked against the original 104-task list.

The campaign coordinator is temporarily stopped at the first-pass barrier;
its native child drivers continue unchanged. A campaign-only canonical loader
fix is tested in a separate workspace (`0132f4898f80bc7656facdc799fc9d4ea9f9b8d1`,
69 harness tests). Applying it is deferred until those children and model
attempts finish. The planned second amendment preserves all existing attempts,
logs and the old manifest, rehashes frozen bindings, and allows only the
never-dispatched missing task as a supplemental **first** attempt in each arm.
Questions, oracle-file policy, format hints, agent/engine source and model
settings remain unchanged. The two recovery rounds must not begin until that
canonical first-pass coverage check succeeds.

## Interim diagnostic notes, not post-hoc changes

Audits are saved under the local campaign index's `audits/` directory. The
154-completed-run usage audit checks actual later model inputs, not just tool
receipts. It identifies explicit statistics retrieval in automatic-data-off
arms and substantial use of opaque source UDFs; these limit how broadly one
can attribute outcomes to the new automatic flow summaries.

Matched trace comparisons identify raw-preview wrapper statistics competing
with useful source lines, a large cell suppressing other values in the same
row, callback/operator-contract repair costs, and task questions that omit
reference-only calculation choices. Keep those distinct from one another and
from infrastructure failures. Official scores and input questions are not
rewritten to resolve these issues.

The `environment-easy-2` performance audit identifies repeated four-to-five
minute execution timeouts on large intermediate-table paths. A reducing source
UDF returns a small result quickly, whereas an input-consuming UDF still pays
the materialization cost. The result-rendering character budget does not bound
worker or collector work. Attribution among computation, serialization,
transport, collection and scheduling requires separate measurements; an
end-to-end step interval alone cannot identify the dominant component. These
are next-experiment hypotheses, not changes to the frozen campaign.
