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

# C7 partial: pilot arms and execution measurements

Date: 2026-09-15. Branch: `feat/native-python-dataflow`, still descended from
batching/observe `41cd8ae97`. Engine phase measurements: **`4febe3761`**.
Local execution recorder and harness pin: **`ed33e73de`**. Isolated KramaBench
branch: **`c2fe10ecee9c359bbd142de6f33224f31def4aa8`**.

This is measurement plumbing and local qualification, **not a finished pilot**.
No new real-LLM trace, official task score or cost/accuracy result was produced.
No Texera development service was restarted or deployed. Existing shared
compute master PID 2114172 still served 8085; candidate agent 3011 remained
stopped. Test-only HTTP servers, actors and test database resources are separate
from a live candidate-agent/worker qualification run.

## Delivered harness setup

The previously empty candidate submodule was initialized at its exact pinned
`260ceb82c1cd45e64e73d7b3f5e10405ebf7a225` revision from the local batching
workspace; that object was not available from the remote by SHA. The new
harness branch includes it and is pushed to `bobbai00/Kramabench`. Other
workspaces' source, settings and recorded runs were not edited. The harness
reuses a provisioned Python environment locally; dependency symlinks are not
committed.

- Keyword-only client/system options carry `nativeCatalogVersion` and
  `nativeProfileCollection`, preserving explicit false and absent legacy
  defaults without shifting existing positional arguments. Config artifacts
  include the requested new settings.
- Explicit positive computing-unit selection survives cleanup/fresh-agent
  setup and bypasses legacy first-unit discovery. New pilot arms require it;
  allocation/ownership/cleanup remains the runner's responsibility. The old
  pilot arms' defaults are unchanged.
- Seven named SUTs are registered and discoverable: V1Reference (3013),
  BatchParent (3012), V2Control, CollectorOnly, DataOnly, FlowOnly and Combined
  (candidate 3011). Treatment-changing overrides fail. Model, DELTA, step and
  result budgets, reflection and layout are held fixed; profile collection and
  data/flow exposure are independently specified. No arm uses the obsolete
  `nativeFlowEvidence` prototype flag.
- `kb.py react_metrics` now recognizes native typed edits and batched inputs,
  requested/accepted observations, partial errors/blocks, rejection stages,
  error pulls, accepted edit-rejection repairs and native deletion outcomes.
  Missing/misaligned receipts do not earn success. Final native operator
  distribution is read from the saved workflow. The old attempt-based
  `final_ops_react` estimate is explicitly not final-DAG truth.

The full settings, differences between legacy L1/L1 and V2 exposure levels,
one-attempt protocol and artifact contract are in the
[harness pilot document](../../benchmark/Kramabench/docs/native-python-pilot.md).
The selected initial task is `environment-easy-3`, verified in the pinned
workload; its official expected metric is `success` (`numeric_exact`). No gold
answer is embedded in an operator, prompt example or pilot implementation.

## Why explicit engine phases were needed

`SyncExecutionResource.handleExecutionError` historically calls some failures
CompilationFailed by searching for words such as operator/schema in an error
message. Separately, `WorkflowExecutionService` can route a genuine compiler
failure through the generic Failed state. Neither state strings nor successful
batch mutation receipts can establish a compile pass rate.

The engine now wraps the actual strict compiler call in a per-execution
tracker. Its immutable snapshots contain:

```json
{
  "version": 1,
  "compilation": "passed",
  "compilationDurationMs": 2.5,
  "runtimeStartAttempted": true
}
```

Compilation can also be failed, running or not_attempted; an unattempted or
running call has null duration. The duration is monotonic elapsed time around
the compiler call, excluding cache preparation and runtime setup. It is **not
Python callback preflight** and does not prove subsequent execution succeeds.
The runtime flag means the coordinator start RPC was attempted, not accepted.
The existing model-facing error classification/contract is not rewritten here.

Sync responses now expose optional `phaseMetrics` and actual execution identity
for both V1 and structured V2 requests, including timed-out/error responses
when that execution exists. An early failure with no execution or an older
backend can leave measurements absent: that is unknown, not success/failure.
No schema, DAG, operator code, result selection or model prompt is changed by
these machine-only fields.

## Recorder: preserve historical agent builds

`agent-service/benchmark/e2e/execution-recorder.ts` is an evaluation-only
loopback proxy, restricted to a fixed loopback backend and explicit pilot CU
IDs. It accepts only the execution POST route, forwards the supplied Bearer
token and exact request body, and does not follow/propagate redirects. It
starts no Texera service, allocates no CU and never changes an operator.
Historical and candidate agents can use the same recorder without source
patches to the reference builds.

One recorded event is one initiated backend HTTP request, not one batch or
one operator. It records identity, submitted operator count, bounded target
IDs, structured-result mode, HTTP/transport outcome, request elapsed time and
validated engine phases. Credentials, source code, result cells, console
output and raw error messages are not retained. It exposes detached copies;
the pending runner must persist partial records into each arm's bundle.

Unknown/malformed phase metadata does not earn a pass. Failed compilation
means runtime was not attempted; a recorded compiler pass followed by a setup
failure stays a compiler pass, not a compiler failure. A runtime Error with no
terminal evidence remains unknown. A killed execution counts as runtime
failure only when a runtime start was actually recorded. Report passes,
failures, unknowns and not-attempted counts with their denominators. No
attempts means no rate. Request-duration sums are not wall time or collector
CPU measurements. An aborted client response does not establish backend
termination and must not trigger an automatic replacement attempt.

## Verification and environment findings

- Harness: **19 tests pass**, including four unchanged legacy pilot tests and
  fifteen new client/arm/native-trace regressions. `kb.py systems` resolves all
  seven SUTs. No harness test authenticates, allocates live resources or calls
  an LLM. Explicit false, positional compatibility, CU reuse, frozen knobs,
  partial batches, malformed inputs, observation-only pulls, missing receipts,
  repair counters and refused deletions are covered.
- Agent-service: **1,114 Bun tests pass**, 95 files, ten snapshots, 6,473
  assertions; typecheck passes. Nine new recorder tests exercise actual local
  HTTP forwarding against controlled stubs, source/token/result omission,
  measured versus heuristic failures, malformed/absent phases, route/CU bounds,
  redirects, empty responses, network failure and request limits. They are not
  Texera-worker or real-model tests.
- Scala/JUnit: **1,682 pass**, two existing pending cases, with the standard
  `AMBER_TEST_FILTER=skip-integration`; the tagged integration suite is excluded.
  This includes seven new tracker/service/JSON tests. The targeted ten-test
  phase/service suite also passed, including a real compiler-call rejection
  through production `executeWorkflow`, with no runtime started.
- WorkflowCompiler: **50 tests pass**. `WorkflowExecutionService/dist` passes
  package validation and writes the candidate engine ZIP under
  `amber/target/universal/`. It is **not unpacked or deployed**.
- Scoped Prettier/scalafmt ran; `git diff --check` passes. No Python engine
  production code changed; older Python pytest results are not called fresh
  reruns here.

The first unrestricted Scala attempt used the system Python, whose worker
could not import pympler. That test JVM was stopped (exit 143), not counted as
a pass. The passing invocation explicitly used the provisioned `.venv/bin/python`
and the normal unit-test filter, with the test upload server on **39192**, not
the shared file service's 9092. Tagged integration qualification remains owed.
An initial scoped-format command used unsupported glob arguments; explicit
module-relative paths corrected it before the passing build.

jOOQ regeneration warned that the default production-DB password did not
authenticate and reused existing generated bindings. DAO/schema sources were
unchanged; the compilation/tests/package results above are genuine, but they
are **not evidence of a fresh database/bootstrap/codegen run**. That credential
configuration must be resolved privately for a from-scratch build. Existing
Iceberg retry warnings also occurred in the unit suite; its final test result
was green, not inferred from the absence of log errors.

Temporary records: `/tmp/native-python-dataflow-c7-harness-verified.log`,
`...-bun-full.log`, `...-typecheck-final.log`, `...-phase-integration.log`,
`...-scala-unit-dist.log`, and the named red/green recorder/client/trace logs.
This document is the durable sanitized record; temporary files may expire.

## Remaining work (not waived by this checkpoint)

1. Finish guarded orchestration: actual listener/build provenance, effective
   settings/data hashes, fresh attempt namespaces, isolated CU/workflow
   ownership, matching-backend gates, partial trace/execution/profile capture
   and safe cleanup. The generic harness's port hints and unknown-price-to-zero
   fallback are not sufficient provenance/cost validation for this pilot.
2. Obtain the coordinated shared-backend window and run the outstanding C4
   repair, C5 evidence and C6 shape/diagnostic live matrices against matching
   engine/Python. Also qualify the new phase response on real executions.
3. Capture real LLM input traces for dependent batching, explicit observe and
   error repair. Debug fixtures, local generated-code tests and HTTP stubs do
   not substitute for this gate.
4. Run the single-task/single-attempt-per-arm KramaBench pilot; use official
   answer-aware scoring (frozen threshold >=0.9), cache-aware token cost with
   recorded pricing, measured compile/runtime denominators and de-duplicated
   collector overhead. Produce the dated manifest/report and input-message
   mechanism audit before deciding whether to expand.

No implementation-plan completion or cost/accuracy benefit is claimed.
