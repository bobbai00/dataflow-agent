### 1. retrieve combined, missing, independent: error
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
- **missing**: unavailable
- error UNKNOWN_OPERATOR: no operator `missing`.
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
