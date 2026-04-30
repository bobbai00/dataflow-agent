# Test 08 — Deep Sequential Chain (5 stages)

```
stage0_load → stage1_normalize → stage2_features → stage3_filter → stage4_aggregate
```

**Topology:** 5 operators, 4 links. A long sequential chain: `DataLoading`
→ four sequential `DataProcessing` operators. Each stage's output schema
is *different* from its input (z-scores added, new derived columns,
filtering, aggregation), so slice 5's runtime schema inference must fire
correctly at every stage.

**What this exercises:**
- Schema evolves at every stage — Iris.csv (6 cols) → +4 z-cols (10) →
  +3 derived (13) → filtered (13) → aggregate output (5).
- Each stage's `recreate_port_storage_writer` must run cleanly for the
  inferred schema before any tuple is written.
- 4 sequential `_publish_column_stats` calls; each operator's
  `result_statistics` should land on the wire.

**Expected output of `stage4_aggregate`:** 3 rows (one per Species).
