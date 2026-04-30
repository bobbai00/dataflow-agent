# Test 06 — Tree Fan-Out / Fan-In (1 → 3 → 1)

```
                    ┌─► branch_setosa     ──┐
iris_root  ─────────┼─► branch_versicolor ──┼──► all_species (3 inputs)
                    └─► branch_virginica  ──┘
```

**Topology:** 5 operators, 6 links. Tree: one root fans out to three parallel
filter branches, all three feed back into a single 3-input aggregator.

**What this exercises:**
- Wide fan-out from a single source's output.
- 3-input merge downstream — the fix from RESULTS.md "How test 03 was fixed"
  must hold.
- Multiple parallel `_compute_column_stats` calls (one per branch) that need
  to ride out on `WorkerStatistics.result_statistics`.

**Expected output of `all_species`:** 3 rows × 3 cols (Species, count=50, avg_petal).
