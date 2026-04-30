# Test 01 — Single Chain

```
iris_data (DataLoading) ──► filter_setosa (DataProcessing)
```

**Topology:** 2 operators, 1 link. The simplest possible CODE-mode workflow — one source, one transform.

**What this verifies:**

- `DataLoading` descriptor with `def load()` parses the source signature.
- `DataProcessing` descriptor with `def process(iris_data)` derives **1 input port** named `iris_data` (matching the upstream operator ID).
- Generated Python wrapper imports `pytexera`, defines `GenerateOperator(UDFSourceOperator)` (for the source) and `ProcessTablesOperator(UDFMultiTableOperator)` (for the transform), and dispatches via `INPUT_PORTS = ["iris_data"]`.
- Both descriptors construct PhysicalOp with `dynamic_output_schema=true` on `OpExecWithCode`, so slice 5's runtime inference kicks in.
- `propagateSchema` returns an empty `Schema()` (runtime inference owns the output schema).

**Dataset:** `bin/single-node/examples/datasets/iris-species/Iris.csv` (150 rows, 6 columns).

**Expected output:** rows where `Species == 'Iris-setosa'` (50 rows), 3 columns (`Id`, `SepalLengthCm`, `PetalLengthCm`).
