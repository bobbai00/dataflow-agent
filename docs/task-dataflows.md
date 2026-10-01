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

# Task Dataflows: initial implementation

This experimental layer starts a fresh graph for each user request and lets the agent explicitly import complete outputs from earlier tasks. It is off by default. The [experiment plan](longds-task-dataflows-experiment-plan.md) describes the hypotheses and matched controls.

## Settings and context

Create a native, DELTA agent with `taskDataflows: true`. Set `statePolicy: true` to add the shared instructions about working populations and temporary comparisons. These are separate settings so the policy can be tested without task isolation.

Enable the task layer before the first user request. It rejects incompatible history, recall, compaction, and versioned-session settings. The initial model context contains the current request and exact earlier request/answer pairs with task IDs. Earlier graphs, result samples, code, and internal ReAct steps are absent until requested. Actions and observations from the current task remain available while it runs.

## Actions

All actions use the existing `dataflow({reasoning, actions})` tool. The model composes a whole action list before receiving its results, so decisions that depend on an inspection require another model call.

| Action | Purpose |
| --- | --- |
| `inspect`, target `tasks`, optional `query` | List earlier tasks or search request/answer text using matching keywords |
| `inspect`, target `task`, `task_id`, `detail` | Read `summary`, `outputs`, `graph`, `implementations`, or `dependencies` |
| `inspect`, target `defaults` | Read explicitly saved ongoing bindings |
| `reuse_result`, `task_id`, `export_name`, `operator_id` | Add an immutable source for an exact earlier output |
| `answer`, `content`, `exports`, `answer_sources`, `defaults` | Retain declared outputs and finalize the task |

Output discovery lists row counts, column counts, a preview of up to 12 schema fields, and exact result references. It does not dump a wide table's samples. Saved answer sources are also importable using `answer/<operator_id>` as the export name.

An imported source exposes `out`. Connect it to a new computation using the existing explicit edge syntax, then Execute. Importing does not rerun the producing task. Retrieve never executes. Imported sources cannot be updated; transformations belong downstream.

```json
{
  "reasoning": "Count the complete population retained by task 3.",
  "actions": [
    {"type": "reuse_result", "task_id": 3, "export_name": "eligible_population", "operator_id": "saved"},
    {"type": "edit", "changes": "create operator size: aggregate(n=count())\ncreate edge saved.out -> size.in"},
    {"type": "execute"},
    {"type": "retrieve", "operator_id": "size"}
  ]
}
```

After reading the observation, Answer must be the only action in its call:

```json
{
  "reasoning": "The retrieved count answers the request.",
  "actions": [{
    "type": "answer",
    "content": "80 rows",
    "exports": [{"name": "population_size", "operator_id": "size"}],
    "answer_sources": ["size"],
    "defaults": []
  }]
}
```

Empty defaults preserve the previous bindings. A persistent update instead names an export in this task, for example `{"name":"population","export_name":"eligible_population"}`. These bindings identify current outputs; they do not rewrite history.

The inherited action framework stops mutations after failure. After an execution failure it still permits subsequent inspection and retrieval actions, which can show successfully completed components or detailed errors.

## What the runtime records

At Answer, the runtime checks that each declared output and its ancestors have current completed results with exact consumed input versions. It retains complete output tables as hashed Arrow artifacts through an authenticated backend endpoint, independently of the result cache. It then commits the task record and any default updates together.

The record includes the producing subgraph, operator implementations, exported outputs, answer sources, imported result references, and actual computational task dependencies. Unrelated exploratory branches remain in the full trace but are excluded from the saved producing graph. Reading a task does not create a computational dependency.

`GET /api/agents/:id/task-dataflows` exposes records for the evaluation harness. The LongDS runner separately saves per-turn actions, receipts, snapshots, exact outbound request bodies, provider usage, and anomaly alerts.

## Current limits

- Reuse imports saved results. Instantiating an earlier computation with replacement inputs and replaying corrections across tasks are still planned.
- Lineage tracks explicit inputs and edges. It cannot establish the origin of numbers copied from answer text, code copied by the model, or files read inside arbitrary Python.
- Retention preserves declared outputs. It cannot recover a working DataFrame discarded inside a function or infer that a top-five report was meant to represent a larger population.
- A current, complete result can still use the wrong formula or population. Task isolation does not validate statistical meaning.
- The live registry is session memory. Saved artifacts and evaluation traces survive a service restart, but restoring an active task registry from them is not implemented. Trace-only checkout is rejected in this mode.

## Validation

The unit suites cover retention validation, stale and missing results, fixed imports, graph dependencies, explicit defaults, temporary comparisons, task context, and discovery size. The live engine check deliberately saves an 80-row working population with a two-row report, then imports all 80 rows in a new task. Scala tests cover complete retention, nullable values, large integers, and empty output schemas.

See `agent-service/benchmark/e2e/task-dataflows-run.ts` and `agent-service/benchmark/multiturn/run-task-dataflows.ts` for the live check and frozen-session runner.
