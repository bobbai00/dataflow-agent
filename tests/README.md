# Tests for the DataProcessing / DataLoading port

End-to-end validation of the engine port from the dataflow-agent branch's
CODE-mode operator descriptors into texera/main.

## Layout

```
tests/
├── 01-single-chain/            DataLoading → DataProcessing
├── 02-two-input-join/          2× DataLoading → DataProcessing(2 inputs)
├── 03-three-input-merge/       3× DataLoading → DataProcessing(3 inputs)
├── 04-multiple-parallel-chains/ Two independent DataLoading → DataProcessing pairs
├── 05-diamond-topology/        DataLoading → 2× DataProcessing → DataProcessing(2 inputs)
├── python_runtime_test.py      Python harness for UDFMultiTableOperator
├── run_all.sh                  Master runner: Scala specs + Python harness
└── RESULTS.md                  Aggregated pass/fail summary
```

Each test folder contains:
- `workflow.json` — the workflow as constructed by the agent-service's CODE
  mode (operator IDs match function parameter names; links wired by parameter
  index).
- `README.md` — what topology is being tested and what each operator does.
- `result.json` — written by the Scala spec; per-operator port topology, the
  generated wrapper code class, descriptor class names, and per-link
  parameter-alignment validation.
- `python-runtime-result.json` — written by `python_runtime_test.py`; the
  output rows/columns when the test is driven through `UDFMultiTableOperator`
  with synthetic Tables.

## How to run

```sh
# From repo root
bash tests/run_all.sh
```

The runner produces detailed logs under `tests/.logs/`.

## What's verified

**Slice A — `PythonCodeValidator`**
- `validateNoPrint`, `validateNoFileIO`, `generatePythonCodeForRaisingException`
- Comment + docstring stripping (single + double triple-quoted)
- Multi-violation accumulation
- Method-`print` false-positive guard

**Slice B — `UDFMultiTableOperator` (pytexera)**
- The buffer-then-dispatch contract: ports collected in any order, dispatch
  fires only after the final port arrives, named attributes (`self.<port>`)
  populated from the port's table.
- Exercised via real datasets (Iris, TMDb) for all 5 topologies including
  multi-yield chains where a `DataProcessing` operator's output drives
  another `DataProcessing` operator (test 05).

**Slice C — `DataProcessingOpDesc` / `DataLoadingOpDesc`**
- Jackson polymorphic deserialization (`@JsonSubTypes` registration of
  `DataProcessing` and `DataLoading` operator type names).
- `def process(p1, p2, ...)` parses into N input ports with sequential
  dependencies (port `i` depends on `0..i-1`).
- Port `displayName` matches the corresponding parameter name.
- Generated wrapper contains `class GenerateOperator(UDFSourceOperator)` for
  sources and `class ProcessTablesOperator(UDFMultiTableOperator)` with
  `INPUT_PORTS = ["p1", "p2", ...]` for processors.
- `getPhysicalOp` succeeds and emits `OpExecWithCode` with
  `dynamic_output_schema = true` (so slice 5's runtime inference activates).
- `propagateSchema` returns an empty `Schema()` (runtime owns the schema).
- Link validation: every `link.toPortIndex` aligns with the source operator
  ID's position in the target's parameter list (CODE-mode convention).

## What's NOT verified

These need a live cluster (Postgres + MinIO + lakeFS + Lakekeeper +
WorkflowExecutionService + AccessControlService etc.) which is several
hours of bring-up:

- Actual Iceberg writes from the Python worker.
- Network plumbing of `result_statistics` (slice 1's wire) under load.
- `recreate_port_storage_writer` race semantics under real concurrent
  upstream completion.
- Real workflow execution via `SyncExecutionResource.executeWorkflowSync`.

The unit + spec coverage above proves the *descriptor logic* and *runtime
operator base class* are correct. The orchestration layer between them
(amber engine) was not changed by slices A/B/C so it doesn't need
re-validation here.

## Counts

| Stage | Tests | Passing |
|---|---|---|
| Slice A — `PythonCodeValidatorSpec` | 12 | 12 |
| Slice C — `DataProcessingOpDescSpec` | 7 | 7 |
| Slice C — `CodeOperatorWorkflowsSpec` (5 workflows × 1 + 1 cross-cutting) | 6 | 6 |
| Slice B — `python_runtime_test.py` (5 workflows) | 5 | 5 |
| **Total** | **30** | **30** |
