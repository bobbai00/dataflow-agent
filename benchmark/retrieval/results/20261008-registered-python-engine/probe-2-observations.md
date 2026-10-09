### 1. edit: ok
operator left created (load_values)
operator right created (load_values)
operator scaled created (scale_values)
operator combined created (combine_values)
operator independent created (scan)
edge left -> scaled created
edge scaled -> combined.input-0 created
edge right -> combined.input-1 created

### 2. execute combined, independent: ok
5 operators in scope: 5 executed, 0 cached.
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
- **independent** (scan, executed)
  - result: 2 rows × 2 columns
  - columns: id int64, value int64
  - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=2 rows.

### 3. retrieve left, right, scaled, combined, independent: ok
- **left** (load_values, executed)
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: load_values "left": row selection inside Python is unknown; inspect its definition.
columns: id int64, value int64, invocations int64
records: full; 2 of 2 rows, 3 of 3 columns (complete)
| id | value | invocations |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | 1 |
- flow: Process input rows=[], output=2; row/column mapping unknown.
- flow: Process: row/column mapping unknown; equal row counts do not prove preservation.
- **right** (load_values, executed)
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: load_values "right": row selection inside Python is unknown; inspect its definition.
columns: id int64, value int64, invocations int64
records: full; 2 of 2 rows, 3 of 3 columns (complete)
| id | value | invocations |
|---|---|---|
| 1 | 3 | 1 |
| 2 | 4 | 1 |
- flow: Process input rows=[], output=2; row/column mapping unknown.
- flow: Process: row/column mapping unknown; equal row counts do not prove preservation.
- **scaled** (scale_values, executed)
  - inputs: `left`
  - result: 2 rows × 3 columns
  - columns: id int64, value int64, invocations int64
  - scope: scale_values "scaled": row selection inside Python is unknown; inspect its definition.
columns: id int64, value int64, invocations int64
records: full; 2 of 2 rows, 3 of 3 columns (complete)
| id | value | invocations |
|---|---|---|
| 1 | 4 | 1 |
| 2 | 6 | 1 |
- flow: Process input rows=[2], output=2; row/column mapping unknown.
- flow: Process: row/column mapping unknown; equal row counts do not prove preservation.
- **combined** (combine_values, executed)
  - inputs: input-0 `scaled`, input-1 `right`
  - result: 1 row × 1 column
  - columns: value int64
  - scope: combine_values "combined": row selection inside Python is unknown; inspect its definition.
columns: value int64
records: full; 1 of 1 row, 1 of 1 column (complete)
| value |
|---|
| 51 |
- flow: Process input rows=[2,2], output=1; row/column mapping unknown.
- flow: Process: row/column mapping unknown; equal row counts do not prove preservation.
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
