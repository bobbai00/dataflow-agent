<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements. See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership. The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied. See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Registered Python Dataflows

The active native protocol is `registered-python-v1`. It uses one
`dataflow(reasoning, actions)` tool, explicit execution, persistent authored
Python definitions, and isolated operator invocations. This document records
the implemented contract; end-to-end campaign results are recorded separately.
The previous planning document is retained in
[the archive](archived/native-registered-python-design-before-implementation-20261008.md)
and is superseded, including its automatic-refresh and answer-from proposals.

The [follow-up checklist](#follow-up-checklist-2026-10-08) records pending changes
and experiments separately from the implemented contract below.

## Actions

| Action | Contract |
|---|---|
| inspect | Read the current graph, operator instance, registered namespace, exact result schema, retained source metadata, or selected built-in reference. Never execute. |
| edit | Stage `python` and `changes` strings together; unused strings are empty. Validate definitions, binding, and the final DAG before committing either. |
| execute | Compute selected `operator_ids` and their ancestors; omission selects the whole graph. Reuse valid results. |
| retrieve | Read a nonempty `operator_ids` list using one enabled view and optional shared columns. Report each target separately; never execute. |
| answer | Return `content` as the call's only action and finish the turn. |

The action list is ordered, not transactional. Each edit is atomic: one invalid
declaration rejects that edit's Python and graph changes together and skips later
actions. Earlier completed edits remain. After an execution failure, subsequent
requested executions, inspection, and retrieval can continue, retaining completed
results. Later edits are skipped; once an edit is skipped, subsequent executions
are also skipped so they cannot silently use the old graph. Repair definitions in
the next call. Independent execution groups continue after a sibling fails;
branches sharing an engine controller may need a separate requested execution.
Stale results are never silently current.

A model call whose dataflow calls all fail the same way as the previous call's,
against an unchanged graph and namespace, is a repeated failure. The second
receives one correction naming the error, the current operators (or that the
graph is empty), the registered functions, and the Answer alternative; the fourth
ends the turn with `REPEATED_FAILURE_LOOP` and no answer. A successful call, a
different failure, a graph change, or a new user turn resets the count. Failed
and stopped turns retain the token usage reported by their recorded model steps.

## Graph declarations

```text
set records: scan(files='data/example.csv')
set adjusted: adjust_values(records, factor=2)
set summary: aggregate(adjusted, outputs={'total': sum('value')})
delete unused
```

The call head is a built-in type or registered public synchronous function.
Positional arguments are ordered graph input IDs; settings are keyword literals.
Sources have zero inputs; custom functions support one or more table inputs,
including variable arity. Each output is one DataFrame. An input ID and function
name may coincide without ambiguity. Documented descriptors are also accepted in
the spellings models produce: a quoted dtype name such as `'float64'`, a bare
`predicate=keep`, and `preview=True` (one row); unknown names remain errors. A
nested operator call is rejected with the instruction to declare it as its own
`set` statement.

`set` replaces the complete definition, incoming edges, settings, and explicit
`doc` override. Omitted settings reset to defaults. Consumers retain their input
ID. Each ID occurs at most once per edit; forward references resolve against the
final acyclic graph. Delete or rewire a deleted node's consumers in the same edit.

## Shared definitions and isolated invocation

`edit.python` appends an authored cell, unless it is identical to the current
last cell: replaying the same cell twice yields the same namespace, so resending
unchanged source neither appends nor invalidates custom results. The session stores ordered source cells,
registered signatures/docstrings, binding descriptions, and namespace identity
with the workflow, including when no operators exist. Later cells see earlier
imports, constants, helpers, classes, and functions and may replace them.

Every operator invocation reconstructs a fresh namespace from these cells.
Global mutations and mutable defaults from a prior invocation are not session
state. Operators exchange computed tables through graph edges. Ordinary Python
default binding follows cell order; changing a later global does not rewrite an
earlier function's captured default.

The initial implementation accepts imports, plain synchronous functions/classes,
docstrings, and deterministic name/literal-based constants. Definition-time calls,
decorators, inherited/metaclass initialization, and top-level control flow or I/O
are rejected; put dynamic initialization and data operations inside functions.
Function bodies support ordinary Python. Registration runs in a bounded
subprocess, not the agent process. This is not an OS security sandbox; imported
module initialization is not a guarantee of transactional external side effects.

A Python edit conservatively invalidates all custom operators, measured filters, and their
consumers. It never executes the graph automatically. A graph edit invalidates
changed computations and descendants. Documentation-only metadata changes
preserve numerical results. Function replacement revalidates every retained
custom invocation against its new signature, allowing an incompatible node to
be fixed or deleted in the same atomic edit.

Public top-level functions can be called as custom table operators or named as
predicates for the measured `filter` built-in. Helpers beginning with `_`, imports,
classes, and constants remain definitions, not graph types. Built-in names and
the retired `map` and `process` wrappers are reserved. Runtime code may
continue using the internal Process engine adapter without exposing it to models.

Table statistics summarize explicitly retrieved operator outputs alongside
small samples. Flow evidence exposes measured built-in runtime behavior even
when an intermediate table is not retrieved: execution receipts show each
executed operator's own counters, and retrieval follows producing input versions
to add bounded ancestor summaries. Traversal can cross custom functions, while
preserving that row/column correspondence across them is unknown. Measured
`filter` supplies retained/rejected/null-predicate counts and bounded rejected-value
frequencies. Filtering hidden inside an unrestricted table function does not;
custom pandas joins/conversions likewise do not inherit built-in join/cast
measurements. See [retrieval views](retrieval-views.md) for the current
settings, budgets, and coverage limits.

## Documentation and receipts

Document specialized behavior regardless of whether it uses a built-in or Python.
Function docstrings describe reusable behavior; node `doc` describes task-specific
purpose when needed. Description precedence is explicit doc, current function
docstring, then generated built-in summary. `doc` is metadata, never forwarded as
a function argument. Avoid redundant descriptions for routine scans/sorts.

Observations use Markdown, grouped by action number and status. Successful edits
name registered or updated functions, changed operators and their types, and added
or removed edges. After a change, affected results are named with an instruction
to execute before retrieving. Execution reports completed results, failures, and
operators that did not run. `Completed` means a current result is available; engine
reuse counts and cache states remain internal telemetry. Retrieval returns one
block per operator ID with coverage captions and enabled statistics. Errors name
the action and relevant operator, declaration line, or Python source location;
an edit failure explicitly confirms that none of that edit was applied.
Documentation states intent; it does not prove measured correctness.

On this branch, default native DELTA context preserves model-message roles: user
requests use `user`, model calls use `assistant`, and tool observations use `tool`
with the matching call ID. The internal trace groups calls and results in an
`agent` step; that is a storage label, not a model-message role. Vercel AI SDK
handles native tool calling while our context assembler reconstructs history and
formats observations before each request. Other layouts, such as LATEST's state
summary, may place environment summaries in user-role messages.

## Built-ins and source reading

Thirteen built-ins are available: scan, filter, project, cast, aggregate, join,
union, distinct, sort, limit, window, unpivot, pivot. Custom table functions
replace the old map/process wrappers; filter names a registered predicate instead
of accepting inline Python. Cast uses `columns={name: dtype}`;
aggregate and window use `outputs={name: specification}`. These mappings allow
column names such as `doc`, `by`, or `errors` without colliding with settings.

The [generated reference](../native-mode/OPERATORS.md) contains signatures and
contracts. The prompt includes a short signature and description per built-in;
reference inspection supplies rarer options. Existing reader parameters remain
supported rather than silently changing data interpretation.

A normal scan loads the source; retrieve bounds what is shown to the model.
`preview` is optional layout diagnosis before parsing, not an ordinary data sample.
Text previews show raw lines, Excel/HTML previews show sheet/table rows, and
Parquet/specialized binary previews show metadata. A preview cannot stand in for
the full population. Full scans support CSV/TSV, raw/fixed-width/whitespace text,
Excel, HTML tables, tabular JSON/JSONL, and Parquet. Unsupported layouts use a
custom loader. Format argument enums are distinct from file extensions.

`comment` belongs in the detailed text-reader reference: pandas-backed delimited
and inferred fixed-width readers ignore text from the marker onward, while the
explicit-width fixed-width reader skips marked lines. It is not a universal
setting for binary, JSON, Excel, or Parquet readers.

### Measured filtering

Register a row predicate in `edit.python`:

```python
def keep_adult(row, *, minimum=18):
    """Keep rows whose recorded age meets the threshold; missing ages have no verdict."""
    return None if row["age"] is None else row["age"] >= minimum
```

Declare its operator in `edit.changes`:

```text
set adults: filter(people, predicate="keep_adult", settings={"minimum": 21})
```

The predicate receives a read-only row mapping, with missing cells represented
as `None`. Only boolean or scalar missing verdicts are accepted: True keeps the
row; False or null drops it. Integers, strings, arrays, and Series fail the
contract. The output preserves input columns and retained row order. Settings
bind as keyword arguments and are validated when the edit commits. One fresh
namespace serves all rows of an invocation; later invocations start fresh.

The engine counts retained rows, rejected rows, and null verdicts. Rejected rows
include null-verdict drops. With collection enabled, it also counts source values
among all rejected rows for up to eight columns read by the predicate. Each
column retains three first-encountered distinct values and an `otherCount`, with
null distinct from the string `"null"`. Conditional column reads do not restrict
this population. These are bounded distributions, not causes or top frequencies.
Unrestricted table functions still return DataFrames and remain semantically
opaque to this filtering contract.

## Inspection

| Target | Output |
|---|---|
| graph | Compact operator IDs, types, ordered inputs, and freshness; optionally select IDs. |
| operator | Complete instance definition, description, consumers, and a compact current result schema/status; optionally authored implementation. |
| schema | Exact column names and types from a current completed result, independent of sample/profile column limits; paginated. |
| source | Retained scan source paths, workbook sheet names, and first raw preview rows where available; never reads files. |
| namespace | Registered definitions, including unused functions and helpers; select names to request source. No runtime locals or arbitrary object evaluation. |
| reference | Selected built-in contracts, defaults, reader options, and restrictions. |

Inspection reads stored current metadata without invoking authored functions.
Schemas come only from current materialized results. A function's direct graph
users are navigation metadata, not a complete static Python dependency graph.
The current registered tool does not expose historical task/state restoration
syntax; old parser/tool helpers remain for recorded fixtures and replay.

For a wide table, use `{"type":"inspect","target":"schema","operator_id":"records"}`.
The default page contains up to 200 columns; pass `offset` and `limit` (1–200)
and follow `next_offset` for more. Names are exact JSON strings, including spaces.
A 20,000-character page budget may reduce the count; individual names are never
split. Missing, failed, and stale results report their status rather than an old
schema.

For workbook discovery, batch `scan(files=..., preview=1)`, execute, then inspect
`target:"source"` in one call. Source inspection has the same pagination
parameters and labels known-only sheet lists and clipped/missing raw rows.
Raw rows are layout hints, not parsed schemas. Execute a normal scan of the
selected sheet, then inspect its schema for exact names and types.

## Execution measurements

Saved execution receipts retain `execution_runs` with compilation outcome,
compilation duration, and runtime-start status when the engine reports them.
These fields are not a complete end-to-end phase breakdown.

With profile collection enabled, successful native results also retain
`native.operations.timing.operatorBodyMs`: operator work, definition replay,
source I/O, and built-in counters, excluding input/output validation and table
profiling. `filterRejectedValuesMs` separately measures the rejected-value pass
and is excluded from `operatorBodyMs`. Profile `cost.collectionMs` measures
column/row collection; optional `cost.snapshotMs` measures construction of the
immutable profile summary. Neither includes JSON encoding/trimming, transfer,
or persistence. Absent measurements remain unknown. Cached results retain the
measurements of their producing execution; these are not cache-lookup timings.

## Prompt and validation

The active source is
[the prompt template](../agent-service/src/agent/prompts/native-registered.md).
It teaches role, resources, Dataflows, function examples, and general synthetic
workflows. Examples contain no benchmark-specific questions or answers. Enabled
retrieval views and evidence settings control the rendered guidance.

Generate `native-mode/` with `cd agent-service && bun run render:native-reference`.
The standalone design prompt is the same default rendered text. The earlier
single-example byte budget is superseded by the requested fuller teaching prompt;
benchmark artifacts must report actual prompt/tool input tokens and usage.

The engine's static UDF scan (`PythonOperatorDescriptor`, `udf.conf`
`python.allowFileIO`) rejects operator code containing a bare `open()`, `Path()`
or `import os`. Every custom operator embeds all definition cells, so one such
cell fails every custom operator, including ones that ran before. Deployments
that run registered loaders must set `UDF_PYTHON_ALLOW_FILE_IO=true`; the
benchmark stacks rely on the bubblewrap sandbox instead of that scan.

Validation includes parser/binding and namespace-isolation tests, atomic edit and
snapshot tests, mixed-success retrieval, documentation-only cache preservation,
valid tool envelopes for prompt examples, and generated-reference drift checks.
The end-to-end pilot uses the same repository launcher and KramaBench harness,
with raw traces retained and model-specific pricing explicitly sourced or marked
unknown. A small pilot establishes integration behavior, not benchmark-wide quality.

The [2026-10-08 pilot report](../benchmark/retrieval/results/20261008-registered-python-pilot/REPORT.md)
records all 18 original attempts, the confirmed provider schema incompatibility,
and six successful validation reruns after its correction. The
[engine probe](../benchmark/retrieval/results/20261008-registered-python-engine/README.md)
retains actual Markdown observations from ten deterministic checks.

## Follow-up checklist (2026-10-08)

Goal: reduce **cost per correctly completed task** by avoiding unnecessary model
calls and tokens, while preserving accuracy, useful diagnostics, and deterministic
execution. Unchecked items are follow-up work or explicitly labeled experiments;
they do not change the current contract. Checked items describe local changes,
not a claim that they have been committed or deployed.

### Completed local cleanup

- [x] Remove cache counts and cache-state labels from ordinary observations;
  retain internal telemetry. Describe current results as completed.
- [x] Remove the redundant action-batch status prefix and improve edit-error
  attribution to declaration lines and operator IDs.
- [x] Update prompt guidance and generated references for that cleanup; validate
  with unit tests, type checking, and reference-drift checks.

### Completed 2026-10-09 (before the Luna/Terra campaign)

- [x] Repeated-failure protection (`native/failure-loop.ts`), replacing the
  narrower empty-execution guard of `feat/context-improvement`: identical failed
  calls against an unchanged graph get one correction after two and end the turn
  after four; usage is retained. The audited Qwen `execute *` ×20 and `retrieve r`
  ×22 loops and DeepSeek's execute-only loop are all this shape.
- [x] Accept the spellings that cost repair calls: quoted dtypes, bare
  `predicate=name`, `preview=True`; name the repair for nested operator calls;
  reject stringified `actions` with an array example (Opus).
- [x] A definition cell identical to the current last cell is not appended, so
  resent source does not invalidate every custom result.
- [x] Campaign defaults: full-result display cap 5,000 and sample budget 1,000
  (`run.py --full-result-char-limit`, `--sample-char-limit`); OpenRouter serving
  providers pinned in the gateway configuration (`extra_body.provider.order`, no
  fallbacks: DeepInfra first; fp4 routes excluded); the benchmark database drops
  `idx_workflow_pgroonga`, whose tokenizer refused workflows above ~1.8 MB.

### P0 — Prevent avoidable calls and repair loops

- [ ] Investigate empty/malformed action envelopes on the affected provider routes.
  Distinguish provider/schema issues from model authoring mistakes before changing
  the protocol; do not count transport retries as new model decisions.
- [ ] Unregistered function names still need a one-call repair path; measure their
  frequency in the full run before adding guidance.
- [ ] Teach recovery from parsing/conversion failures: inspect the relevant input
  and test normalization before retrying. Avoid repeated coercion or row dropping
  that merely hides the original data problem.

### P1 — Keep context compact and attributable

- [ ] Finalize one Markdown observation per ordered action batch. Preserve native
  `user`, `assistant` tool-call, and matching `tool` result roles; the trace's
  internal `agent` label must not be confused with a provider message role.
- [ ] Show action number/status, registered or updated function names, operator
  IDs/types, and changed edges. Include input positions when edge order matters.
  Keep submitted code in the assistant call rather than routinely echoing it.
- [ ] Report which operator results are ready, failed, or not run. Bound long
  success lists while preserving requested targets and failures; wording must not
  imply that every available result was physically recomputed.
- [ ] Give each retrieved result its operator ID, view, schema, and row/column
  coverage. Preserve truncation and preview notices; trim repeated definitions,
  status lines, and other details that do not help interpret the table.
- [ ] Keep result-table statistics and flow evidence distinct, with independent
  budgets. Do not repeat facts already fully shown in a small result table.
- [ ] Deduplicate the same execution error within a batch by referring to its
  earlier action. Errors returned in a later call must remain understandable on
  their own.

### P1 — Make Python failures easier to debug

- [ ] Surface the authored definition cell, function, cell-relative line number,
  and failing source line. Add source excerpts and a caret for syntax errors.
- [ ] Retain the exact failed definition version for diagnostics; inspecting the
  current function after an edit must not substitute for the code that failed.
- [ ] Use a bounded source excerpt, with additional source available on demand.
  Avoid default full-function/library-traceback repetition and explicitly mark
  truncation. Infrastructure failures may legitimately have no user-code line.

### P1 — Guide operator choice and documentation

- [ ] Prefer built-ins for equivalent supported operations and compose known
  chains in one edit/execute/retrieve batch. Use Python for specialized loading,
  parsing, or calculations; do not force extra operators just to increase the
  built-in share. Preserve ties, null handling, cardinality, and numeric semantics.
- [ ] Retrieve multiple needed outputs together. Reserve a new model call for
  decisions that actually depend on those outputs.
- [ ] Request concise docstrings for registered functions/predicates and optional
  node `doc` for task-specific meaning, including specialized built-ins. Omit
  boilerplate for obvious operators; missing prose alone should not reject an edit.
- [ ] Keep precedence explicit: node `doc`, current function docstring, then
  built-in summary. Verify inherited descriptions follow function revisions and
  documentation-only edits preserve results. Show descriptions when added,
  changed, or inspected rather than repeating them on every execution/retrieval.

### P1 — Preserve safe partial progress

- [ ] Retain atomic edits: one failed edit applies none of its changes; earlier
  successful edits remain. Do not execute dependent actions against the old graph
  as though the rejected edit succeeded.
- [ ] Verify that an execution failure still permits requested independent
  executions and inspection/retrieval, with outcomes per target. A skipped edit
  must block later execution that could silently use its unapplied changes.
- [ ] Evaluate allowing independent reads after a read-only action fails. Keep
  this separate from relaxing failed-edit behavior: in the audited comparison,
  all five failed edits' skipped execute/retrieve pairs depended on rejected nodes,
  so continuing those pairs would not have saved useful work.

### P2 — Align the prompt and measure the benefit

- [ ] Apply the chosen guidance to the
  [prompt source](../agent-service/src/agent/prompts/native-registered.md), then
  regenerate the [rendered prompt](native-registered-python-system-prompt.txt)
  and native references. Fix stale built-in counts and retired-operator wording
  in reference generation.
- [ ] Use general synthetic examples for custom loading, one/multiple table
  inputs, settings, isolated invocations, function replacement, and error repair.
  Keep examples independent of benchmark tasks and validate their tool envelopes.
- [ ] Add focused regression coverage for message roles/call IDs, error identity
  and source versions, partial results, failure sequencing, and retrieval without
  execution. Run the relevant service tests and reference checks.
- [ ] Compare changes on matched tasks across the models, with fixed revisions,
  routes, settings, and repeated trials. Change one factor at a time; hold data
  statistics and flow evidence settings fixed unless they are the experiment.
- [ ] Report correctness, completion, repair calls, API requests, model decisions,
  and tool actions separately. Include failed attempts in cost per correct task.
  Separate uncached input, cache reads/writes, output, and reasoning accounting
  without double counting; distinguish provider-reported cost from estimates and
  leave missing usage unknown. Context characters are not token measurements.
- [ ] Count final built-in/custom operators separately from attempted declarations
  and revisions; identify built-ins using Python predicates as hybrid behavior.
  Treat operator mix and cache-hit rate as diagnostic measurements, not success
  criteria. The audited 24-attempt context comparison had 113 built-in and 15
  custom final nodes, but does not establish that increasing the built-in share
  causes lower cost or higher accuracy.
