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

# C6 partial: revision-pinned diagnostics and repair integration

Date: 2026-09-15. Branch: `feat/native-python-dataflow`.
Implementation and contract documentation: **`a8ba50f35`**.
The batching ancestor remains `41cd8ae97`. No other workspace was edited.

This completes the local diagnostic integration, **not C6's live/real-model
qualification or the full plan**. No service was started/restarted, no new live
worker fixture ran, and no real LLM or KramaBench run occurred. The nineteen
operator implementations remain as recorded in the [shape checkpoint](native-python-dataflow-c6-shapes.md).
There is no measured cost or accuracy improvement claim.

## Delivered behavior

- Every recorded V2 execution failure owns an immutable diagnostic identity,
  operator revision, event ID, actual execution ID when available, sanitized
  error and submitted-source context. Unknown/stale source bindings explicitly
  withhold attribution instead of reading a later revision's source. Input
  materialization references are included only when execution bindings prove
  them, not inferred from today's cached table.
- A rejected edit has its own submitted revision and `phase:attempt`, with null
  execution ID. It does not change the accepted DAG, but supersedes its old
  success and blocks descendants. Rejection is control state separate from
  results: an upstream rerun cannot silently forgive it; a later consumer cannot
  execute the old accepted definition. Independent targets remain runnable.
  Explicit accepted resubmission repairs the rejection even when deliberately
  restoring the same accepted code/hash. Skipped dependent edits still need
  resubmission. Branch history remains pinned.
- Unknown operator submissions with an ID also get a diagnostic-only identity,
  without pretending to have valid operator semantics or adding anything to the
  DAG. Incomplete requests without an operator ID keep ordinary validation
  receipts; they cannot name a result revision to inspect.
- Normal diagnostic renders have a separate 1,200-character detail allowance.
  Expanded reads have 4,000 detail characters, bounded extra message/source
  context, omission markers and verified input references. These are per-render
  character allowances, **not total-step token caps**. Mandatory identity
  envelopes do not compete with details. Private traceback/source prefixes are
  bounded and marked complete/incomplete; truncated runtime prefixes do not
  become model-facing error excerpts.
- Credential-shaped values and the delegated token are redacted without moving
  source lines. No environment enumeration or console/table dump is performed.
  Redaction is defense in depth, not a universal detector of secrets in arbitrary
  user-authored text. Opaque backend capability, authorization, availability,
  worker and timeout errors have distinct infrastructure codes/hints.
- `inspectError({operatorId, revision?, diagnosticId?})` is enabled only for V2
  batching. It is a read-only pull, with no execution or workflow snapshot of
  its own. Current failure is the default; exact revision/diagnostic ID retrieves
  retained history after repair. Same-revision repeated executions have distinct
  diagnostic IDs. Revision lookup follows the active branch; explicit IDs can
  select another retained branch of the same agent. Missing/pruned diagnostics
  are unavailable, not reconstructed.
- The exact saved pull persists through DELTA/LATEST and the layout variants,
  including later repairs. Successful-result omission cannot suppress V2 error
  details. A rejected edit is labeled not executed, not re-executed. V2 UDF error,
  code-display and reflection paths do not echo the generated runtime in place
  of the submitted function.
- The system prompt explains inspection, source attribution, historical errors,
  rejection/repair, infrastructure hints, and the distinction from successful
  `observe`. Existing Python batching examples still validate and execute.

Exact wire fields, selection semantics, budgets and HTTP responses are in
[plan §5](../native-python-dataflow-plan.md#5-errors-are-part-of-the-public-operator-api).

## External access and its boundary

`POST /api/agents/:id/inspect-error` accepts the same query and requires the
caller's Bearer token, the agent owner, and a bound workflow. It asks Texera's
protected workflow-read endpoint to verify that token and current read access;
decoding JWT claims alone is not accepted as signature verification. There is
no stored-token fallback, redirect following, cached ACL or raw backend-body
exposure. Authorization has a five-second timeout and fails closed.

Normal snapshot/result responses carry the sanitized `nativeError` summary,
not private diagnostic records. The TS API client requires an explicit token
for inspection. In-loop model access is scoped to its delegated agent and has
no agent-ID, file/log-path or unlimited-budget argument.

This is **not whole-service security hardening**. Existing trusted-local REST/WS
surfaces already expose workflows/traces and can invoke model tools. They need
deployment-level access control; protecting this new endpoint alone is not a
multi-tenant boundary. Tests of the new HTTP endpoint use a controlled backend
authorization stub; they do not claim a live cryptographic verification run.

## Verification

Final source checks, after the last fix:

- `cd agent-service && bun test`: **1,105 pass**, zero failures; 94 files,
  ten snapshots, 6,412 assertions, 16.38 seconds.
- `bun run typecheck`: pass, exit 0.
- `git diff --check`: pass.
- Twenty-five new tests cover rendering/budgets, immutable storage, production
  debug/post-step integration and HTTP authorization. Existing prompt tests gained
  assertions for the new tool and repair contract.

The local integration uses the real debug parser, batch tools, Python preflight,
snapshot storage and context assembly. Controlled result fixtures exercise
execution callbacks/target selection without running distributed workers or an
LLM. Context coverage includes DELTA/LATEST, six message-layout choices, and
session/catalog/turn-index variants. The full suite also runs the existing
generated-Python/prompt-example tests; it is not relabeled as real-agent evidence.

Regressions were demonstrated failing before fixes: generated-runtime leakage
in V2 UDF/shape-only errors, disappearing error pulls, stale successful results
after rejected edits, later consumer execution across an unrepaired rejection,
incorrect re-executed labels, upstream invalidation losing the rejection,
same-code repair, unsafe truncated traceback excerpts, multiline redaction
shifting source lines, unknown-op revisions, object-prototype-like operator IDs,
and missing message expansion. A final test-fixture readonly assignment was
corrected before the passing typecheck rerun; no type errors are waived.

No Python engine or Scala production source changed here, so their previous
full-suite/build results are not presented as fresh reruns. The prior native
Python/engine and Scala gates remain in the earlier checkpoint documents.

Temporary logs: `/tmp/native-python-dataflow-c6-diagnostics-bun-final.log`,
`...-typecheck-final.log`, and the red/green diagnostic-focused logs under
`/tmp/native-python-dataflow-c6-diagnostic-*`. This document is the durable
sanitized record; temporary logs may expire.

## Prepared live fixture and remaining gates

`agent-service/benchmark/e2e/native-diagnostics-run.ts` is prepared and
typechecked, **not run**. It has nine debug steps per DELTA/LATEST session:
initial dependent DAG, real callback failure, read-only error pull, repair,
historical pull, syntax rejection, later blocked consumer, independent upstream
rerun, and explicit same-code repair. It checks actual service snapshots/context,
runtime execution/source identity, hidden errors, authenticated bounded HTTP
reads, unauthorized rejection and its own workflow/CU cleanup. It starts no
services and is explicitly not an LLM fixture.

At handoff the shared compute master remained PID 2114172 on 8085, with no
candidate agent listener on 3011. No restart was attempted. The existing shared
backend still requires a coordinated matching-engine idle window before the
outstanding live C4 repair, C5 evidence, C6 shape and diagnostic fixtures can be
qualified. Do not infer idle state from a PID or stale lock file, or bypass this
with an unsafe second master sharing actor/cleanup state.

Next: run those correctness gates against matching engine/Python, capture real
LLM input traces for dependent batching/observe/error repair, and implement/run
the one-task-per-arm KramaBench pilot with official scores, compile/execution
pass and cache-aware cost. C7 evaluation artifacts/report remain undelivered.
