### 1. edit: ok
function select_records registered
operator source created (scan)
operator converted created (cast)
operator selected created (select_records)
operator lookup created (scan)
operator joined created (join)
operator summary created (aggregate)
edge source -> converted created
edge converted -> selected created
edge selected -> joined.input-0 created
edge lookup -> joined.input-1 created
edge joined -> summary created

### 2. execute summary: ok
6 operators in scope: 6 executed, 0 cached.
- **selected** (select_records, executed)
  - inputs: `converted`
  - result: 23 rows × 3 columns
  - columns: id str, value float64, category str
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.

### 3. retrieve joined, summary: ok
- **joined** (join, executed)
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
- **summary** (aggregate, executed)
  - inputs: `joined`
  - result: 1 row × 3 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: total float64, measured int64, rows int64
records: sample; 1 of 1 row, 3 of 3 columns (complete)
| total | measured | rows |
|---|---|---|
| 175 | 18 | 21 |