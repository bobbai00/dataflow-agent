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

# Native mode: editing a dataflow graph

Native mode exposes one `dataflow(reasoning, actions)` tool. The model edits
operator definitions and edges, explicitly executes the graph, and retrieves
stored results. The service compiles catalog operators to Python for the engine.
Code mode continues to expose free Python operators through its existing tools.

The generated references are the source of truth for the public interface:

- [Exact system prompt](../native-mode/SYSTEM_PROMPT.txt)
- [Tool schema](../native-mode/TOOLS.md)
- [Every operator, its parameters and ports](../native-mode/OPERATORS.md)

## Actions

| Action | Arguments | Result |
|---|---|---|
| Inspect task branch | `target: "task"`, `task_id`; optional `operator_id: null` or named roots, `include_implementation`, `view` | Original question/answer, local answer computation and versioned earlier-input references; optional local Python and selected root results |
| Declare answer sources | `type: "answer"`, `content`, optional `operator_ids` | Records completed answer tables as retrieval roots; an answer with `from` records these automatically |
| Inspect graph | `target: "graph"`, `operator_ids` | Named current operators, direct input references, ports, result shapes and unconnected inputs; single-task sessions also allow an unscoped graph read |
| Inspect operator | `target: "operator"`, `operator_id`, `include_implementation` | Definition, ports, connections and optional Python implementation |
| Edit | `changes` | Applied change count, automatically deleted edges, unconnected inputs and invalidated results |
| Execute | none | Completed operator count, errors and diagnostics; valid cached results can be reused |
| Retrieve | `operator_id`, `view` | Existing records as `full`, `sample`, or `sample_stats`, with automatic flow evidence when enabled |
| Answer | `content` | Final response; ends the loop |

The complete request is validated before actions begin. Actions run in order,
with one observation per action, including errors and skipped actions. A failure
skips later actions, except that Inspect and Retrieve may read independent
completed results after an Execute failure. Earlier completed actions remain.
Answer must be the only action in its call. Decisions that depend on a returned
observation belong in the next call.

If the model stops with plain text before calling Answer, the agent records one
feedback message asking it to continue through `dataflow`. This continuation
uses the remaining model steps in the same turn and retains the billed usage
from both requests. Feedback stays in chronological order so the original task
and context prefix remain intact. A step limit, refusal, or aborted turn does
not trigger this correction.

Successful edits and executions return short acknowledgments in the model's
context. Full operator receipts remain in the saved trace. Retrieve provides
row counts and tables; execution does not repeat every successful operator
from earlier tasks. Errors and enabled checks remain visible immediately.

## Graph syntax

```text
create operator <id>: <operator>(parameters)
update operator <id>: <operator>(parameters)
delete operator <id>
create edge <source>.out -> <target>.<input_port>
delete edge <source>.out -> <target>.<input_port>
```

Identifiers contain letters, digits and underscores and start with a letter or
underscore. Create requires a new ID; Update requires an existing one. Update
supplies the complete definition, preserves the ID and all connections, and
resets omitted parameters to defaults. An incompatible definition is rejected.

Saved `modify operator` edits remain replayable as a legacy spelling. New calls
and observations use `update operator`.

Operator expressions contain parameters only; edges supply all input tables.
Delete automatically removes every incident edge and lists them in its receipt.
Consumers remain in the graph with unconnected inputs. Edges cannot be updated:
delete the old edge and create its replacement.

Commands are staged in order. Each Edit is atomic: a missing operator, invalid
parameter or port, occupied input, or cycle rejects all changes in that Edit.
Unconnected inputs are allowed during construction. Execute requires every
required input in its execution scope to be connected. A rejected Edit leaves
previous results valid.

To run one task's branch, use `{"type":"execute","operator_ids":["total"]}`.
This materializes `total` and every upstream dependency while leaving other
branches in the graph. Unrelated failed or unfinished operators do not block
the selected branch. Unknown, disabled or empty target selections are rejected.
Omitting `operator_ids` runs the whole graph. Retrieve continues to read existing
results and never executes. Results outside the selected scope retain their
existing freshness checks.

### Ports

Every operator has one output, `out`. An input accepts exactly one edge; an
output may feed any number of inputs, including both sides of a self-join.

| Operators | Input ports |
|---|---|
| `scan` | none |
| `project`, `cast`, `filter`, `map`, `aggregate`, `distinct`, `sort`, `limit`, `window`, `unpivot`, `pivot` | `in` |
| `join` | `left`, `right` |
| `union` | Consecutive `in[0]`, `in[1]`, …; at least two, at most 256 |
| `process` | One `in[i]` per function parameter, in parameter order; no parameters means a source |

### Example

```json
{
  "reasoning": "Count the source rows and check the result.",
  "actions": [
    {"type": "edit", "changes": "create operator source: scan(\"data/orders.csv\")\ncreate operator total: aggregate(n=count())\ncreate edge source.out -> total.in"},
    {"type": "execute"},
    {"type": "retrieve", "operator_id": "total", "view": "sample"}
  ]
}
```

To change the calculation while keeping the edge:

```dataflow
update operator total: aggregate(total_amount=sum("amount"))
```

Given another source named `replacement`, rewire explicitly:

```dataflow
delete edge source.out -> total.in
create edge replacement.out -> total.in
```

Deleting `replacement` now removes `replacement.out -> total.in` automatically.
The observation lists that removal and identifies `total.in` as unconnected.
Reconnect it before executing:

```dataflow
delete operator replacement
create edge source.out -> total.in
```

### Python implementations

Keep loading, deriving columns, filtering, joining and aggregation in separate
predefined operators. Each stage produces an independently retrievable table.
Build a known chain and its edges in one Edit, then execute and retrieve the
needed results.

Use `process` for one operation the catalog cannot express. A custom calculation
consumes connected tables; a source process loads an unsupported format and
returns its parsed table. Use predefined operators for subsequent transformations.
Filter and map receive one row; process receives one DataFrame per input and
returns one DataFrame. All three require a `doc` describing the output's meaning.

Keep a process at one independently reusable or revisable custom transformation.
Its `doc` should accurately name the output grain, calculation and important
assumptions, units or exclusions, and stay synchronized with the code. Return
complete working tables before downstream report sorting and limits. The
shared system prompt includes an executable sensor example; the
[task catalog design](observation-format/prior-task-operator-catalog-design.md)
specifies its presentation and cross-task reuse.

Process inputs use NumPy float columns with `NaN` for missing floats. This
avoids pandas 2.2 nullable-float ranking errors after `to_numeric`. Integer,
boolean, text and datetime columns retain their types; large integer IDs stay
exact. Each process receives its own copy of the inputs.

Functions are lambdas or complete definitions indented under the operator that
uses them. Helpers belong in the same block and imports belong inside functions.
There are no shared definitions between operators. Include required functions
again when updating an operator.

```dataflow
create operator correlation: process(fn=correlate, doc="Pearson correlation of x and y")
    def correlate(df):
        import pandas as pd
        return pd.DataFrame({"correlation": [df["x"].corr(df["y"])]})
create edge source.out -> correlation.in[0]
```

## Execution, results and caching

Only Execute runs the graph. Retrieve never reruns it and reports missing or
stale results explicitly. Editing a definition or incoming edge invalidates
that operator and its descendants; independent results stay available. The
engine can reuse valid upstream and independent results on the next Execute.

Each Retrieve selects `view="full"`, `"sample"`, or `"sample_stats"` from the
session's enabled choices. Samples and statistics have separate budgets;
automatic flow evidence has its own budget in every view. The observation
reports returned and total rows and columns, completeness, and the producing
result version. Switching views does not execute or change the cache key.
See [Retrieval views](retrieval-views.md) for settings and experimental controls.

DELTA context records the tool calls and ordered observations. Every retrieved
table is frozen at its observation's graph version. Later changes do not rewrite
that transcript, so successive requests preserve the existing message prefix.

## Implementation

### Optional prompt reference

`nativePromptDetail: "on_demand"` keeps the role, graph grammar, action effects,
observation semantics and historical-state instructions, while replacing the
full initial operator reference and tutorials with signatures and shorter
generic examples. The default remains `"full"`.

Retrieve a needed contract with
`{"type":"inspect","target":"reference","topic":"operators","operator_names":["join","process"]}`.
Retrieve a worked example with
`{"type":"inspect","target":"reference","topic":"example","example":"single"}`;
`statistics` and `history` examples require those session features. Examples
use the offered retrieval views. Reference reads never execute, edit the graph
or add analytical dependencies. Both prompt variants expose the same tools.
The reference comes from the same catalog and example templates as the full
prompt. [Rendered prompt](../native-mode/SYSTEM_PROMPT_ON_DEMAND_WITH_HISTORY.txt).

### Optional saved versions

Set `stateHistory: true` when creating a native agent to keep saved versions
across tasks. The default is `false`. All tasks continue on one graph, and
DELTA keeps the action transcript. Task numbers follow user request order,
starting at 1. When a task is answered, every operator with a completed result
is saved under that task's number and the boundary receipt lists what was
saved; the engine retains the exact materializations (`retain`), and a task
whose retention failed says so in its receipt (`RETENTION_FAILED`,
`RETENTION_UNAVAILABLE`) instead of promising results it cannot serve.

`scores` names the current operator and `scores@2` the version saved at the
end of task 2: its definition, its inputs as they were then, and its result.
A version is read-only. The public actions in such a session are `edit`,
`execute` (named operators and their ancestors), `read` and `answer`:

| Use | How | Result |
|---|---|---|
| Read a version | `read` with `operator_ids: ["scores@2"]`; `view: null` for definitions only, a result view for its saved records; `columns` narrows them | The saved definition, direct inputs, shape and records; never executes |
| Connect a saved table | `create edge scores@2.out -> comparison.in[0]` | The engine binds the retained materialization through a hidden handle; no ancestors are copied or executed; an evicted result fails with `HISTORICAL_RESULT_UNAVAILABLE` |
| Make an old rule current | `update operator scores from scores@2` | The task-2 definition on today's inputs; the receipt names inputs that changed since then; dependents recompute on the next execute |
| Edit a copy of an old computation | `create operator variant from scores@2` | One editable operator whose direct inputs are the saved tables; the default operators stay untouched |
| Compare versions | `diff(key=[...], columns=[...])` over `scores@2` and `scores` | One row per key with `status` and each column's old, new and delta values |
| Answer from a version | `answer` with `from: "scores@2[...] top 5 by score desc, unit asc"` or `operator_ids: ["scores@2"]` | Composed from the complete saved table; the sources are recorded |

The retired `fork operator … as …` and `update operator … from task N`
commands are refused with the `@N` form to use; recorded traces that contain
them still replay. A saved-result handle cannot be deleted and is dropped
automatically when its consumer or edge goes. A batched `read` with `columns`
keeps, for each table, the columns it has and notes the missing ones; only a
table with none of them is an error. Saved reads never execute, never
substitute a newer table and never rerun an old definition on today's files.
External files are not versioned: a definition made current again reads the
files at their supplied paths. See [the state model](observation-format/state-versions-design-2026-10-06.md).

The system prompt includes [generic multitask examples](../agent-service/src/agent/prompts/native-example-history.md)
for reading a saved output, a permanent rule change, an editable variant, a
keyed comparison and an old rule on current data. They are included only when
`stateHistory` is enabled; the default prompt stays unchanged. Completed task
catalogs are frozen on their existing endpoint snapshots and retained in
exported action traces; there is no separate task store. Prior-task context
shows chronological operator blocks with final saved definitions, what each
task saved, answer-source markers and separate deletions. Python bodies and
result records remain on demand. See the
[implemented catalog design](observation-format/prior-task-operator-catalog-design.md).

### Graph implementation

`native/catalog.ts` defines operator parameters, meanings and input arity.
`native/python/graph_parser.py` parses ordinary and saved-version graph commands and extracts
operator-local functions without executing them. `tools/graph-edits.ts` stages
and validates a private graph, then returns a complete plan for the runtime to
commit after checking cancellation and ownership. Saved-version commands share
that ordered draft with ordinary commands, so an `update … from scores@2`
between two edits does not jump ahead of the edit before it. New receipts
record this ordering policy; older saved-version traces retain their previous
replay semantics, including the retired fork and restore commands.

Logical port connections become ordered native inputs and physical engine
ports. The native compiler and Python validator check definitions and callback
signatures. Runtime errors retain the existing operator error taxonomy, repair
hints, source locations and result contracts.

Existing assignment-based traces remain replayable through their original edit
interpreter. New calls use graph commands. Historical benchmark arms must run
at their recorded service revision. Code-mode behavior is unchanged.

## Defaults and verification

Defaults: native mode, DELTA context, profile collection on, data and flow
evidence off. Collection cannot change on an existing workflow. Native mode
forces provider parallel tool calls off; its action list is ordered.

From `agent-service/`:

```bash
bun test
bun run typecheck
bun run render:native-reference --check
../.venv/bin/python -m pytest -q benchmark/tests
TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3072 \
  bun benchmark/e2e/dataflow-actions-run.ts --probes-only
```

The live checks require the backend and this branch's agent service. They cover
explicit edits, result freshness, unchanged execution, upstream and leaf edits,
rewiring, self-joins, automatic incident-edge deletion, atomic rejection and
unconnected inputs. The harness saves traces, snapshots, observations and
backend execution history and cleans up its workflows and computing unit.
Without `--probes-only`, it also runs a real model task and saves every actual
model request and the provider's cache-token counts.
