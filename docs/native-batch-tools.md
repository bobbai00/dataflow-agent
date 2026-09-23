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

> **Superseded on 2026-09-22.** The JSON batch tool, the V1/V2 catalogs and
> `nativeToolMode` / `nativeCatalogVersion` described here were replaced by the
> expression program of [native-expression-mode.md](native-expression-mode.md).
> The observe/receipt and scheduling contract still holds; the call shape is `dataflow({program, observe})`.

# Native batches and requested observations

Create or update an agent with `agentMode: "native"` and
`nativeToolMode: "batch"`. This exposes `dataflow` and `deleteOperator`, and
forces provider `parallelToolCalls: false`. V2 also exposes `inspectError` for
diagnostics only. The result-inspection tool is removed in every mode; the
deprecated `enableInspectTool` setting is ignored and always reports false. The default
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
forward references. It uses the same `ToolCallScheduler` as parallel tool calls
(stable topological order, serial mutations), not a separate batch executor.
Dependency extraction also follows unchanged existing nodes to find pending
upstream edits. The service applies the edits in that order and invokes
one post-step execution phase. As before, the executor may send separate
backend requests for disconnected branches. Duplicate IDs and cycles
(including cycles through existing operators) are refused. Independent valid
edits still land if a sibling is invalid; consumers of a refused revision are
blocked so they do not silently use the old upstream version. The recorded
tool receipt identifies each added, modified, erroneous, or blocked operator.

`observe` controls displayed results, not computation or materialization:

- IDs: show those outputs, including existing operators.
- Omitted or empty array: compact execution receipts only, even for terminal outputs.
- `operators: []` with `observe`: read already-computed results without execution.

To receive successful result content, explicitly include its ID in `observe`.
This replaces the prototype's implicit terminal-output default; older saved
receipts retain their recorded observation choices.

Execution errors always appear. DELTA history retains the observations chosen
by each original event. Changing a later request does not reveal an earlier
hidden result. Upstream revisions invalidate and refresh affected downstream
results; DELTA reports their re-execution even without `observe`. The receipt
is not a claim that values changed, and the new contents remain hidden until
explicitly requested. LATEST renders the current DAG with the most recent
batch's requested set, retaining definitions/receipts for other operators and
surfacing current compilation failures. A requested output bypasses rule/scoped
table selection; ordinary sample budgets and the configured statistics switch
still apply. Neither execution scope nor cached sample size changes.

`observe` is the sole result-retrieval mechanism in batch mode. Cached reads use
the same budget and evidence settings as observations after an edit; they cannot
request disabled statistics. They cannot fetch uncached rows or prove that a
value absent from the sample is absent from the complete result. To focus on
columns or evaluate a full-table predicate/count/distinct set, submit the
corresponding operator through `dataflow` and observe its output.

Native DELTA error echoes use the definition from the failing event, not its
latest revision. V2's `inspectError` retrieves revision-pinned diagnostics, not
tables or statistics. Saved historical result-inspection traces remain readable,
but no executable result-inspection tool or factory remains.

Batch mode has a dedicated system-prompt template in
`agent-service/src/agent/prompts/native-batch-mode.md`, with object signatures
generated from the validation catalog. Its examples, execution/observation
contract, and observation placement follow the batch interface. Five examples
cover a complete dependent chain, forward references and fan-in alongside an
existing DAG, revision plus a new branch, receipt-only edits, and cached reads.
The principles encourage batching known operations to reduce model round trips,
while pausing for evidence at genuine data-dependent choices. Typed and code
prompts also omit the removed tool even when passed legacy inspection flags.

## Verification

From `agent-service/`:

```bash
bun test src/agent/tools/native-batch-tools.test.ts src/server.test.ts
bun test src/agent/tools/native-batch-scheduler.test.ts src/agent/tools/tool-call-scheduler.test.ts
bun test src/agent/tools/native-batch-context.test.ts
bun test src/agent/result-tool-removal.test.ts
bun test src/agent/prompts-native-batch.test.ts
bun run typecheck
TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3008 bun run benchmark/e2e/native-batch-run.ts
```

The e2e smoke needs the backends and the separate agent service already
running. It creates and removes its own workflow, agent, and computing unit;
it makes no LLM calls. It checks heterogeneous batches, materialization of
hidden outputs, reads without re-execution, removed-tool rejection, partial edit
failure, and an unrequested runtime failure after a previous successful result.
It also revises an upstream while adding a dependent chain through an existing
aggregate, verifies fresh downstream values, and checks explicit result
visibility in both DELTA and LATEST.
The debug transport bypasses LLM context assembly, so the smoke renders the
returned trace and snapshots locally through the production assembler. Real
agent runs record the actual model observations in `inputMessages`.
