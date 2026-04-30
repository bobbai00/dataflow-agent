# Test 09 — Balanced Binary Tree (depth 3)

```
                        root_iris
                       /          \
              left_subtree    right_subtree
                   |                |
              left_summary    right_summary
                   \              /
                  tree_root_summary
```

**Topology:** 6 operators, 6 links. Two parallel 2-stage chains, each fed
from the same root, with different output schemas (left has `mean_sepal_len`,
right has `mean_petal_len`), reunited at the bottom via 2-input merge.

**What this exercises:**
- Heterogeneous schemas in a fan-in: the merge concatenates left's
  `[Species, count, mean_sepal_len, side]` with right's
  `[Species, count, mean_petal_len, side]` — different column sets, so
  pandas concat produces a union with `NaN`s.
- Deep dependency: `tree_root_summary` waits for two 2-stage paths to finish.
- Schema inference at the merge point must accept the union schema.

**Expected output of `tree_root_summary`:** 4 rows (2 species × 2 sides),
~5 columns including the union.
