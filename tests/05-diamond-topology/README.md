# Test 05 — Diamond Topology

```
                    ┌──► sepal_branch ──┐
iris_source ──────┤                    ├──► joined_areas
                    └──► petal_branch ──┘
```

**Topology:** 4 operators, 4 links. A diamond / fan-out-fan-in pattern: one source feeding two parallel `DataProcessing` operators, both fanning into a third 2-input `DataProcessing`. Exercises:
- A source operator's output going to multiple downstream consumers.
- A 2-input join consuming outputs of two upstream `DataProcessing` operators (not just `DataLoading` sources).

**What this verifies:**

- A `DataProcessing` operator can be both a downstream consumer of a `DataLoading` *and* an upstream producer for another `DataProcessing`.
- The 2-input `joined_areas` deserializes correctly with parameter names matching upstream operator IDs (`sepal_branch`, `petal_branch`).
- The schema-empty propagation flows correctly through a multi-stage pipeline (each stage relies on slice 5's runtime inference, not compile-time propagation).

**Expected output of `joined_areas`:** 150 rows × 3 columns (Id, sepal_area, petal_area).
