<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Native flow evidence prototype

`settings.nativeFlowEvidence=true` enables compact, measured input/output facts
for native Compute, Aggregate, and Join operators. It defaults to false and is
independent of `columnStats`, table sampling, result selection, and batching.
The pilot keeps native `resultSelection="all"`, schema-only data level 1, and
column stats off. No benchmark task names or gold answers enter the policy.

## Measurements and limits

- Compute: exact source-null/derived-non-null and source-non-null/derived-null
  counts with one paired-row witness. Private source captures in the same SQL
  SELECT preserve pairing across replacements and window-expression reordering;
  they are removed before returning the table. These transitions can be
  intentional imputation, not necessarily an error. At most six expressions
  and four source references per expression are inspected by a conservative
  SQL-reference lexer.
- Aggregate: input/output row counts and explicit group keys, non-null numeric
  contribution counts, and up to two rare violations of a group-key-to-column
  association (or rare low-cardinality population partitions for a global
  aggregate). Searches consider at most 24 other columns. Group associations
  must have at most 512 distinct values and collisions in at most 5% of groups
  (or one group). Population partitions have 2–4 values and a minority at
  most 20%. These facts do not establish entity identity or required exclusions.
- Join: exact matched **input** rows via semi-joins against distinct opposite
  keys, repeated-key rows, and up to two common non-key value disagreements.
  Pandas null-key matching follows the actual operator semantics. Candidate
  disagreements inspect at most 24 columns, prefer categorical values, and
  require two non-null values. Output fanout never implies matched-input count.

Candidates are bounded, but measured counts use complete in-memory data, not
samples. Each operator emits at most four facts; the complete rendered block
is capped at 1,000 characters, including its heading and truncation annotation.
This is an additional context budget, not a promised cost reduction. Diagnostic
failures omit facts rather than fail or change an operation. Large relational
checks still have execution/memory cost. Custom UDF semantics are not analyzed.
No whole-DAG lineage claims or semantic correctness guarantees are implemented.

When measured Join facts are available in this arm, the legacy output-size-based
"rows had no match" inference is suppressed. Its default baseline behavior is
unchanged. Per-column summary equality is not treated as table equality.

## Transport and flag contract

The compiler attaches `{"version":1,"facts":[...]}` to the returned DataFrame's
`attrs["__native_flow_evidence__"]`. The Python worker validates the envelope
and forwards it through the existing string-valued result-statistics channel
(maximum 16,000 characters). The reserved key is excluded from schema and normal
stats rendering. The agent renders measured facts from each execution's own
snapshot in both LATEST and DELTA context. No console envelope or data column is
emitted. Older workers without this hook execute the operator normally but do
not deliver evidence. Merely enabling column stats is not a substitute.

Flag off does not instrument newly authored native operators or render the
reserved evidence. A live settings toggle applies to subsequent operator
creation/updates; it does not rewrite already-generated workflow code. Use fresh
agents/workflows for comparison arms.

## Current shared-backend setup (after the pilot)

The user confirmed separate agent services with a shared Texera backend. Agent
3009 now targets `WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:8085`,
the same execution service used by agent 3008. The compatible Python metadata
hook and regression tests were deployed to that shared worker source in the
`op-granularity` worktree at commit `7f4d59d20`; no shared JVM restart was needed.
Ordinary operators without the opt-in DataFrame attribute are unchanged.

A fresh no-LLM smoke passed against 8085: CREATE/GET/PATCH settings, prompt
scope, Compute/Aggregate/Join measurements, and unchanged output schemas. The
temporary CU-master on 8086 / actor 2553 was retired. Record 19 and the original
pilot artifacts remain for provenance; it identifies the original isolated
runtime, not the current shared execution endpoint. No benchmark task was
rerun or overwritten during this switch.

Use the supported launcher to manage only this worktree's agent service:

```bash
TEXERA_AGENT_SERVICE_PORT=3009 TEXERA_LOCAL_DEV_DIR=/tmp/texera-native-evidence-20260914 WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:8085 bin/local-dev.sh up agent-service --skip-build
```

From `agent-service/`, repeat the synthetic shared-worker check with:

```bash
WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:8085 TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3009 SMOKE_AGENT_TURN=0 bun run benchmark/e2e/native-flow-evidence.ts
```

The following isolated-runtime notes describe **the measured pilot**, not the
current service placement. They are retained to reproduce its exact setup.

## Isolated runtime used for the 2026-09-14 pilot

Worktree: `.claude/worktrees/native-dataflow-evidence`, branch
`feat/native-dataflow-evidence`. Agent HTTP 3009; CU HTTP 8086; Pekko actor 2553.
The shared baseline/batching CU stays at 8085/2552. Only Python workers launched
from this worktree load its metadata hook. Its generated proto directory and
venv link to the baseline's identical dependencies; build output is an actual
copy, **not** a writable link into baseline artifacts.

The existing distribution was copied from the `op-granularity` worktree, then
only the two `AmberRuntime` class files were recompiled with Scala 2.13.18 and
overlaid into the copied Amber jar. All other distribution entries remain
identical. This changes port plumbing, not query/operator execution semantics.
Recorded Amber jar SHA-256 values (zip metadata may differ on a rebuild):

- Baseline: `5c45c16645ae6938d9b1c1b1743082f5765ad3c5861e3f677afa07f92388ffed`.
- Isolated: `5b58dcb139831be23a0fa59766a2a82707ec77b044883d45e28910107f0c17d3`.

Repeat the narrow build from the isolated repository root, starting with no
existing copied distribution. Adjust the explicit baseline path if necessary:

```bash
baseline_dist=/home/bob/Desktop/dataflow-agent/.claude/worktrees/op-granularity/amber/target/amber-1.3.0-incubating-SNAPSHOT
evidence_dist=amber/target/amber-1.3.0-incubating-SNAPSHOT
scala_cache=/home/bob/.cache/coursier/v1/https/repo1.maven.org/maven2
test ! -e "$evidence_dist"
mkdir -p amber/target/native-port-classes amber/target/native-port-test-classes
cp -a --reflink=auto "$baseline_dist" amber/target/
scala_compiler="$scala_cache/org/scala-lang/scala-compiler/2.13.18/scala-compiler-2.13.18.jar:$scala_cache/org/scala-lang/scala-reflect/2.13.18/scala-reflect-2.13.18.jar:$evidence_dist/lib/*"
java -cp "$scala_compiler" scala.tools.nsc.Main -classpath "$evidence_dist/lib/*" -d amber/target/native-port-classes amber/src/main/scala/org/apache/texera/amber/engine/common/AmberRuntime.scala
evidence_test_cp=$(rg --files "$scala_cache/org/scalatest" "$scala_cache/org/scalactic" | rg '/3\.2\.20/[^/]+\.jar$' | paste -sd : -)
java -cp "$scala_compiler" scala.tools.nsc.Main -classpath "amber/target/native-port-classes:$evidence_dist/lib/*:$evidence_test_cp" -d amber/target/native-port-test-classes amber/src/test/scala/org/apache/texera/amber/engine/common/AmberRuntimePortSpec.scala
java -cp "amber/target/native-port-classes:amber/target/native-port-test-classes:$evidence_dist/lib/*:$evidence_test_cp:$scala_cache/org/scala-lang/modules/scala-xml_2.13/2.1.0/scala-xml_2.13-2.1.0.jar" org.scalatest.tools.Runner -o -s org.apache.texera.amber.engine.common.AmberRuntimePortSpec
jar uf "$evidence_dist/lib/org.apache.texera.amber-1.3.0-incubating-SNAPSHOT.jar" -C amber/target/native-port-classes .
```

Run through the supported launcher, with the following worktree-local settings
(root `.env` or exported shell values, never another worktree's env file):

```bash
export TEXERA_AGENT_SERVICE_PORT=3009
export TEXERA_CU_MASTER_PORT=8086
export TEXERA_CU_MASTER_ACTOR_PORT=2553
export WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:8086
export STORAGE_ICEBERG_CATALOG_TYPE=rest
export TEXERA_LOCAL_DEV_DIR=/tmp/texera-native-evidence-20260914
bin/local-dev.sh up computing-unit-master --skip-build
bin/local-dev.sh up agent-service --skip-build
```

In an execution environment that cleans up detached children when the shell
exits, keep a shell open with `&& tail -n 0 -F` of the appropriate own log after
each launcher command. The CU process working directory must be this worktree's
`amber/`, and its Python source root is `amber/src/main/python`. Check HTTP and
actor listeners using `ss`; also check `/proc/<pid>/cwd` and a **non-secret**
environment whitelist. Match REST catalog URI `http://localhost:8181/catalog`,
warehouse `texera`, bucket `texera-iceberg`, region `us-west-2`, dashboard 8080,
compiler 9090, and the shared Python interpreter. The current launcher uses
host-LAN MinIO 9000 while the older shared CU defaults to localhost 9000; both
resolve to the same local service. Never dump whole process environments.

The Python harness requires a dedicated record with URI `http://localhost:8086`
and `NATIVE_PILOT_EVIDENCE_CUID=<record id>` for the evidence arm. This prevents
automatic selection of a shared/default computing-unit record.

## Checks

From the repository root:

```bash
bash bin/local-dev/tests/test_computing_unit_ports.sh
bash bin/local-dev/tests/test_agent_service_port.sh
PYTHONPATH=amber/src/main/python .venv/bin/python -m pytest amber/src/test/python/core/runnables/test_data_processor.py -q -k native_flow_evidence
```

From `agent-service/`:

```bash
bun test src/agent/native/native.test.ts src/agent/native/flow-evidence.test.ts
bun run typecheck
WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:8086 TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3009 SMOKE_AGENT_TURN=1 bun run benchmark/e2e/native-flow-evidence.ts
```

The deterministic smoke executes synthetic three-row sources through Compute,
Aggregate, and Join, checking exact facts and unchanged user schema. Optional
`SMOKE_AGENT_TURN=1` also makes one small synthetic task turn, creates two typed
operators, and asserts the actual recorded model `inputMessages` contain the
evidence but not its raw metadata envelope. It deletes only its own temporary
agent, workflow, and CU record. These are setup smokes, not benchmark attempts.
