### 1. retrieve joined, summary: ok
- **joined** (join, cached)
  - inputs: input-0 `selected`, input-1 `lookup`
  - result: 21 rows × 4 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: id str, value float64, category str, label str
records: sample; 2 of 21 rows, 4 of 4 columns (first and last retained records; … marks omitted rows)
| id | value | category | label |
|---|---|---|---|
| "1" | 1 | accepted | group-1 |
| … | … | … | … |
| "20" | 20 | accepted | group-0 |
- **summary** (aggregate, cached)
  - inputs: `joined`
  - result: 1 row × 3 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: total float64, measured int64, rows int64
records: sample; 1 of 1 row, 3 of 3 columns (complete)
| total | measured | rows |
|---|---|---|
| 175 | 18 | 21 |