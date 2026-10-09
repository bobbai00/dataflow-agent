<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# C4: result versions, live profiles and overhead

Date: 2026-09-15. Branch: `feat/native-python-dataflow`.
Implementation: `97de1e243`; previous transport implementation: `76243c008`.
Batching ancestor remains `41cd8ae97`.

Version-bound persistence is implemented and unit-tested. The core live profile
matrix passed: DELTA/LATEST, collection on/off, three debug steps per case.
The subsequent historical-cache repair extension is unit-tested but **still
awaits its expanded live rerun**. That rerun was prevented by the idle guard
when another workload started using the shared compute master. Do not count
the extended five-step fixture or the proposed C3-core rerun as passed.

This is not completion of the full plan. C5 evidence extraction/selection,
C6 remaining operators and expanded diagnostics/real-model qualification, and
C7 KramaBench evaluation remain outstanding. No new profile block is rendered
to the model yet; there are no real-LLM or benchmark-score/cost results here.

## Result and profile contract

Every accepted V2 result receives `resultVersion` with:

- `version:1`, a canonical SHA-256 `id`, workflow/operator IDs, semantic
  operator revision, output port and actual producing execution ID.
- `definitionHash`: the submitted engine operator, including generated Python.
  `subgraphHash`: that definition and its incoming dependency graph. Layout,
  display names, object-key order and `observe` selection do not change it.
- Ordered `inputs:[{inputIndex,operatorId,outputPort,resultVersion}]`. A
  self-join retains two logical roles even with one distinct physical input.
- Direct `sourceFingerprints:[{path,sizeBytes,mtimeNs}]` when measured by Scan;
  otherwise null. Ancestor identities are retained through the input-version
  references. A cached fingerprint is not a fresh filesystem check.
- `complete` and `omissions`. Complete **binding** is distinct from complete
  profile **coverage**; an exact result identity can carry a partial profile.

The retrieval execution remains separately in `executionContext`. A cached
observe performs no execution and does not mint another producing version.
An actual backend cache hit can reuse a profile only with the same workflow,
operator revision, compiled definition/subgraph, port, producer and input
versions. A failed revision can be repaired from a matching pinned historical
proof, not by attaching whichever older profile happens to be present.
History lookup uses retained snapshots; clearing/pruning removes those proofs.

`tableProfile.resultVersion` pins the decoded profile to that identity. The
agent verifies profile row count/schema against the result transport and native
operator type/input IDs against the snapshot's declared contract. Empty or
all-null object columns may refine an `unknown` profile type from the actual
materialized schema, without inventing values or statistics. Other type/schema
conflicts remain unavailable. Optional profile failure does not invalidate data.

V2 workflow definitions and stored results are deeply frozen. Request hashes
are memoized only for immutable snapshots, avoiding repeated hashing of the
embedded Python runtime for every operator in a batch. Incoming result records
are persisted input-first regardless of JSON property order; this does not
change the shared tool-call scheduler. Wrong-workflow/definition and delayed
results are rejected. New input materializations invalidate dependent current
data/profiles even without a code edit; historical snapshots are unchanged.
If a fresh input's table was not retrieved, its older visible table is removed
and dependent profile binding stays unavailable rather than borrowing old data.

The snapshot/dashboard API now preserves decoded profiles, result versions,
typed schemas and producing/retrieval identities. It does not duplicate raw
worker envelopes. Empty tables keep their column count. This wire view is not
the model-facing successful-result observation policy.

## Live findings and fixes

The first live attempt failed during fixture setup: the client defaulted to
the wrong computing-unit API. This stack uses `http://localhost:8888`, set via
`TEXERA_COMPUTING_UNIT_ENDPOINT`. No workflow ran in that attempt.

Two subsequent live failures identified real gaps:

1. Empty pandas object columns were profiled as `unknown` while the storage
   schema identified their logical type. The agent now reconciles only this
   no-observed-nonnull-value case with the authoritative stored schema.
2. Revising a consumer without re-requesting its unchanged upstream table
   omitted that input's execution origin. The API now advertises
   `input-materialization-v1` and returns `inputMaterializations`, independently
   of requested table bodies. Completed fresh operators use the current
   execution; cached operators retain the cache-usage store's original producer.
   Unknown cache origins and unfinished operators never receive a fabricated
   fresh execution ID. No extra table fetch or hidden execution is introduced.

Both have failing-then-passing regressions. The resulting core matrix passed:

| Context | Collection | Workflow | Debug steps | First execution wall time |
| --- | --- | --- | --- | --- |
| DELTA | On | 4135 | 3 | 10.065 s |
| DELTA | Off | 4136 | 3 | 8.893 s |
| LATEST | On | 4138 | 3 | 8.823 s |
| LATEST | Off | 4139 | 3 | 8.798 s |

Each case checks a reversed Scan/Filter/Aggregate chain, a UDF containing true
nulls versus literal `"NULL"`, nullable boolean and int64 above `2**53`, an empty
schemaful result, hidden successes, cached observe without execution, and an
upstream revision plus a new consumer on the existing DAG. Collection on/off
produced identical data. Profiles and source/input versions were checked through
actual service snapshots. All four cases cleaned their own agents/workflows/CU
registrations. These wall times are plumbing observations, not a controlled
performance comparison or a model-token-cost claim.

The live collector took 0.250–0.911 ms per tiny result and transported
1,317–2,068 profile bytes per operator. After this passing run, the fixture was
extended to fetch historical snapshots again and inject/repair a hidden runtime
error. That additional execution coverage is pending, as noted above.

## Bounded collection measurement

A local three-repeat microbenchmark constructed integer DataFrames with
`np.arange(N) % 37` per column, then timed accumulator construction, add, finish,
snapshot and encode. DataFrame construction and Python startup were excluded.
Default collector limits were unchanged. Every payload stayed below 65,536
bytes and every run respected row/cell count limits.

| Input shape | Total time range | Rows profiled | Profile coverage / omissions |
| --- | --- | --- | --- |
| 0 × 3 | 0.232–0.443 ms | 0 | Full, empty schema retained |
| 100 × 3 | 1.398–1.490 ms | 100 | Full |
| 10,000 × 12 | 201.446–202.308 ms | 6,528–6,912 | Partial; time budget |
| 100,000 × 12 | 201.489–204.518 ms | 6,912–7,040 | Partial; time/cell budget |
| 1,000 × 512 | 231.867–242.735 ms | 768 | Partial; 128-column cap, time/payload budget |

The 200 ms collection budget is explicitly **soft**, checked at row intervals;
serialization adds work after it. Large/wide inputs do not get full-table column
claims merely because execution completed. This limitation must inform C5's
selection and the eventual benefit/overhead evaluation. These measurements do
not justify a cost/accuracy improvement claim.

## Verification and deployment state

- Final Bun suite: 1,027 pass, zero failures, 86 files, 10 snapshots; typecheck
  passes. Includes 17 version-binding tests and two summary-wire tests.
- Scala non-integration-tagged suite: 1,670 ScalaTest tests pass, zero failures,
  two pending, plus three passing JUnit tests (aggregate 1,673). The dedicated
  structured-transport suite and `WorkflowExecutionService/dist` also pass.
- Python production code is unchanged from the previous C4 checkpoint; its
  recorded 965 engine / 77 native-runtime test results are not relabeled as
  reruns here. The actual worker collector ran in the live matrix and the
  measurement above. Earlier multi-yield/partition decoder regressions remain
  in the passing suites; the live V2 fixtures use one worker per operator.
- No original shared-worktree source files were modified. The candidate JVM
  distribution and Python code were used only for the live compute-master swap.
  Web, compiler, proxy, storage and CU-management services were not restarted.
  The original `op-granularity/amber` compute master was restored and verified
  listening after the test runner exited; candidate agent port 3011 was stopped.

The execution runner cleans up descendant processes when it exits, including
plain-nohup launcher children. Restoration therefore uses the supported launcher
under the transient user unit `texera-native-python-c4-restored.service` with
`RemainAfterExit=yes`. It has no automatic restart policy. Its launcher state
and logs are `/tmp/texera-native-python-c4-engine-test`. The original deployment
was subsequently observed serving another workload, so further restarts were
paused pending coordination. Do not interrupt that workload for a rerun.

Temporary artifacts: `/tmp/native-python-dataflow-c4-live4.log` (passing core
matrix), `-live2.log` / `-live3.log` (the two reproduced live defects),
`-profile-overhead.json`, `-version-bun-verified.log`,
`-version-typecheck-final.log`, and `-version-scala-final.log`.
`-live-final.log` is the **prevented** expanded attempt, not a passing run.
All names share the `/tmp/native-python-dataflow-c4` prefix. This document is
the durable sanitized record; temporary artifacts may expire.

Next: use an agreed idle window for the expanded profile/error-repair and C3
core reruns against the matching candidate engine/API, then complete C5 joint
flow/data evidence selection within the existing explicit-observation budget.
The full operator/real-model/benchmark requirements remain in the main plan.
