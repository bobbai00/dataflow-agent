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

### Optional historical state

Set `stateHistory: true` when creating a native agent to expose historical
inspection, forking and retrieval. The default is `false`. All tasks continue
on one graph, and DELTA keeps the action transcript. Task numbers follow user
request order, starting at 1; only completed tasks have historical state.

| Action | Arguments | Result |
|---|---|---|
| Inspect saved operator | `target: "state"`, `task_id`, nonnull `operator_id`, `include_implementation`, `view` | Historical expression, ports, edges, functions, dependency hash and optional saved result |
| Inspect operator history | Same, with `task_id: null`, `view: null` | Change points across completed tasks, including upstream changes and deletion; `through_task_id` groups unchanged state |
| Batch operator inspection | `operator_id: ["eligible", "score"]` | Up to eight named operators, with shared graph-proof computation |
| Fork | `task_id`, `operator_id`, `new_operator_id` | New copies of the operator and all upstream definitions, with an ID mapping |

A specific-task inspection can include `view: "sample_stats"` or `"full"` to
read its saved output along with the definition. Set `view: null` for definitions
alone. Saved reads never execute or substitute current state. Missing results
are explicitly unavailable. Task inspection retrieves the local answer
computation from its saved snapshot, never the live graph. Unchanged earlier
computations appear as input references naming their owning task and version.
Expand one with that task number and operator ID; a saved operator read can
instead reveal only its definition and immediate inputs. A changed ancestor or
result identity keeps its affected downstream operators in the local graph.
Explicit answer sources take precedence over exploratory reads. Without a
declaration, prior reads remain unexpanded candidates with no automatic result
retrieval; unknown roots remain unknown. Named roots can
select a saved intermediate branch when the final report is unsuitable. Source
declarations establish provenance; availability validation does not check the
computation's semantics. See [task context](observation-format/task-dependency-context.md).

A fork preserves input port positions and assigns new IDs to every dependency.
It leaves the existing branch intact. Before execution, retrieving the fork can
read its source observation, labeled with the original task, operator and result
version. This is a saved observation, potentially sampled, rather than a new
engine materialization. Execute computes the copied graph for downstream use.
Changing a definition or input invalidates this saved-result fallback, as does
materializing new inputs without completing the descendant.

To reuse an old formula with current data, inspect the historical definition
and create it with current edges, or rewire the fork explicitly. Forking an
entire branch also restores its historical input definitions. External files
are not versioned: executing a fork reads the files at their supplied paths.

The system prompt includes [generic multitask examples](../agent-service/src/agent/prompts/native-example-history.md)
for reading a saved output, continuing from an earlier full population,
applying an earlier formula to current data, and changing a temporary branch
while preserving its baseline. Each example separates calls that depend on a
new observation. These examples are included only when `stateHistory` is
enabled; the default prompt stays unchanged. Saved tasks address the existing
snapshot tree; this feature adds no separate catalog or task store.

### Graph implementation

`native/catalog.ts` defines operator parameters, meanings and input arity.
`native/python/graph_parser.py` parses the five graph commands and extracts
operator-local functions without executing them. `tools/graph-edits.ts` stages
and validates a private graph, then returns a complete plan for the runtime to
commit after checking cancellation and ownership.

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
