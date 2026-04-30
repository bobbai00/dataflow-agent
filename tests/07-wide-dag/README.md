# Test 07 — Wide DAG with Cross-Path Reuse

```
iris_a ──┐
         ├─► joined_ab ──────────┐
iris_b ──┼─►                     │
         │                       ├─► intersection_filtered
         └─► filter_iris_b ──────┘
```

**Topology:** 5 operators, 5 links. `iris_b` feeds two distinct downstream
operators (`joined_ab` and `filter_iris_b`); both downstream operators then
merge into `intersection_filtered`. This is the canonical "diamond around a
shared producer" pattern that's strictly a DAG, not a tree.

**What this exercises:**
- A `DataLoading` source whose output is consumed by **two** downstream
  operators (multi-link from one output port).
- Two distinct paths from `iris_b` reaching the same terminal — both must
  agree on the underlying data.
- Materialization: `iris_b`'s output is read twice via separate
  materialization-reader threads.

**Expected output of `intersection_filtered`:** rows where `PetalLengthCm > 4.0`
joined with sepal attributes — should be ~99 rows (versicolor + virginica
have larger petals than setosa).
