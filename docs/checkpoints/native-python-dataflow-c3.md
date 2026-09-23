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

# C3 checkpoint: Python-native core and schemaful worker inputs

Checkpoint date: 2026-09-15.

- Branch: `feat/native-python-dataflow`, worktree
  `.claude/worktrees/native-python-dataflow`.
- Batching parent: `41cd8ae97`; C2 foundation: `1ffc49cf8`.
- Core implementation: `67f69e151`.
- Required Python-engine fix: `efb45ea94`.
- Separate stale engine-fixture correction: `b85d3f2f6`.
- Follow-up cross-join validation: `3a5e7dfc0`; its generated-tool preflight
  and runtime regressions pass.
- [Full operator contracts and remaining plan](../native-python-dataflow-plan.md).

C3 delivers the fourteen-operator core, not the complete research system.
Structured profile transport, selective flow/data evidence, shape utilities,
expanded diagnostic inspection, real LLM traces and benchmark evaluation remain
C4–C7. There is no cost/accuracy or benchmark-score improvement claim here.

## Delivered operators

Keep `agentMode:"native"`, `nativeToolMode:"batch"`,
`nativeCatalogVersion:"v2"`. V1 remains the default and keeps its existing
catalog/compiler/prompt. V2 has no Compute/SQL expression or SQL fallback.

Project, Cast, FillNull, Transform, Derive, Filter and UDF retain their C2
contracts. This checkpoint adds the following public `op` forms (each also
requires `id` and the input reference shown in the full plan):

| Operator | Arguments and principal behavior |
| --- | --- |
| `scan` | `files`, optional format/parsing/preview options; Python readers, validated headers, source identities and bounded diagnostic previews |
| `aggregate` | `groupBy?`, `aggregations:[{fn,col?,as}]`; structured reducers, explicit nonnull denominators, first-seen/null groups |
| `join` | `left`, `right`, explicit `on` unless cross, optional type/null/cardinality/suffix policy; no inferred keys or silent cardinality repair |
| `union` | Ordered `inputs`, `schema:"strict"` by default or `"align"`; compatible named types, null padding, no deduplication |
| `distinct` | Optional key `columns`, `keep:"first"` or `"last"`; retain a whole row, stable surviving order |
| `sort` | `by:[{col,desc?}]`, `nulls:"last"` by default; stable ties and explicit null placement |
| `limit` | `n>=1`, `offset>=0`; stable positional slice, including empty schemaful results |

Aggregate supports count, count_distinct, sum, mean, min, max, median,
stddev and first. Count without `col` counts rows; other counts/reducers use
nonnull cells. Empty ungrouped input yields one row (count 0, sum null);
empty grouped input yields zero rows with declared columns. Sample standard
deviation uses `ddof=1`. First includes an initial null. Integer summation
checks range instead of accepting NumPy wraparound.

Join uses equality-key multiplicities for exact operational counters and
cardinality validation. With the default `nullsEqual:false`, any key containing
a missing component is ineligible to match. When explicitly true, those keys
also participate in validation. Same-name paired keys coalesce; other right
overlaps receive the suffix. Self-join keeps two logical roles even though the
generated DataProcessing wrapper has one distinct physical input. Cross joins
have no equality keys: non-default key-cardinality validation is rejected in
preflight rather than ignored.

Scan supports CSV, lines, FWF, whitespace, Excel, HTML, JSON and Parquet.
Canonical resolved paths are deduplicated and sorted. Duplicate headers and
flattened JSON-name collisions fail; the runtime does not silently overwrite
fields. JSON/Parquet/Excel string cells retain their string type. Nullable
integers are constructed without a float inference round trip. Text previews
retain absolute physical line positions; Excel/HTML preserve the documented
row-window semantics. Coverage metadata records the five-text-file/first-
workbook/first-HTML-file caps and omitted files. A selected sheet's full parsed
table is not a claim of coverage of every workbook sheet.

Binary pointer previews do not decode binary data as text. Unsupported reader
options, missing files, unavailable reader packages and parsing failures remain
actionable diagnostics. Encoding selection is recorded; an explicit encoding
overrides BOM/UTF-8 detection and the strict CP1252 fallback.

The prompt now includes eight schema-checked JSON batch examples and explicit
guidance on discovery boundaries, independent/dependent chains, count versus
nonnull denominators, null joins, cardinality repair, and self-joins. It still
requires `observe` for successful content and for the final answer. Shared
scheduling, hidden-result receipts, frozen DELTA history and current LATEST
visibility are unchanged.

## Engine defect found by live tests

A source produced an empty typed `x` column, but a downstream Aggregate failed
with `MISSING_COLUMN: available: []`. Two handoffs were losing information:

1. The materialization reader opened the actual table schema but did not
   publish it back to the input port, which retained a compile-time placeholder.
2. TableOperator reconstructed a DataFrame from buffered tuples only; zero
   tuples supplied no column names, and nullable integer tuples could be
   promoted through a precision-losing float representation.

The storage reader now publishes its schema before channel markers. Before
table finalization, the processor passes the runtime port schema to
TableOperator, including buffered-table access used by loop operators. Table
construction uses explicit nullable numeric/boolean types and preserves empty
columns. It does not infer the schema from the downstream operator's arguments.

The live fixture verifies an int64 value above `2**53` and a nullable boolean
by transforming them to strings in the downstream worker before comparing the
result. This verifies the worker handoff, not arbitrary-precision JSON numbers
in the JavaScript API. That display boundary still needs the C4 transport audit.
Likewise, the legacy result API displays missing cells as the string `"NULL"`;
the fixture normalizes only known-nullable test columns and separately verifies
actual worker `None` values with a predicate. No global replacement of literal
user `"NULL"` strings was introduced.

## Verification

| Gate | Result |
| --- | --- |
| Full Bun suite | 983 pass, 0 fail; 81 files, 10 snapshots |
| Typecheck | Pass |
| Executed Python V2 operator suite | 77 pass; dependency deprecation warning |
| Full Python engine core suite | 942 pass, 1 pre-existing xfail; dependency deprecation warning |
| Core live DELTA / LATEST | Pass, workflows 4127 / 4128; CUs 44 / 45; six debug steps each |
| C2 foundation live DELTA / LATEST rerun | Pass, workflows 4129 / 4130; CUs 46 / 47; six debug steps each |
| Cross-join validation follow-up | Python runtime regression and generated batch preflight regression pass |
| Whitespace check | `git diff --check` passes |

No Scala or protobuf definitions changed. Python protos were generated locally
for the fresh worktree and remain ignored. The engine's existing expected
failure concerns queue-priority registration ordering, not the operator/schema
changes. An earlier broad test run also emitted an existing Iceberg generator
cleanup warning; the final run did not reproduce it.

The core live scenario checks a reversed nine-operator Scan/Union/Distinct/
Aggregate/Join/Sort/Limit chain, same-shaped upstream replacement through
unchanged descendants, a new consumer alongside that revision, cached observe
without execution, hidden successes, join-cardinality failure with no observed
results, same-ID repair and pinned history. Additional operators exercise
self-join, empty grouped/ungrouped aggregates, cross join, true missing values
between workers, and exact nullable int64/boolean handoff. Cleanup of each
test's own agents/workflows/CU registrations is required for a passing run.
The final cross-join preflight guard adds no change to those successful
execution paths; it was added after the recorded live core run.

Ten unrelated stale assertions were reproduced on `41cd8ae97`: five expected
retired structural-profile wording/semantic key or eligibility hints; three
omitted the existing dynamic-schema handler argument; two expected an old
binary marker. Tests now assert current behavior (including both dynamic-schema
flag values), without restoring the retired heuristics or changing those
production paths. These failures are not attributed to C3.

One smoke-harness issue was also fixed: its debug endpoint takes Python-literal
arguments, but JSON booleans were being sent as `true`/`false`. A recursive
encoder now generates Python literals without rewriting submitted code/string
contents, and the harness verifies that the requested tool actually ran. The
production LLM JSON tool path was not changed.

## Reproduction and deployment

From this worktree root:

```bash
.venv/bin/pytest -q agent-service/benchmark/tests/test_native_v2*.py
bun run --cwd agent-service typecheck
cd agent-service && bun test
```

From the worktree's `amber/` directory:

```bash
PYTHONPATH=src/main/python ../.venv/bin/pytest -q src/test/python/core
```

The executing backend must include the Python-engine change `efb45ea94`.
Starting a candidate agent on an older backend does not deploy that change.
For this verification only, the five worker-source files were temporarily
patched in the active backend checkout `op-granularity` (`85b75d104`), with
no running workers and no shared JVM restart. After all live jobs cleaned up,
those exact patches were removed; the backend checkout's prior state, including
its separate prototype metadata hook, was preserved. That unrelated hook is
not a dependency of the delivered code.

With the matching worker code deployed, use the supported isolated agent
launcher and the same shared web/compiler/storage/gateway services:

```bash
export TEXERA_AGENT_SERVICE_PORT=3011
export TEXERA_LOCAL_DEV_DIR=/tmp/texera-native-python-dataflow
export TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:8888
export TEXERA_FILE_SERVICE_ENDPOINT=http://localhost:9092
export TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3011
bin/local-dev.sh up agent-service --skip-build
bun run --cwd agent-service benchmark/e2e/native-core-run.ts
bun run --cwd agent-service benchmark/e2e/native-python-run.ts
```

Restart only the candidate agent after editing the embedded runtime. Logs are
under `/tmp/native-python-dataflow-c3-*`, notably `e2e-final.log`,
`foundation-e2e-final.log`, `engine-final.log`, `engine-full-baseline.log`,
`engine-baseline.log`, `python.log`, `full-tests.log` and `typecheck.log`.
This checkpoint is the durable sanitized record; temporary logs may expire.

## Required continuation

Implement C4 structured ordinary profiles with honest full/partial coverage,
multi-yield/partition handling, collection cost and versioned result transport.
The runtime's local `.attrs["native_v2"]` counters/provenance are not yet a
delivered profile or flow-evidence channel. Then implement C5 joint evidence
selection within the existing observation budget and test stale-event handling.
Complete C6 shape operators/diagnostic inspection and real-model qualification,
then C7 KramaBench pilot/ablations with official scores, compile/execution pass
rates, cache-aware cost, and actual `inputMessages` audits. These debug runs
are real engine executions, but they are not real-model traces or benchmark
accuracy measurements.
