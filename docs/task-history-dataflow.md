# Task catalogs on the shared ReAct loop

The multi-task extension changes session memory and retains historical data.
Model requests, tool execution, observations, error repair and final answers use
one ReAct implementation, aligned with the `evidence-only-context` worktree.

The [long-horizon catalog plan](long-horizon-catalog-plan.md) records the research
hypothesis, next implementation steps, switching experiment and testing criteria.
This document describes what is implemented today.

## Shared implementation

The synchronization baseline is `feat/evidence-compaction` at `fa22f4213`, plus
that worktree's pending source-seeding implementation as inspected on 2026-09-21.
The `opBlock` context layout and its tests are included. Source seeding remains
opt-in and off by default. Local service-port configuration, launcher changes,
Scala changes and benchmark-submodule edits from that worktree are not part of
this synchronization.

The following use the shared implementation:

- `VercelToolUseDriver`: one Chat model, normal SDK tool loop and `maxSteps` limit.
- `TexeraAgent.sendMessage`: the same preparation and completion callbacks,
  with historical retention only at task boundaries.
- `runPostStepExecution` and `executePostStepChanges`: the same scheduling,
  downstream execution, invalidation, revision-pinned errors and observation capture.
- `buildContextAssembler`, `assembleContext` and the context renderers: the same
  DELTA/LATEST semantics and evidence budgets inside an active task.
- System prompts and native operator definitions: the standard evidence branch
  prompt and tool schema, with a short historical-input explanation when enabled.

Two small fixes are preserved: provider cache-write counts are read from all
recorded response formats for cost accounting, and a missing Python UDF entry
point reports a signature error instead of crashing its validator. Neither
changes request caching policy or adds another ReAct path.

## Settings and switching

Both settings default to false and require native batch catalog V2:

| Setting | Purpose |
| --- | --- |
| `nativeTaskContext` | Replace completed action traces with prior requests/answers and a compact operator catalog. The active task uses the configured shared assembler. |
| `nativeTaskHistory` | Retain complete outputs and enable exact `{operator, atTask}` inputs. Select before the first task or workflow operator. |

`withTaskCatalog` decorates the configured context assembler. With catalog
context off, it delegates the original input unchanged. With it on, it prefixes
completed requests, final answers, operator cards and saved-output availability,
then delegates only the active task's steps to that same assembler. It supports
synchronous previews and asynchronous assemblers. It does not select a different
model, prompt, cache transport, execution policy or answer-completion mechanism.

To start with full history and switch later, create a native V2 batch agent with
`nativeTaskContext: false`. If historical data will be needed, enable
`nativeTaskHistory: true` from creation. Between completed turns:

```http
PATCH /api/agents/<id>/settings
Content-Type: application/json

{"nativeTaskContext": true}
```

The switch preserves the session's workflow, results and retained bindings.
Switching back is supported. A switch during an active turn is rejected before
any settings change. No automatic task-count or token threshold is introduced;
the caller chooses the boundary. The context layer is the place to evaluate a
future selection or switching policy.

This is not yet a bounded-memory policy: prior questions/answers and the list of
operators can still grow. The shared active-task renderer can also include the
current workflow. The next catalog experiment should address that explicitly,
while keeping this ReAct implementation fixed.

## Historical data contract

A current operator id follows the current graph. `{operator: "total", atTask: 1}`
reads the complete successful output retained at the end of task 1. Task numbers
are assigned by the runtime. No model-authored save ids or checkout operation
are required.

The engine retains immutable Arrow files before later edits can evict execution
caches. Retention preserves the schema, empty tables, nulls and int64 values;
loading verifies the checksum. Unchanged result identities share one retained
file. The service resolves historical inputs to runtime-owned source operators
with no live edge to the original producer. Ordinary batch tools can combine
current and historical inputs, and UDF arguments bind positionally.

Failed or unavailable historical results fail explicitly. A failed current edit
blocks current descendants while earlier retained data stays available. The
usual partial-success batch contract applies. Retention does not establish that
the agent selected the intended population or calculation.

Bindings live in the agent session. Clear/import/restart does not reconstruct
bindings from retained files. `TEXERA_TASK_RESULT_DIR` must be engine-owned and
visible to its Python workers; distributed storage, quotas and garbage collection
remain outside this local research implementation. Files can outlive workflow
cleanup. The existing engine retention endpoint is unchanged by this cleanup.

## Retired experiments and benchmark arms

The separate Responses/cache-boundary transport, compact prompt/schema,
direct-return/early-stop path, stale/empty-answer refusal heuristics, task
receipts/reuse prompting, demand-execution variant and kept-frame rewriting have
been removed. Their settings are rejected, including explicit false values;
old experiments must run their recorded revisions.

The current runner exposes new names, so saved labels keep their original meaning:

```bash
bun run agent-service/benchmark/multiturn/run-task-native.ts session.json output-dir react-full
bun run agent-service/benchmark/multiturn/run-task-native.ts session.json output-dir react-catalog
```

These two arms have identical settings except `nativeTaskContext`; both retain
historical results. The campaign coordinator defaults to ordinary Chat transport
for CodeAgent as well. Historical reports and artifacts remain available under
`agent-service/benchmark/multiturn/`, including
[TASK_HISTORY_REPORT.md](../agent-service/benchmark/multiturn/TASK_HISTORY_REPORT.md),
[RESEARCH_REVIEW.md](../agent-service/benchmark/multiturn/RESEARCH_REVIEW.md), and
[LONG_HORIZON_REVIEW.md](../agent-service/benchmark/multiturn/LONG_HORIZON_REVIEW.md).
Their measurements describe the recorded implementation, not this cleanup.

## Verification

The cleanup was checked with the full agent-service test suite (1,107 tests),
TypeScript type checking and 35 Python runtime tests. New tests exercise catalog
switching in both directions, asynchronous assembly, active-turn rejection,
unchanged tool schemas and shared final-answer behavior, API setting rejection,
SDK tool/prepare/finish ordering, step limits and cancellation. Historical-input
and shared execution/diagnostic suites continue to pass.

Source comparison confirms that the ReAct method, execution methods, context
preview and server assembler/model construction match the inspected evidence
worktree, excluding the two task-boundary retention calls. The Python missing
entry-point fix and generalized cache-write measurement are the intentional
shared-runtime differences listed above.

A live engine smoke was not run during this cleanup: the local JVM/engine services
were stopped. With the stack running, the maintained no-model smoke is:

```bash
bun run agent-service/benchmark/multiturn/task-history-smoke.ts
```
