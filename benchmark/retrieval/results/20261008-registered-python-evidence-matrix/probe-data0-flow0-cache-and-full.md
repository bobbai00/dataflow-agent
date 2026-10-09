### 1. execute summary: ok
6 operators in scope: 0 executed, 6 cached.

### 2. retrieve joined, summary: ok
- **joined** (join, cached)
  - inputs: input-0 `selected`, input-1 `lookup`
  - result: 21 rows × 4 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: id str, value float64, category str, label str
records: full; 21 of 21 rows, 4 of 4 columns (complete)
| id | value | category | label |
|---|---|---|---|
| "1" | 1 | accepted | group-1 |
| "1" | 1 | accepted | group-1 |
| "2" | 2 | accepted | group-0 |
| "3" | 3 | accepted | group-1 |
| "4" | 4 | accepted | group-0 |
| "5" | 5 | accepted | group-1 |
| "6" | null | accepted | group-0 |
| "7" | 7 | accepted | group-1 |
| "8" | 8 | accepted | group-0 |
| "9" | 9 | accepted | group-1 |
| "10" | 10 | accepted | group-0 |
| "11" | 11 | accepted | group-1 |
| "12" | null | accepted | group-0 |
| "13" | 13 | accepted | group-1 |
| "14" | 14 | accepted | group-0 |
| "15" | 15 | accepted | group-1 |
| "16" | 16 | accepted | group-0 |
| "17" | 17 | accepted | group-1 |
| "18" | null | accepted | group-0 |
| "19" | 19 | accepted | group-1 |
| "20" | 20 | accepted | group-0 |
- **summary** (aggregate, cached)
  - inputs: `joined`
  - result: 1 row × 3 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: total float64, measured int64, rows int64
records: full; 1 of 1 row, 3 of 3 columns (complete)
| total | measured | rows |
|---|---|---|
| 175 | 18 | 21 |