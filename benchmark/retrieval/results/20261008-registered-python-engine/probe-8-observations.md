### 1. edit: ok
function scale_values updated
operator left updated (load_values)
operator right updated (load_values)
operator scaled updated (scale_values)
operator combined updated (combine_values)
results invalidated: left, right, scaled, combined

### 2. execute combined: ok
4 operators in scope: 4 executed, 0 cached.
- **left** (load_values, executed)
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: load_values "left": row selection inside Python is unknown; inspect its definition.
  - flow: Process input rows=[], output=2; row/column mapping unknown.
- **scaled** (scale_values, executed)
  - inputs: `left`
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: scale_values "scaled": row selection inside Python is unknown; inspect its definition.
  - flow: Process input rows=[2], output=2; row/column mapping unknown.
- **right** (load_values, executed)
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: load_values "right": row selection inside Python is unknown; inspect its definition.
  - flow: Process input rows=[], output=2; row/column mapping unknown.
- **combined** (combine_values, executed)
  - inputs: input-0 `scaled`, input-1 `right`
  - result: 1 row × 1 column
  - columns: value int64
  - scope: combine_values "combined": row selection inside Python is unknown; inspect its definition.
  - flow: Process input rows=[2,2], output=1; row/column mapping unknown.

### 3. retrieve combined: ok
- **combined** (combine_values, executed)
  - inputs: input-0 `scaled`, input-1 `right`
  - result: 1 row × 1 column
  - columns: value int64
  - scope: combine_values "combined": row selection inside Python is unknown; inspect its definition.
columns: value int64
records: full; 1 of 1 row, 1 of 1 column (complete)
| value |
|---|
| 84 |
- flow: Process input rows=[2,2], output=1; row/column mapping unknown.
- flow: Process: row/column mapping unknown; equal row counts do not prove preservation.
