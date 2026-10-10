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
- **source** (scan, executed)
  - result: 24 rows × 3 columns
  - columns: id str, value str, category str
  - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=24 rows.
- **converted** (cast, executed)
  - inputs: `source`
  - result: 24 rows × 3 columns
  - columns: id str, value float64, category str
  - flow: "value" conversion failures=4/24 rows (errors=null).
  - flow: "value" failed-value examples (not exhaustive): "invalid" × 4; other failures=0.
  - flow: "value" nulls before=0/24, after=4/24, delta=4; row-preserving contract, not a claim of cellwise equivalence.
- **selected** (select_records, executed)
  - inputs: `converted`
  - result: 23 rows × 3 columns
  - columns: id str, value float64, category str
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - flow: select_records input rows=[24], output=23; row/column mapping unknown.
- **lookup** (scan, executed)
  - result: 22 rows × 2 columns
  - columns: id str, label str
  - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=22 rows.
- **joined** (join, executed)
  - inputs: input-0 `selected`, input-1 `lookup`
  - result: 21 rows × 4 columns
  - columns: id str, value float64, category str, label str
  - flow: Join matched contribution=21 (sum L(k)*R(k)); output=21, including outer unmatched rows as declared.
  - flow: left matched rows=20/23, unmatched rows=3; matched keys=20/23, unmatched keys=3; null-key rows=0, max eligible multiplicity=1.
  - flow: right matched rows=21/22, unmatched rows=1; matched keys=20/21, unmatched keys=1; null-key rows=0, max eligible multiplicity=2.
  - flow: left eligible unmatched-key examples (not exhaustive): ["21"] × 1; ["22"] × 1; ["23"] × 1.
  - flow: right eligible unmatched-key examples (not exhaustive): ["99"] × 1.
  - flow: right duplicate-key examples (not exhaustive): ["1"] × 2.
- **summary** (aggregate, executed)
  - inputs: `joined`
  - result: 1 row × 3 columns
  - columns: total float64, measured int64, rows int64
  - flow: Aggregate groups=1 from 21 rows; group size min=21, max=21.
  - flow: "total" nonnull=18/21; per-group min=18, max=18; reducer=sum.
  - flow: "measured" nonnull=18/21; per-group min=18, max=18; reducer=count.
  - flow: "rows" row denominator=21/21; per-group min=21, max=21; reducer=count.

### 3. retrieve joined, summary: ok
- **joined** (join, executed)
  - inputs: input-0 `selected`, input-1 `lookup`
  - result: 21 rows × 4 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: id str, value float64, category str, label str
records: sample_stats; 2 of 21 rows, 4 of 4 columns (first and last retained records; … marks omitted rows)
| id | value | category | label |
|---|---|---|---|
| "1" | 1 | accepted | group-1 |
| … | … | … | … |
| "20" | 20 | accepted | group-0 |
statistics: full table, 21 of 21 rows, 4 of 4 columns
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| id | str | 0 | 20 | top: "1" 2; "10" 1; "11" 1; "12" 1 (not exhaustive) |
| value | float64 | 3 | 17 | 1 to 20; top: 1 2; 2 1; 3 1; 4 1 (not exhaustive) |
| category | str | 0 | 1 | all: accepted 21 |
| label | str | 0 | 2 | all: group-1 11; group-0 10 |
- note: full table: duplicate rows=1, all-null rows=0, all-null columns=[].
- flow (converted): Cast produced nulls for values it could not convert. "value" conversion failures=4/24 rows (errors=null). "value" failed-value examples (not exhaustive): "invalid" × 4; other failures=0. Before custom processing; row/column correspondence to this output unknown.
- flow (selected): select_records row/column mapping unknown.
- flow: Join matched contribution=21 (sum L(k)*R(k)); output=21, including outer unmatched rows as declared.
- flow: left matched rows=20/23, unmatched rows=3; matched keys=20/23, unmatched keys=3; null-key rows=0, max eligible multiplicity=1.
- flow: right matched rows=21/22, unmatched rows=1; matched keys=20/21, unmatched keys=1; null-key rows=0, max eligible multiplicity=2.
- flow: left eligible unmatched-key examples (not exhaustive): ["21"] × 1; ["22"] × 1; ["23"] × 1.
- flow: right eligible unmatched-key examples (not exhaustive): ["99"] × 1.
- flow: right duplicate-key examples (not exhaustive): ["1"] × 2.
- flow: contract; Join: declared inner join; nullsEqual=false; validate=many_to_many; row order unspecified.
- **summary** (aggregate, executed)
  - inputs: `joined`
  - result: 1 row × 3 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: total float64, measured int64, rows int64
records: sample_stats; 1 of 1 row, 3 of 3 columns (complete)
| total | measured | rows |
|---|---|---|
| 175 | 18 | 21 |
statistics: not shown; the complete records above show every value
- flow (converted): Cast produced nulls for values it could not convert. "value" conversion failures=4/24 rows (errors=null). "value" failed-value examples (not exhaustive): "invalid" × 4; other failures=0. Before custom processing; row/column correspondence to this output unknown.
- flow (joined): Join type=inner, keys="id". Join matched contribution=21 (sum L(k)*R(k)); output=21, including outer unmatched rows as declared. left matched rows=20/23, unmatched rows=3; matched keys=20/23, unmatched keys=3; null-key rows=0, max eligible multiplicity=1. right matched rows=21/22, unmatched rows=1; matched keys=20/21, unmatched keys=1; null-key rows=0, max eligible multiplicity=2. left eligible unmatched-key examples (not exhaustive): ["21"] × 1; ["22"] × 1; ["23"] × 1. right eligible unmatched-key examples (not exhaustive): ["99"] × 1.
- flow (selected): select_records row/column mapping unknown.
- flow: Aggregate groups=1 from 21 rows; group size min=21, max=21.
- flow: "total" nonnull=18/21; per-group min=18, max=18; reducer=sum.
- flow: "measured" nonnull=18/21; per-group min=18, max=18; reducer=count.
- flow: "rows" row denominator=21/21; per-group min=21, max=21; reducer=count.
- flow: contract; Aggregate: one output row per group; group keys=[]; null keys form a group.