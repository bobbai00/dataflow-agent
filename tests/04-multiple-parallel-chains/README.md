# Test 04 — Multiple Parallel Chains

```
iris_raw   (DataLoading) ──► iris_summary (DataProcessing)

movies_raw (DataLoading) ──► movies_top   (DataProcessing)
```

**Topology:** 4 operators, 2 links across **two independent chains** in the same workflow. Verifies the descriptors don't introduce cross-chain coupling and that two independent DataLoading sources can coexist.

**What this verifies:**

- Two unrelated source-and-process pairs in one workflow with no shared operators or links.
- Each `DataProcessing` operator has its own single input port matching its respective parameter (`iris_raw`, `movies_raw`).
- File I/O permitted in both `DataLoading` operators independently — `validateNoPrint` runs but `validateNoFileIO` is bypassed for source operators.

**Datasets:** Iris and TMDb (top 200 rows for the movies side).

**Expected outputs:**
- `iris_summary`: 3 rows (one per species), 3 columns (Species, avg_sepal, count).
- `movies_top`: 10 rows, 3 columns (id, title, vote_average).
