### 1. edit: ok
operator left updated (load_values)
operator right updated (load_values)
operator scaled updated (scale_values)
operator combined updated (combine_values)
results invalidated: left, right, scaled, combined

### 2. retrieve independent, combined: error
- **independent** (scan, executed)
  - result: 2 rows × 2 columns
  - columns: id int64, value int64
columns: id int64, value int64
records: full; 2 of 2 rows, 2 of 2 columns (complete)
| id | value |
|---|---|
| 1 | 10 |
| 2 | 20 |
- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=2 rows.
- **combined**: unavailable
- error RESULT_STALE: `combined` changed after its last execution. Execute it, then retrieve.
