# Test 02 — Two-Input Join

```
iris_features (DataLoading) ──┐
                              ├──► joined_iris (DataProcessing, 2 inputs)
iris_labels   (DataLoading) ──┘
```

**Topology:** 3 operators, 2 links. Tests the case the existing `DualInputPortsPythonUDFOpDescV2` handled, but using the parameter-driven N-input descriptor.

**What this verifies:**

- `def process(iris_features, iris_labels)` parses into **2 input ports** named `iris_features` (port 0) and `iris_labels` (port 1).
- Port 1 has `dependencies = [PortIdentity(0)]` — sequential buffering matches the `UDFMultiTableOperator` collect-then-dispatch contract.
- Generated wrapper has `INPUT_PORTS = ["iris_features", "iris_labels"]` and `process_tables` calls `process(self.iris_features, self.iris_labels)`.
- Link payloads connect `iris_features.output[0] → joined_iris.input[0]` and `iris_labels.output[0] → joined_iris.input[1]` — agent-service's `createInputLinks` ordering by parameter index.

**Expected output:** 150 rows (one per Iris flower), 4 columns (Id, SepalLengthCm, SepalWidthCm, Species).
