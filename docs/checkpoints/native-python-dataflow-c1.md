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

# C1 checkpoint: correct Scan preview windows

Date: 2026-09-14 (America/Los_Angeles).

- Branch: `feat/native-python-dataflow`.
- Parent: `feat/native-batch-observe`, `41cd8ae97`.
- Plan-first commit: `4f8c7f88e`, pushed before implementation started.
- Implementation commit: `821f01435`.
- [Full design and remaining checkpoints](../native-python-dataflow-plan.md).

## Delivered

The generated Scan loader now honors `skipLines` in previews instead of
silently returning the first window again:

| Format | Offset meaning | Returned positions |
| --- | --- | --- |
| Text, including `format: "lines"` preview | Physical lines skipped in each file, counting blank/comment lines | Absolute zero-based `line_no` |
| Excel | Physical rows skipped in each sheet | Absolute zero-based `row_no` |
| HTML | Data rows skipped in each table | One-based data `row_no`; synthetic header at 0 only when offset is 0 |
| Binary pointer preview | Nonzero offset is inapplicable | Actionable error rather than silently ignored offset |

EOF returns a schemaful empty preview; a final short window is not padded.
Legacy non-preview line numbering and the existing preview file caps remain
unchanged. Excel workbook handles now close after reading. Catalog/schema text
and the batch system prompt explain offsets and their limitations. The 72-variant
typed-prompt regression remains unchanged and passes.

Added 13 tests that execute generated Python with the worker environment:
text windows, zero/omitted offsets, multiple files, EOF/empty data, encoding,
Excel sheets, HTML header/offset conventions, binary errors, and full-lines
compatibility. These are not merely generated-code string assertions.

Extended the existing real-backend batch E2E with an offset Scan feeding an
existing-style Project, upstream revision with unchanged output shape, hidden
results, cached observation, a failed Scan revision and repair using the same
ID. The preexisting forward-reference/scheduler tests remain in place. Cleanup
attempts each run-owned agent/workflow/CU registration, removes generated test
fixtures, and makes cleanup failure a nonzero exit.

## Red-to-green evidence

Before changing the compiler, the new executed-Python tests reported **4 pass,
9 fail**. Failures showed that later windows returned the initial text/sheet/
HTML rows, EOF offsets returned old rows, and binary offsets were ignored.
After the fix: **13 pass, 0 fail**. Combined with the existing native codegen
suite: **40 pass, 0 fail**.

The prompt regression was also added first: **4 pass, 1 fail** until the batch
prompt explained the now-supported offset. No snapshot hash was updated to
hide a baseline change.

## Verification results

| Check | Result |
| --- | --- |
| Targeted native/compiler/batch/scheduler/context/prompt suites | 102 pass, 0 fail |
| `bun run typecheck` | Pass |
| Full combined `bun test` before implementation (C0 source) | 950 pass, 3 fail |
| Full combined `bun test` after implementation | 963 pass, same 3 fail |
| All 79 test files run in separate Bun processes | 966 pass, 0 fail |
| Isolated `texera-agent.test.ts` | 26 pass, 0 fail |
| Prettier on changed TypeScript; `git diff --check` | Pass |
| Real shared-backend no-LLM E2E on agent port 3011 | Pass, including the strengthened error-render assertions |

The three combined-suite failures are the already-present delegate bootstrap
cases in `texera-agent.test.ts`: initialization anchoring workflow/results,
execution-failure persistence, and sibling-error persistence. They were reproduced
before source changes and pass in their own process. The evidence is consistent
with cross-file mock isolation, not a newly introduced regression. This
checkpoint does **not** fix them or describe the combined suite as green.

### Reproduce local checks

From `agent-service/`, with the repo worker venv provisioned (or an explicit
`UDF_PYTHON_PATH`):

```bash
bun test src/agent/native/scan-preview.test.ts src/agent/native/native.test.ts
bun test src/agent/native/scan-preview.test.ts src/agent/native/native.test.ts \
  src/agent/tools/native-batch-tools.test.ts \
  src/agent/tools/native-batch-scheduler.test.ts \
  src/agent/tools/native-batch-context.test.ts \
  src/agent/tools/tool-call-scheduler.test.ts \
  src/agent/prompts-native-batch.test.ts
bun run typecheck
bun test
rg --files src -g '*.test.ts' -0 | xargs -0 -n 1 -P 4 bun test
```

Only the combined `bun test` is expected to retain the documented three failures
in this environment. The isolated command above completed with exit code 0.

### Real-backend E2E environment and invocation

Used the dedicated candidate agent service on **3011**, with the existing
Texera web/compilation/execution services on 8080/9090/8085. No shared JVM or
Docker service was restarted or modified. Existing worktrees were preserved.

The active backend's CU **application** API is on **8888**. The generic 8082
port listed in repository documentation returned an admin-server 404 for CU
creation; read-only endpoint checks and the provisioned worktree's non-secret
configuration confirmed 8888. Use the running environment's configuration,
not an assumed port. Agent and backend share a local filesystem for fixtures.

From this worktree's root:

```bash
export TEXERA_AGENT_SERVICE_PORT=3011
export TEXERA_LOCAL_DEV_DIR=/tmp/texera-native-python-dataflow
export TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:8888
export TEXERA_FILE_SERVICE_ENDPOINT=http://localhost:9092
export TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3011
bin/local-dev.sh up agent-service --skip-build
bun run --cwd agent-service benchmark/e2e/native-batch-run.ts
```

Final smoke summary: `passed: true`, workflow 4108, CU registration 25,
12 recorded steps, 17 reported checks. Those test-owned resources were cleaned
up. An earlier successful pass used workflow 4107/CU 24. The final pass additionally
asserted the actual `Scan window failed` diagnostic in both context renders,
not just the presence of the failing path in an operator's properties.

Both DELTA and LATEST were assembled from the real service's trace/snapshots
using the production context assembler. The debug endpoint bypasses the actual
LLM turn's input preparation: this is **real engine execution plus production
rendering**, not a real-model/benchmark score run. Real LLM qualification remains
a later gate.

Local diagnostic logs (temporary, not required for reproduction):

- `/tmp/native-python-dataflow-baseline-tests.log`
- `/tmp/native-python-dataflow-preview-red.log`
- `/tmp/native-python-dataflow-preview-green.log`
- `/tmp/native-python-dataflow-prompt-red.log`
- `/tmp/native-python-dataflow-targeted.log`
- `/tmp/native-python-dataflow-tests.log`
- `/tmp/native-python-dataflow-bootstrap-isolated.log`
- `/tmp/native-python-dataflow-isolated-suites.log`
- `/tmp/native-python-dataflow-e2e.log`
- `/tmp/texera-native-python-dataflow/logs/agent-service.log`

This committed report is the durable compact checkpoint; temporary logs may
expire. No provider secrets, task datasets or large benchmark traces are committed.

## Limits and next checkpoint

This is C1, **not the V2 operator rollout**. The legacy SQL operators still
exist and retain their previous semantics. No Python callback catalog/version
flag, structured callback-error envelope, new profiler, evidence selector,
`inspectError`, benchmark arm, or performance claim is delivered yet.

Text previews still cap at five files; Excel/HTML previews still use the first
matching file. Legacy Parquet preview behavior is not addressed here. Full
source coverage/provenance and reader-option consistency belong to the V2
Scan work. The runtime-error smoke verifies the current error visibility path;
it does not substitute for source-mapped callback diagnostics.

Next: **C2, the Python contract/error foundation**. Add failing tests for V2
version routing, callback syntax/signatures, literal preservation, missing/type/
empty-input behavior, row preservation and source-mapped errors before exposing
Transform/Derive/Filter to the agent. Keep V1 and V2 isolated. Carry on with the
shared scheduler and explicit `observe` contract, preserving join `left`/`right`
fields rather than needlessly changing existing batch reference syntax.
