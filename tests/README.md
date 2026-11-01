# Workflow fixtures for the DataLoading / DataProcessing operators

Five workflows in the shape the agent service builds, read by
`CodeOperatorWorkflowsSpec` (`common/workflow-operator`). The spec finds the
repo root by `tests/01-single-chain/workflow.json`, so these paths must stay.

```
tests/
├── 01-single-chain/             DataLoading → DataProcessing
├── 02-two-input-join/           2× DataLoading → DataProcessing(2 inputs)
├── 03-three-input-merge/        3× DataLoading → DataProcessing(3 inputs)
├── 04-multiple-parallel-chains/ Two independent DataLoading → DataProcessing pairs
└── 05-diamond-topology/         DataLoading → 2× DataProcessing → DataProcessing(2 inputs)
```

Each folder contains:
- `workflow.json` — operator IDs match function parameter names; links are wired
  by parameter index.
- `README.md` — the topology and what each operator does.
- `result.json` (git-ignored) — written by the spec: per-operator port topology,
  the generated wrapper class, descriptor class names and per-link parameter
  alignment.

## How to run

```sh
sbt "project WorkflowOperator" \
  "testOnly org.apache.texera.amber.operator.udf.python.CodeOperatorWorkflowsSpec"
```

For each operator in each workflow, the spec checks Jackson polymorphic
deserialization, the port topology from `operatorInfo`, that `getPhysicalOp`
emits `OpExecWithCode` with a wrapper containing the expected framework class,
and that link payloads connect ports by parameter index.

Nothing here runs an operator. On a running stack, `bun run e2e` in
`agent-service/` runs workflows of these operator types through the engine; its
`[PythonOps]` W2, W3 and W4 check that each input port reaches the right
parameter of a multi-input `DataProcessing` operator.
