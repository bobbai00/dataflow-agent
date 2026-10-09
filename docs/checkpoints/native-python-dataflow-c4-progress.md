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

# C4 progress: structured profiles and execution transport

Date: 2026-09-15. Branch: `feat/native-python-dataflow`.
Parent checkpoint: `fee4db22b` (C3); batching ancestor: `41cd8ae97`.
Implementation: `76243c008`. Separate baseline-fixture corrections: `d87fa3146`.

**This is an intermediate implementation checkpoint, not C4 completion.**
The collector, transport, decoder and settings are implemented and unit-tested.
The decoder is not yet connected to version-bound snapshot evidence. Full
input-result/source binding, live C4 execution, collection-overhead qualification,
and the C5 evidence selector remain required. No new profile/flow block is
rendered to the model. No real-LLM or benchmark benefit is claimed.

## Implemented interfaces

Collection is an agent execution setting, separate from exposure:

```json
{
  "agentMode": "native",
  "nativeToolMode": "batch",
  "nativeCatalogVersion": "v2",
  "nativeProfileCollection": true
}
```

`nativeProfileCollection` defaults to false and requires V2. Set it on a fresh
agent/workflow. Changing it with operators already present or a turn in flight
is rejected before any settings are mutated. The compiled native view records
the collection choice; batches cannot mix operators compiled with different
choices. This is not a model-authored argument in the `dataflow` tool schema.
The runtime attaches the request and its own operator ID/revision, type, input
IDs, row effect and operational counters to its output DataFrame metadata.

The worker activates collection only when that request is present. Multiple
yields accumulate; legacy statistics replacement cannot erase the profile.
Worker completion finalizes coverage before the final statistics query.
Import/collection/encoding failures affect optional metadata, not valid data.

The synchronous execution API has an opt-in `structuredResults` request flag.
The V2 agent requests it; V1 request bodies retain their previous shape.
The response separates:

- `columnStats`: the existing display strings, still display-truncated.
- `resultMetadata`: bounded, intact worker JSON envelopes, not cell-truncated.
- `metadataOmissions`, `numWorkers`: transport limitations and expected worker
  count, needed before asserting full output coverage.
- `resultSchema`: names, logical types and JSON encodings, including empty tables.
- `materialization`: output port, producing execution ID when known, whether
  cached, and a cached sub-DAG hash when available. This reuses the backend's
  existing cache-usage store; it does not parse a storage URI.

The response root includes the retrieval `executionId` and capabilities
`typed-scalar-v1` / `table-profile-v1`. The agent preserves the retrieval identity
as `executionContext`, separately from a cached result's producing execution.
Old cache entries without a producing ID remain unknown. Binding these fields
to the complete snapshot result version is the next implementation step.

V2 scalar JSON retains actual nulls, literal `"NULL"` strings, and booleans.
Int64 values outside JavaScript's safe integer range are decimal strings;
their schema encoding is `number-or-decimal-string`. Timestamps use UTC ISO
strings. Encoded integers/timestamps are not shortened by a text-cell budget.
Text truncation happens at the request's display boundary, not first at the
legacy converter's fixed 100-character cap. V1 conversion defaults are unchanged.
An older API lacking typed scalar support produces an explicit compatibility
error instead of silently feeding changed scalar semantics to a V2 agent.

## Profile calculations and limits

`core/util/table_profile.py` operates on actual output DataFrames, not rendered
samples. Its versioned `texera.table-profile` envelope contains typed schema,
total yielded rows, processed rows/cells, yield count, coverage, ordinary column
counts/distributions/ranges, structure, operational metadata, algorithm, cost
and omission reasons.

- Null/non-null counts are exact for the recorded processed prefix. Null ratio
  is nulls/processed rows; uniqueness is distinct nonnull/non-null rows. Empty
  denominators are undefined (`null`).
- Bounded exact dictionaries retain typed values and counts. Overflow abandons
  distinct/frequency claims; no sampled estimate is relabeled as exact. Top-k
  lists include other-count and truncation, separately from merge dictionaries.
- Numeric/date ranges use compatible values. Unsupported/non-finite values
  invalidate the range rather than leaving an apparently complete partial range.
- Int64 metadata values are decimal strings. Long strings are not truncated into
  false equality. Legitimate reserved-looking column names remain data keys.
- Duplicate rows are accumulated across a worker's yields while the bounded
  row dictionary fits. Whole-row lineage is not shipped. Cross-worker duplicates
  cannot be inferred by summing local duplicate counts and remain unavailable.
- All-null rows/columns are recorded when the observed columns support the
  claim. Column-budget omissions do not fabricate whole-row structure.

Default worker limits: 100,000 processed rows, 1,000,000 processed cells,
128 profiled columns, 256 distinct values per column, 4,096 distinct row keys,
8 top values, 192 characters per retained scalar string, 65,536 encoded bytes,
and a 200 ms soft collection budget checked at bounded row intervals. Object
schema probing examines at most 128 rows per selected column and respects the
remaining row allowance. Coverage/omissions distinguish these limits from full
collection. `collectionMs` measures the accumulation work; payload bytes are
the actual UTF-8 encoding size, not a rendered-token estimate. End-to-end
collector overhead still needs measurement.

The API accepts at most 64 worker envelopes / 262,144 envelope bytes per
operator, deterministically dropping whole envelopes with omission reasons.
It never repairs JSON by truncating its strings. The TypeScript decoder checks
protocol, shape, identities, unique workers/producers, safe counts, count and
dictionary consistency, schema, and payload limits. Cross-worker counts add;
distinct values union only when every bounded dictionary is available. Ranges
compare int64 values without conversion through a JS number. Missing workers,
unfinished yields, mismatched revisions, malformed envelopes and unknown
metrics cannot become exact full-table claims.

## Snapshot ownership regression

The old post-step callback wrote through mutable `this.head`. A request that
finished after checkout could overwrite another snapshot, including with an
older error or an older profile. It now captures the owning step and abort
signal, and rejects callbacks/synthetic errors after ownership is lost. Four
regression cases cover success, operator error, execution error and cancellation.
Stored result bodies are also cloned so mutation of a caller's response cannot
rewrite inherited history. This does not replace the remaining full result-
version binding or the C5 event-frozen evidence-selection work.

## Verification and baseline findings

- Bun: 1,008 passing tests, zero failures, 84 files, 10 snapshots; typecheck passes.
- Python V2 runtime: 77 pass.
- Full Python engine core: 965 pass, one pre-existing expected failure; one
  dependency deprecation warning.
- New profile/decoder tests execute the real Python collector and decode its
  envelope in TypeScript, including int64 above `2**53`.
- Scala non-integration-tagged project suite: 1,669 ScalaTest tests pass, zero
  failures, two pending; the sbt aggregate also reports three passing JUnit tests.
- **No live C4, real-model or KramaBench run yet.** C3's live DELTA/LATEST
  evidence does not establish correctness of this new API/profile path.

The first Scala build required the local stack's JDBC connection settings for
jOOQ generation. They were supplied privately; no shared DB schema was changed.
Two existing fixtures did not compile: an obsolete LogicalLink import and a
missing cache-service constructor argument. After those test-only corrections,
the broader run had seven failures. All seven were reproduced with the five
changed production files temporarily restored to committed C3; the exact C4
sources were then restored. No shared-backend checkout was modified.

Five failures were stale expectations: two JSONL int64 schema test cases,
the execution-store count, the registered websocket event set, and PVE install
error wording. Fixtures now assert the current contracts, without changing
those production components. Two upload tests tried binding the shared file
service's port 9092. For reruns the **test process only** points its upload
endpoint to a checked-free loopback port 39192, where its own stub server runs.
The real file service was not stopped or reconfigured.

Reproduce from the worktree root with the matching private JDBC settings loaded:

```bash
bun run --cwd agent-service typecheck
cd agent-service && bun test
```

From the root / `amber/` respectively:

```bash
.venv/bin/pytest -q agent-service/benchmark/tests/test_native_v2*.py
AMBER_TEST_FILTER=skip-integration \
FILE_SERVICE_UPLOAD_ONE_FILE_TO_DATASET_ENDPOINT=http://localhost:39192/api/dataset/did/upload \
sbt 'WorkflowExecutionService/test'
# From amber/:
PYTHONPATH=src/main/python ../.venv/bin/pytest -q src/test/python/core
```

Check that the test upload port is free first. The sbt command runs the project's
non-integration-tagged suite; it is not the full tagged integration campaign.
Temporary logs are `/tmp/native-python-dataflow-c4-*`, especially
`bun-final.log`, `typecheck-final.log`, `engine-final.log`, `python-runtime.log`,
`scala-unit.log`, `scala-baseline.log` and `scala-verified2.log` (the final run).
This document is the durable sanitized record; temporary logs may expire.

## Next required work

1. Finish version-bound profile persistence: producing/retrieval execution,
   workflow, operator revision, output port, input result versions, source
   fingerprints and safe cache reuse. Validate missing/stale/multi-worker paths.
2. Deploy the matching JVM API and worker code for live C4 DELTA/LATEST tests;
   preserve shared services and isolate workflows/registrations. Merely starting
   the agent against the unchanged shared API will yield the intended compatibility
   error, not deploy this change.
3. Measure collection/serialization overhead and finish C4 coverage/budget gates.
4. Implement C5 flow facts and joint evidence selection inside the existing
   observation budget, then C6 remaining operators/diagnostics and real-model
   qualification, and C7 KramaBench pilot/ablations with official scores,
   compile/execution pass rates and cache-aware cost.
