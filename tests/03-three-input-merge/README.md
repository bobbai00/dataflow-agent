# Test 03 — Three-Input Merge

```
iris_ids   (DataLoading) ──┐
iris_sepal (DataLoading) ──┼──► merged_iris (DataProcessing, 3 inputs)
iris_petal (DataLoading) ──┘
```

**Topology:** 4 operators, 3 links. Beyond what `DualInputPortsPythonUDFOpDescV2` supports — exercises N>2 input ports, which **only** the new `DataProcessingOpDesc` provides.

**What this verifies:**

- `def process(iris_ids, iris_sepal, iris_petal)` parses into **3 input ports** with sequential dependency chain: port 0 → port 1 (depends on 0) → port 2 (depends on 0, 1).
- Generated `INPUT_PORTS = ["iris_ids", "iris_sepal", "iris_petal"]`.
- `process_tables` body: `yield process(self.iris_ids, self.iris_sepal, self.iris_petal)`.
- The `UDFMultiTableOperator.process_table` runtime collects all 3 ports before dispatching to user code (verified separately by the Python runtime test).

**Expected output:** 150 rows × 5 columns (Id, SepalLengthCm, SepalWidthCm, PetalLengthCm, PetalWidthCm).
