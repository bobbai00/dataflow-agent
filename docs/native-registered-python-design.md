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

The agent has one tool, `dataflow(python, statements)`. `python` registers or
replaces Python definitions; `statements` declares a graph of built-in and
custom operators with `set` and `delete`, then computes and reads it with
`execute` and `show`. A reply without a tool call is the answer. Stored call
results carry the protocol name `registered-python-v1`.

This document is the contract as `agent-service/src/agent/` implements it.
How results, statistics and runtime stats are displayed is in
[retrieval views](retrieval-views.md); sessions of dependent requests are in
[several requests in one session](native-multi-request-design.md).

## Generated reference

`cd agent-service && bun run render:native-reference` writes the model-facing
text into [`native-mode/`](../native-mode/); `native/native-reference.test.ts`
fails when those files are stale.

| File | Content |
|---|---|
| `SYSTEM_PROMPT.txt` | the system prompt, rendered with the prompt builder's own defaults |
| `SYSTEM_PROMPT_WITH_EVIDENCE.txt` | the same with `flowEvidence` on, which adds the runtime-stats paragraph |
| `SYSTEM_PROMPT.md` | `SYSTEM_PROMPT.txt` wrapped for reading |
| `TOOLS.md` | the tool's description and JSON schema |
| `OPERATORS.md` | every built-in's full contract, as `show builtin` returns it |

The prompt template is
[`prompts/native-registered.md`](../agent-service/src/agent/prompts/native-registered.md).
`buildRegisteredNativeSystemPrompt` in `prompts.ts` fills its fields from the
session's settings, the built-in index from `native/registered.ts`, and worked
examples that `prompts/registered-examples.ts` renders with the real parser and
receipt renderer, so prompt, parser and receipts cannot drift apart. A default
agent's prompt differs from `SYSTEM_PROMPT.txt` only in the sample row count:
it says 3 (`maxResultRows`) where the file says 50.

## The tool

`tools/turn-tool.ts` defines the tool: two strings, both required, strict
schema. With `optionalPython` (Claude models only) `python` may be left out.

| Statement | Effect |
|---|---|
| `set <id>: <op>(<inputs>, <key>=<value>, ...)` | create or fully replace an operator |
| `delete <id>` | remove an operator |
| `execute <id>, ...` | compute the operators and their ancestors; `execute` alone computes the whole graph |
| `show result <id>, ... [view]` | compute what is stale, then show each result in one view |
| `show result <id>[<col>, ...] [view]` | the same for one operator, selected columns only |
| `show schema <id> [from <index>]` | compute if needed, then page exact column names and types, 200 per page |
| `show operator <id>` | the operator's statement, inputs, consumers, description and result status |
| `show function <name>, ...` | registered definitions with their source, read from storage |
| `show builtin <name>, ...` | built-in contracts |

`native/turn-syntax.ts` turns a call into an action list: one edit holding the
definitions and every `set` and `delete` line, then the requests in the order
written (`show result` and `show schema` are an execute followed by a read).
The parser accepts what models predictably send: a field wrapped whole in a
Markdown fence is unwrapped, a ```` ```python ```` fence or an unfenced
`def`/`class`/`import` block inside `statements` moves to the definitions, and
other prose lines are ignored and named in the receipt. `answer:` and
`Final Answer:` lines are rejected; there is no answer statement. A
`show result` that names a view the session does not offer rejects the whole
call before anything runs.

### How a call runs

`tools/dataflow-actions.ts` runs the actions in order, and
`tools/dataflow-action-runtime.ts` resolves each one against the step's
snapshot.

- Definitions register before any statement runs, and the edit is atomic: one
  rejected line rejects all of it. The receipt names the line (counted in
  `statements`) and the functions the edit would have registered, and the rest
  of the call is skipped.
- After a failed execution, later executions and reads still run, so results
  that completed can be read. After any other failure the rest is skipped.
- A `show result` over several operators reports each one separately; a
  missing, failed or stale target does not hide the others.
- Several `dataflow` calls in one response run as one call: every call's
  definitions register first, the `set` and `delete` lines apply together, then
  the requests run in call order. Identical repeated calls in a response are
  dropped.

An execution sends the targets' ancestor graph to the engine as a synchronous
request (`tools/workflow-execution-tools.ts`). Targets whose ancestor sets are
disjoint run as separate engine executions, so a failure in one does not stop
the others. Operators that share an ancestor run in one execution, which the
engine stops at the first failure; the receipt reports the rest as `not run`
and says whether they read from the failed operator. The engine reuses
unchanged results from its [port cache](operator-port-cache.md). Each result
arrives in the response, up to 100,000 characters and 20,000 per cell, with its
table profile when profiles are collected. Reads render from what the agent
holds and never execute.

### Receipts

The receipt (`native/turn-receipt.ts`) is the tool result: one Markdown message
with a section per statement, in the order written.

- `## edits applied` names registered or updated functions, created, updated
  and deleted operators, and the results the edit made stale (`stale until
  executed: ...`). A rejected edit is `## edits rejected` with the line and
  `No edit applied; resend the corrected call.`
- `## execute ...` and `## show result ...` name the operators that ran
  (`executed: ...`, `failed: ...`, `not run: ...`); a show lists the target's
  executed ancestors under `upstream:`, then the result. Operators whose
  results were current, or came from the engine's cache, are not listed as
  executed.
- `## show schema|operator|function|builtin ...` returns what was asked.
- Errors carry a code (`EDIT_REJECTED`, `UNKNOWN_OPERATOR`, `UNKNOWN_COLUMN`,
  `RESULT_STALE`, `RESULT_NOT_RUN`, `RESULT_FAILED`, `EXECUTION_TIMEOUT`, ...)
  and name the statement and the operator, declaration line or Python source
  location.

Execute outputs also keep `execution_runs`, one record per engine request with
its targets, execution ID, state, the engine's compilation phase
(`phaseMetrics`) and client timings. The receipt never shows them; they are
trace telemetry.

## Answers and turn control

Tool choice is `auto`. A reply without a tool call is the answer, returned
verbatim, once a `show result` has succeeded: anywhere on the conversation's
branch, or within the request itself when `multiRequest` is on. The agent
steers a turn with corrections, user-role steps marked
`messageSource: "correction"`:

| `correction` | When | What it says |
|---|---|---|
| `missing-action` | a reply without a tool call before any result was shown | a first call to make, with a file path taken from the request |
| `cut-off` | a reply cut off at the output limit | reply again, briefly |
| `step-budget` | 3, then 1, model calls remain of `maxSteps` (default 100) | finish with what has been shown |
| `repeated-failure` | two consecutive model calls failed identically against an unchanged graph and namespace | the error, the current operators (or that the graph is empty) and the registered functions |

A reply that names operators in a JSON object (`{"output.csv": "o1"}`) gets
those operators computed; if one still has no result, the reply is sent back
once (`native/named-results.ts`). That send-back and the `missing-action` and
`cut-off` corrections share a limit of two per turn. The fourth identical
failure ends the turn with `REPEATED_FAILURE_LOOP` and no answer
(`native/failure-loop.ts`); a successful call, a different failure, a graph
change or a new request resets the count. Failed and stopped turns keep the
token usage their model steps reported.

## Context

Before every model request the agent rebuilds the messages from the steps on
the current branch (`util/context-utils.ts`,
`context/summarize/native-frames.ts`); `contextMode` accepts only `"delta"`.
Requests and corrections are user messages. Each model step is an assistant
message with the model's text and its tool-call parts under their real call
IDs, followed by the receipt as the matching tool result. Receipts are rendered
again from the stored action results, whose observations were frozen when they
were read, so earlier messages stay byte-identical from one request to the
next and remain a cacheable prefix. A request sent with `contextTasks` sees the
task catalog instead of the earlier requests
([several requests in one session](native-multi-request-design.md)).

## Graph declarations

```text
set records: scan(files='data/example.csv')
set adjusted: adjust_values(records, factor=2)
set kept: filter(adjusted, lambda row: row["value"] is not None and row["value"] > 0)
set summary: aggregate(kept, outputs={'total': sum('value')})
delete unused
```

Here `adjust_values` is a registered function. The call head is a built-in or
a registered public function. Positional arguments are input operator IDs, in
order. Settings are keyword arguments: Python literals for registered
functions, and literals or the documented descriptors (dtypes, reducers,
window functions) for built-ins. A lambda is allowed only as a filter's
condition or a map's row function, and a join's tables may also be named
`left=` and `right=`. A nested operator call is rejected with the instruction
to declare it as its own `set` statement. `doc='...'` and
`is_visualization=True` are operator settings, never passed to a function. The
edit also accepts the spellings models produce for documented descriptors: a
quoted dtype (`'float64'`), a bare `predicate=keep`, and `preview=True` (one
row).

`set` replaces the whole definition: inputs, settings and `doc`. Omitted
settings return to their defaults, and consumers stay connected to the ID. An
ID appears at most once per edit, references resolve against the final graph,
which must be acyclic, and a deleted operator's consumers must be deleted or
rewired in the same edit.

An operator's description is its `doc`, else its function's docstring. With
`operatorDoc` on, the prompt asks for a one-line `doc` on every operator and
the receipt names operators set without one (`doc missing: ...`).

## Definitions and isolated invocation

`python` appends a definition cell to the session's namespace, which is stored
with the workflow as `nativeNamespace`: the ordered cells, each function's
signature, docstring and source, a description of every binding, and a
revision. A cell identical to the current last cell is not appended, so
resending unchanged source changes nothing. Later cells see earlier imports,
constants, helpers, classes and functions, and may replace them.

A cell may hold imports, plain synchronous functions, plain classes (no bases,
metaclasses or decorators), docstrings, and constants whose values involve no
calls, lambdas or comprehensions. Decorators, async functions, wildcard
imports, assignments to attributes or items, and top-level control flow or I/O
are rejected; dynamic work belongs inside functions. The built-in names and
the retired `process` are reserved. A parameter list that ends in a bare `*`
(`def load(*):`) is read as "no settings". Parsing and validation run in a
Python subprocess with a 10-second limit (`runNativePython` in
`native/codegen.ts`; the rules are in `native/python/registered.py`), not in
the agent process. This is not a security sandbox: importing a module can run
its initialization.

Every operator invocation rebuilds a fresh namespace by replaying its cells, so
globals changed and mutable defaults filled by one run never reach the next;
tables pass between operators only through edges. A filter's or map's lambda
gets one namespace per invocation, shared by all its rows. Python default
binding follows cell order: replacing a constant in a later cell does not
change a default that an earlier function captured.

Public top-level functions become operator types. A function takes one pandas
DataFrame per input edge (none for a loader) and keyword settings (by
convention keyword-only, after `*`), and returns one DataFrame with unique
string column names and scalar cells; a chart function set with
`is_visualization=True` returns HTML instead. Names that start with `_`,
imports, classes and constants stay definitions. Settings are bound against
the function's signature when the edit commits. Internally a custom-function
operator has type `Process` and a `registeredName`. A Texera dataset path
(`/owner/dataset/vN/file`) named in a `scan` or in a function setting is
resolved at execution to a download link, and the worker reads a local copy
(`tools/dataset-files.ts`).

## Invalidation

Registering definitions never executes the graph. An operator's result goes
stale only when its own computation changed:

- A `set` that changes an operator's definition or inputs makes it and its
  descendants stale. A change to its `doc` alone, or to the formatting of its
  `set` line, keeps its result (`operatorPredicateEqual` in
  `workflow-snapshot-storage.ts`).
- A Python edit makes stale the custom functions, filters and maps whose
  function or lambda reaches a changed definition by name, transitively through
  the functions, classes, constants and imports it uses, plus their
  descendants (`dependencyRevision` in `native/registered.ts`). The name
  analysis over-approximates, so it can re-run more, never less. An operator
  whose definitions did not change keeps its compiled cells byte for byte, so
  its result and the engine's cache entry stay valid.
- Replacing a function revalidates every registered operator against the new
  signature in the same atomic edit, so an incompatible operator can be fixed
  or deleted in that edit.

## Built-ins

Fourteen built-ins (`REGISTERED_OPERATOR_NAMES`): `scan`, `project`, `cast`,
`filter`, `map`, `aggregate`, `join`, `union`, `distinct`, `sort`, `limit`,
`window`, `unpivot`, `pivot`. Their contracts are in
[`native-mode/OPERATORS.md`](../native-mode/OPERATORS.md); the prompt lists a
short signature and summary of each, and `show builtin` returns the full
contract. `cast` takes `columns={name: dtype}`, and `aggregate` and `window`
take `outputs={name: specification}`, so a column may be named `doc`, `by` or
`errors` without colliding with a setting.

- `filter(t, lambda row: condition)` keeps the rows for which the condition
  returns True; False or a missing verdict (None) drops the row, and any other
  return value fails the operator. The row is a read-only mapping with missing
  cells as `None`. A condition reused with different values can be a registered
  predicate with settings: `filter(t, predicate="keep", settings={"minimum": 21})`.
- `map(t, lambda row: {**row, "new": value})` turns each row into the dict its
  lambda returns: one output row per input row, the same keys in every row.
- Both lambdas can call registered functions, and a Python edit re-runs them
  only when a definition they name changed.
- `scan` reads CSV/TSV, raw lines, fixed-width and whitespace text, Excel, HTML
  tables, tabular JSON/JSONL and Parquet; other layouts need a registered
  loader. `preview=n` (1 to 200) returns raw layout or file metadata for
  diagnosing a source, not a sample of the parsed table. A full scan of a
  workbook lists its sheet names in the receipt, and `scan(..., sheet='name')`
  reads one.

With profile collection on (the default), the runtime
(`native/python/runtime.py`) records what each operator did in the table
profile's `native.operations`: a filter's kept, rejected and null-verdict
counts and the columns its condition read, a join's matched and unmatched rows
and keys per side, a cast's conversion failures, and, inside custom functions,
the pandas reads, merges, row selections and concatenations made from the
function's own lines. It keeps a few examples with them: rejected filter
values and join keys that match only when written alike, values a cast could
not convert.
[Retrieval views](retrieval-views.md#runtime-stats) describes which of these
reach the model as runtime stats.

### Registered loaders and file I/O

A loader is a registered function with no table inputs. Operators without
inputs compile to Texera's `DataLoading` operator and all others to
`DataProcessing` (`native/codegen.ts`). When `python.allowFileIO` in
`common/config/src/main/resources/udf.conf` is false (the default), the
engine's static check (`PythonCodeValidator` in
`common/workflow-operator/src/main/scala/org/apache/texera/amber/operator/PythonOperatorDescriptor.scala`)
rejects `DataProcessing` code that contains `open(`, `Path(`, `.read(`,
`.write(` or an import of `os`, `pathlib`, `io`, `shutil`, `subprocess` or
`glob`. A custom function's, filter's or map's compiled code embeds the
definition cells it was compiled with, so a loader cell that calls `open()`
makes every such operator created or changed after it fail that check, though
the loader itself runs. Deployments that use such loaders set
`UDF_PYTHON_ALLOW_FILE_IO=true`; the benchmark stack profile
(`benchmark/campaign/stack/profile.sh`) does, and relies on its bubblewrap
sandbox instead.

## Settings

The settings a client can send are `AGENT_SETTINGS_SCHEMA` in
`agent-service/src/server.ts`; their defaults are `DEFAULT_AGENT_SETTINGS` in
`agent-service/src/types/agent.ts`. Any other key is refused with HTTP 400
`<key> is not a setting`. Besides the retrieval and evidence settings
([retrieval views](retrieval-views.md#settings)) and `multiRequest`
([several requests](native-multi-request-design.md)), these change the
protocol:

| Setting | Default | Effect |
|---|---|---|
| `maxSteps` | 100 | model calls per turn |
| `executionTimeoutMinutes` | 4 | per engine execution |
| `operatorDoc` | false | ask for a `doc` on every operator; receipts name operators set without one |
| `optionalPython` | false | `python` may be left out of a call; refused for non-Claude models |
| `pandasRound` | false | `round(x, n)` in definitions and lambdas rounds floats as pandas does |
| `answerOnlyReply` | false | the prompt asks for a final reply that holds only the requested answer |
| `instructions` | `""` | text appended to the system prompt under `## Instructions for this session` |

## Tests

In `agent-service/src/agent/`: `native/turn-syntax.test.ts` (parser),
`native/turn-receipt.test.ts` (receipts), `native/registered*.test.ts`
(registration, built-ins, filter, map, accepted spellings, prompt),
`tools/turn-tool.test.ts`, `tools/registered-dataflow-actions.test.ts`,
`tools/registered-dataflow-runtime.test.ts` and
`tools/registered-inspection.test.ts` (calls resolved by the action runtime
against a stubbed engine), `native/repeated-failure-loop.test.ts`,
`native/duplicate-tool-calls.test.ts`, `native/named-results.test.ts`, and
`native/native-reference.test.ts` (the generated reference).
`agent-service/benchmark/e2e/dataflow-actions-run.ts` checks calls against a
running agent and the Texera backends.
