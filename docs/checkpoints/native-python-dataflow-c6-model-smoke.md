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

# C6 partial: real-model smoke protocol prepared, not live-qualified

Date: 2026-09-15. Branch: `feat/native-python-dataflow`, following resource
checkpoint `339a3bf47` / harness `377c33c`. No candidate agent/engine production
code changes in this checkpoint. Harness implementation: `bdf83f5`, with the
cached-input timing correction in `fe514f9`. **No model turn or operator execution has
been run for this protocol yet.** C4/C5/C6 live gates and official KramaBench
pilot results remain outstanding. Earlier live setup/cleanup evidence is in
the [resource checkpoint](native-python-dataflow-c7-resources.md); it is not
substituted for these tests.

## Protocol and exact entry point

The nested harness now provides `utils/native_model_smoke.py` with
`run_model_smoke(system, *, output_directory, guard, context_mode)` and a pure
`audit_model_smoke_turn` validator. The caller supplies an already-owned,
journaled, fresh V2 session; this fixture allocates/deletes/stops nothing.
Its mandatory qualification callback must validate live source/service,
matching engine/worker and owned resources before the smoke and before/after
every turn. Returning true without those checks is not evidence. Implementing
the production callback and integrating the outer runner remain required.

Run the protocol independently under DELTA and LATEST, with the actual
`gpt-5.6-luna` model and `vercel-tool-use` driver. It checks effective settings:
native V2/batch, no parallel calls, native message layout, profile collection
on, data/flow 1/1, column stats off, result/cell limits 2000/3000, maximum 25
steps, no row cap, code snapshot/thought replay off, context window 0. A client
ceiling of 1800 seconds bounds each turn; empty-turn retries are disabled.

The four user directives intentionally constrain model actions for functional
qualification. They are not representative benchmark prompts or cost trials:

1. Build a reverse-ordered UDF → Filter → Project chain in one batch, observe
   only its final result and return the observed values. The supplied Python
   source generates three small rows and canary strings at runtime; no data
   lake, benchmark question, SQL or specialized statistics are involved.
2. Explicitly observe the source with `operators: []`. The producing identity
   and rows must stay unchanged, source canaries must be absent before the
   pull, and they must now be in model
   input. Independently use the recorder to verify request counts; unchanged
   result identity alone does not prove no backend request occurred.
3. Inject a callback failure with no successful result observation, then have
   the model call `inspectError`. Require the actual execution ID, callback
   source line, invalidated downstream rows, the diagnostic visible before
   inspection, and inspection text visible in a later model input.
4. Repair the upstream predicate while adding a new consumer of the existing
   downstream node in the same reverse-ordered batch. Check actual new rows,
   a changed downstream result version, cleared error and correct model JSON.

## Evidence discipline

The audit joins the tool event's actual snapshot observation text/version to
a **later recorded model `inputMessages`** entry on that turn. It does not
reconstruct context. System-prompt examples, assistant echoes, an earlier
input or a final snapshot alone cannot prove visibility. A generated source
row must not appear in non-assistant input before it was explicitly observed.
The error audit binds the actual revision-specific runtime diagnostic to the
inspection step's input. The model-facing `inspectError` tool returns a text
string; the REST inspection endpoint's object shape is not used as a stand-in.

Capture uses actual service REST traces and all step snapshots. Each private
turn directory retains prompt, dispatch/transport state, trace with inputs,
snapshots, sanitized agent info, workflow and audit witnesses. Cumulative
trace history is filtered by prior step IDs so old events cannot pass a new
turn. No raw delegate/auth response is saved. Failure stops this protocol,
retains artifacts and leaves the caller to assess backend termination and
verified cleanup; it never retries/cancels an unknown execution.

## Local verification and limits

From `benchmark/Kramabench`:

```bash
.venv/bin/python -m unittest discover -s tests -q
```

**132 tests pass**, zero failures, including 15 new model-smoke tests. The
new tests cover all four positive audits, a complete mocked four-turn run,
input timing, prompt echoes, hidden-row leaks, explicit observation, actual
answer checking, cached bindings, revision invalidation, stale downstream
rows, source-mapped inspection, guard/model/mode rejection and partial-turn
capture without retries/cancellation. Regression tests were observed failing
before fixing stale-row acceptance, missing client bounds, the tool-versus-
REST inspection shape, missing model/driver validation and premature cached
source visibility.

Scoped Ruff formatting/F-rule checks and `git diff --check` pass. No packages
were installed into the shared venv. Root Bun/Scala/worker results remain in
earlier checkpoints; they are not claimed as reruns here. All new model-smoke
tests use fixtures/mocks, not the provider or Texera execution endpoint.

To complete qualification: wire the real source/engine/resource guard and
outer runner, obtain the shared-backend update window, run pending worker
matrices, then run this protocol in both modes with real inputs/usage retained.
Only afterward run the frozen single-task, one-attempt-per-arm KramaBench
pilot and publish accuracy/cache-aware cost/compile/runtime/collector results.
No gate or claimed benefit follows merely from passing these local tests.
