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
name may coincide without ambiguity.

`set` replaces the complete definition, incoming edges, settings, and explicit
`doc` override. Omitted settings reset to defaults. Consumers retain their input
ID. Each ID occurs at most once per edit; forward references resolve against the
final acyclic graph. Delete or rewire a deleted node's consumers in the same edit.

## Shared definitions and isolated invocation

`edit.python` appends an authored cell. The session stores ordered source cells,
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

Successful edits produce Markdown receipts including `function name registered`
or `function name updated`, operator/edge changes, and invalidations. Execution
reports completion, reuse, and errors. Retrieval returns one labeled result block
per target with coverage captions and enabled statistics. Documentation states
intent; it does not prove measured correctness.

### Iteration history

Flat native DELTA uses `messageLayout: "markdown"` by default. Each completed
iteration becomes one environment report with ordered actions. Python source and
graph declarations are decoded from the saved request and shown once beside the
matching outcome: registration, operator and edge changes, execution status,
retrieved tables, statistics, or errors. Failed and skipped edits retain their
attempted code and explicitly say it was not applied.

Reports use the request and receipt frozen at that iteration; later edits never
rewrite earlier history. Requests and receipts match by tool-call ID. Missing
or ambiguous receipts mark the outcome unconfirmed; malformed receipts retain
the original payload for diagnosis. Markdown fences protect source text containing
headings or backticks.
Context assembly uses typed records, not a parser over rendered Markdown.

Real user requests remain user messages and final answers remain assistant
messages. Environment reports are labeled user-role context records, rather than
fabricated provider tool exchanges. The system prompt explains their purpose and
instructs the model to continue calling `dataflow`. Raw tool calls and receipts
remain available in the trace API for replay and auditing.

Ordinary context budgets retain their existing sliding-window or checkpoint
policy and count the rendered reports. Explicit `messageLayout: "native"` selects
the previous tool transcript. Code mode, LATEST, and advanced legacy context
policies retain their existing defaults; an explicit incompatible Markdown
configuration is rejected before it changes the agent. This separates formatting
from experiment-specific history selection.

Checkpoints retain registered Python cells in order, including functions not yet
used by any operator. They retain earlier retrieved results only while the saved
materialization still matches; edits or a newer unrequested execution cannot
inherit those observations. A large namespace can exceed the existing soft
context target rather than silently lose definitions.

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
