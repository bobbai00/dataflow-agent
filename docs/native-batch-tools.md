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

# Native batches and requested observations

Create or update an agent with `agentMode: "native"` and
`nativeToolMode: "batch"`. This exposes `dataflow`, `deleteOperator`, and
`inspectResult`, and forces provider `parallelToolCalls: false`. The default
`nativeToolMode: "typed"` retains the existing individual operator tools.

The batch uses each catalog operator's existing typed parameters. `op` names
the operator; `type` remains the join's inner/left/right/full/cross parameter.

```json
{
  "operators": [
    {"op": "filter", "id": "recent", "input": "sales", "predicate": "year = 2024"},
    {"op": "aggregate", "id": "total", "input": "recent", "aggregations": [{"fn": "sum", "col": "amount"}]}
  ],
  "observe": ["total"]
}
```

Every operator is an upsert by ID. A batch may mix operator kinds and contain
forward references; the service applies it in dependency order and invokes
one post-step execution phase. As before, the executor may send separate
backend requests for disconnected branches. Duplicate IDs and cycles
(including cycles through existing operators) are refused. Independent valid
edits still land if a sibling is invalid; consumers of a refused revision are
blocked so they do not silently use the old upstream version. The recorded
tool receipt identifies each added, modified, erroneous, or blocked operator.

`observe` controls displayed results, not computation or materialization:

- Omitted: show terminal outputs among the successfully submitted operators.
- IDs: show those outputs, including existing operators.
- Empty array: compact execution receipts only.
- `operators: []` with `observe`: read already-computed results without execution.

Execution errors always appear. DELTA history retains the observations chosen
by each original event. Changing a later request does not reveal an earlier
hidden result. LATEST applies the most recent batch's requested set and also
surfaces current compilation failures. A requested output bypasses rule/scoped
table selection; ordinary sample budgets and the configured statistics switch
still apply. Neither execution scope nor cached sample size changes.

`inspectResult` is automatically available in batch mode. It can show more of
the cached sample, choose columns, search sampled rows, or request collected
statistics. It cannot fetch uncached rows or prove that a value absent from the
sample is absent from the complete result. On-demand `stats: true` can reveal
statistics even when automatic `columnStats` is false; pilot analyses should
record those requests separately.

## Verification

From `agent-service/`:

```bash
bun test src/agent/tools/native-batch-tools.test.ts src/server.test.ts
bun run typecheck
TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3008 bun run benchmark/e2e/native-batch-run.ts
```

The e2e smoke needs the backends and the separate agent service already
running. It creates and removes its own workflow, agent, and computing unit;
it makes no LLM calls. It checks heterogeneous batches, materialization of
hidden outputs, reads without re-execution, sampled inspection, partial edit
failure, and an unrequested runtime failure after a previous successful result.
The debug transport bypasses LLM context assembly, so the smoke renders the
returned trace and snapshots locally through the production assembler. Real
agent runs record the actual model observations in `inputMessages`.
