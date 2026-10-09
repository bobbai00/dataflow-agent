### 1. edit: ok
function scale_values updated
operator left updated (load_values)
operator right updated (load_values)
operator scaled updated (scale_values)
operator combined updated (combine_values)
results invalidated: left, right, scaled, combined

### 2. execute combined: error
4 operators in scope: 2 executed, 0 cached, 1 failed, 1 not run.
- **left** (load_values, executed)
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: load_values "left": row selection inside Python is unknown; inspect its definition.
  - flow: Process input rows=[], output=2; row/column mapping unknown.
- **scaled** (scale_values, failed)
  - inputs: `left`
  - result: failed
  - scope: scale_values "scaled": row selection inside Python is unknown; inspect its definition.
  - error CALLBACK_RUNTIME: ValueError: synthetic conversion failure
    - at: scale_values line 2: `raise ValueError('synthetic conversion failure')`
    - fix: Repair the submitted function and relevant input handling before retrying.
- **right** (load_values, executed)
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: load_values "right": row selection inside Python is unknown; inspect its definition.
  - flow: Process input rows=[], output=2; row/column mapping unknown.
- not run: combined (upstream `scaled` failed)

### 3. retrieve independent, scaled: error
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
- **scaled**: unavailable
- error RESULT_FAILED: the last execution of `scaled` failed.
  - error CALLBACK_RUNTIME: ValueError: synthetic conversion failure
  - at: scale_values line 2: `raise ValueError('synthetic conversion failure')`
  - fix: Repair the submitted function and relevant input handling before retrying.
