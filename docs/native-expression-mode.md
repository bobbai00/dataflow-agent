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
| Inspect graph | `target: "graph"` | Operator IDs, types, named ports, edges and unconnected inputs |
| Inspect operator | `target: "operator"`, `operator_id`, `include_implementation` | Definition, ports, connections and optional Python implementation |
| Edit | `changes` | Ordered change receipts, automatically deleted edges, unconnected inputs and invalidated results |
| Execute | none | Whole-graph execution status; valid cached results can be reused |
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
required input to be connected. A rejected Edit leaves previous results valid.

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
