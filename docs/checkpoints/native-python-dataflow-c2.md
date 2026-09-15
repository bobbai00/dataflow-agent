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

# C2 checkpoint: Python contracts and actionable errors

Date: 2026-09-14 (America/Los_Angeles).

- Branch/worktree: `feat/native-python-dataflow`,
  `.claude/worktrees/native-python-dataflow`.
- Batching parent: `feat/native-batch-observe`, `41cd8ae97`.
- Implementation: `1ffc49cf8`.
- Separate bootstrap-test isolation fix: `bac37e3ed`.
- [Full plan and remaining checkpoints](../native-python-dataflow-plan.md).

This is the Python callback/error **foundation**, not completion of the full
catalog, data/flow optimization, real-model qualification, or evaluation.

## Delivered surface

Create a fresh native batch agent with:

```json
{
  "agentMode": "native",
  "nativeToolMode": "batch",
  "nativeCatalogVersion": "v2"
}
```

The service still defaults to V1. Existing V1 prompts and SQL semantics are
unchanged. V2 schemas do not expose Compute or SQL predicates/expressions.
Version selection is propagated through REST creation, GET/PATCH settings,
prompt construction, batch schemas, compilation, and `nativeOp` snapshots.
Version changes on a populated incompatible graph or during an active turn
are rejected, not silently migrated. Batch edits also reject mixed catalogs.

Only these execution-tested V2 operators are currently exposed:

| Tool `op` | Required operator parameters, besides `id` and input reference | Contract |
| --- | --- | --- |
| `project` | At least one of `keep`, `drop`, `rename` | Select then rename; keep/drop mutually exclusive; row-preserving |
| `cast` | `columns: [{column, dtype, format?, timezone?}]` | Explicit conversion; `errors: "raise"` by default, optional `"null"` |
| `fill_null` | `values: {column: scalar}` | Compatible replacement of missing cells only |
| `transform` | `columns: [{column, dtype, func}]` | `apply(value)` replaces existing column values, preserving rows/order |
| `derive` | `columns: [{as, inputs, dtype, func}]` | `apply(row)` adds typed scalar columns; optional `replace` |
| `filter` | `columns`, `func` | `apply(row)` returns bool/None; `nulls` drop/keep/error |
| `udf` | `code` | `load()` source or `process(input_id, ...)`; one DataFrame; semantic effect unknown |

Unary operators use `input`; UDF uses ordered optional `inputs`. Dtypes are
`str`, `int64`, `float64`, `bool`, `datetime`. Full argument semantics and
examples remain in sections 3–4 of the plan and the versioned catalog/schema.
The seven-operator subset is a checkpoint boundary, not a reduced final scope.

Python syntax/signature validation happens asynchronously in the worker Python
environment, before workflow mutation, with a 10-second deadline. It parses and
compiles source without executing submitted imports or callbacks. Execution
uses a self-contained runtime embedded in DataLoading/DataProcessing code; no
new Amber package deployment is assumed. Callback contracts are **not a Python
security sandbox**: actual user code runs in the existing worker environment.

Transform/Derive enforce scalar return types, nullable output dtypes, declared
input columns, original-input evaluation, and stable row order even when input
indexes are duplicated. Row callbacks receive a fresh read-only mapping; null
scalars arrive as `None`. Bad local dictionary accesses are distinguished from
undeclared input-column accesses. Filter does not accept truthy strings/numbers.
Cast does not silently strip separators or turn nonintegral values into ints;
naive datetimes require an explicit timezone. UDF return frames are checked for
unique string column names and compatible scalar values before transport.

## Batching, visibility and error behavior

The existing shared scheduler remains the only batch scheduler. Forward
references and revisions through unchanged existing descendants are preserved.
The V2 system prompt includes five concrete batch/observe examples, including
dependent columns represented by separate operators in one batch and an
upstream revision with a new consumer of an existing downstream chain.
Examples are schema-validated and compiled against the same evolving test DAG.

Successful content requires explicit `observe`, including the answer. Empty
operator batches read cached results without execution. A changed upstream
recomputes descendants even when shape and row count stay the same. Receipts
report that change without revealing unrequested successful values.

The foundation diagnostic payload currently has this shape:

```json
{
  "version": 1,
  "operatorId": "derived",
  "operatorRevision": "<16-hex definition revision>",
  "code": "CALLBACK_RUNTIME",
  "stage": "execute",
  "message": "ZeroDivisionError: division by zero",
  "field": "columns[0].func",
  "source": {
    "entry": "apply",
    "line": 3,
    "excerpt": "    return 1.0 / denominator"
  }
}
```

The runtime serializes this behind a versioned marker in the existing engine
error channel. The service parses that machine payload before legacy display
normalization. Tool-validation outcomes additionally retain a structured
`diagnostic` field. Messages and source excerpts are bounded; incomplete or
malformed payloads fall back to the existing error path.

Source locations refer to submitted Python, not the hundreds of generated
helper lines. Runtime/import/syntax/contract errors remain visible with
`observe: []`; downstream execution failures identify their upstream cause.
A repair supersedes the failed live result but does not rewrite the prior
DELTA diagnostic. LATEST uses current state and the latest requested set.

The broader section-5 envelope is **not fully delivered**: execution/input
version references, bounded witnesses, diagnostic storage/IDs, and
`inspectError` remain later work. The current definition hash is not a claim
of complete execution-version/provenance tracking. Return-contract diagnostics
may identify the entry definition rather than an individual return statement.

## Verification and defects found

| Check | Result |
| --- | --- |
| Combined `bun test` after the final source changes | 977 pass, 0 fail; 80 files, 10 snapshots |
| `bun run typecheck` | Pass |
| Executed Python runtime pytest suite | 34 pass; one dependency deprecation warning |
| V2-specific Bun suite | 10 pass, 0 fail |
| Real-backend V2 smoke, DELTA | Pass: workflow 4114, CU 31, six recorded steps |
| Real-backend V2 smoke, LATEST | Pass: workflow 4115, CU 32, six recorded steps |
| `git diff --check` | Pass |

The three combined-suite failures documented in C1 were caused by shared
metadata-cache state across test files. Earlier server tests populated the
real operator catalog, so delegate-bootstrap fixtures skipped their mocked
catalog and rejected `TestOp` before execution. A new regression reproduced
the issue; the fixture now gets an isolated metadata instance. Production
initialization was not changed. This fix is its own commit.

Additional red-to-green regressions caught:

- Invalid V2 mode combinations returned HTTP 500 instead of 400. Validation
  now occurs before creation when possible, is atomic on PATCH, and cleans
  up a created agent if graph-dependent initial settings fail.
- V2 direct compilation bypassed common identifier/port checks; those guards
  now precede version dispatch.
- Diagnostic parsing accepted incorrectly typed optional fields; malformed
  payloads are now rejected, including when wrapped by engine messages.
- A callback's ordinary dictionary `KeyError` was mislabeled as undeclared
  input access; nested UDF cells failed too late at transport; conflicting
  Project options were not rejected during preflight. Runtime regressions
  cover each correction.

Each mode's final backend smoke asserts ten groups of checks: client-error
handling without mutation/leaked agents; a reversed six-operator Python chain;
typed/null results; forward references; cached observation; same-shape upstream
revision plus existing-DAG extension; hidden successes; unrequested callback
failure with submitted line/revision; repair with frozen DELTA history; and
syntax failure blocking its dependent while an independent FillNull succeeds.
The test cleans up its own agents, workflows and CU registrations, and treats
cleanup failures as failures.

This is real Texera compilation/execution plus production context rendering.
The debug endpoint does not make an LLM call, and reassembling stored snapshots
is not proof of actual model `inputMessages`. Real-model traces, benchmark
scores, cost, accuracy and compilation-success rates remain C6/C7 gates.

## Reproduce

From the candidate worktree root, with the existing Python environment:

```bash
.venv/bin/python -m pytest -q agent-service/benchmark/tests/test_native_v2_runtime.py
bun run --cwd agent-service typecheck
cd agent-service
bun test
```

For the live worker smoke, return to the worktree root and use the supported
launcher. Only the candidate agent is managed; shared JVM services are kept
running unchanged. The active environment's CU application API is on 8888,
as documented in C1, not the generic documentation's 8082.

```bash
export TEXERA_AGENT_SERVICE_PORT=3011
export TEXERA_LOCAL_DEV_DIR=/tmp/texera-native-python-dataflow
export TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:8888
export TEXERA_FILE_SERVICE_ENDPOINT=http://localhost:9092
export TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3011
bin/local-dev.sh up agent-service --skip-build
bun run --cwd agent-service benchmark/e2e/native-python-run.ts
```

Restart this candidate agent after changing the embedded `runtime.py`; Bun's
TypeScript module watcher does not guarantee reloading a file read at startup.
Do not restart the shared backend for an agent-only change.

Temporary verification logs are under `/tmp/native-python-dataflow-c2-*`,
including `full-tests.log`, `typecheck.log`, `runtime.log`, and `e2e-final.log`.
This committed checkpoint is the durable record; logs may expire. No provider
credentials, generated environments, task data or large traces are committed.

## Required continuation

Continue with C3: Python Scan and the remaining focused relational operators,
with hand-computable fixtures and real-worker tests. Then implement C4/C5
structured profile transport, honest coverage, versioned flow facts and
budgeted evidence selection. Runtime `.attrs["native_v2"]` currently contains
local operation metadata but is **not yet the delivered execution transport**;
do not claim those counters reach the model. Complete C6 diagnostics/shape
utilities and real-model qualification, then C7 KramaBench pilot/ablations
and actual-input trace/cost/accuracy audits. No performance benefit is claimed
at this checkpoint.
