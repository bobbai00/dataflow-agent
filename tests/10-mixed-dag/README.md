# Test 10 — Mixed DAG (two sources, branching, joining, multi-stage)

```
iris_full ──► iris_zscore ──┬──► iris_outliers ─┐
                            │                   │
                            └──► iris_movies_join ──► final_report
                                       ▲                ▲
movies_subset ─────────────────────────┘                │
                                                        │
                                       (iris_outliers)──┘
```

**Topology:** 6 operators, 6 links, two independent sources, multi-fan-out
from `iris_zscore`, two-input join at `iris_movies_join`, two-input join
at `final_report` consuming from two different downstream paths.

**What this exercises:**
- Two `DataLoading` sources with different schemas (Iris with numeric cols,
  TMDb subset with `Id`/`title`/`vote_average`).
- Multi-fan-out from a `DataProcessing` operator (`iris_zscore` feeds
  both `iris_outliers` and `iris_movies_join`).
- Deep DAG with mixed-shape data flow: numeric-only path
  (`iris_outliers`), join path (`iris_movies_join`), and a final left-join
  combining both.
- Merge-keyed data: Iris IDs (1-150) and movie IDs (0-149); joining on
  shared IDs (~149 matches).

**Expected output of `final_report`:** ~149 rows × 6 cols (Id, Species,
petal_z, title, vote_average, is_outlier).
