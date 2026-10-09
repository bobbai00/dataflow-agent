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
- flow (converted): Cast produced nulls for values it could not convert. "value" conversion failures=4/24 rows (errors=null). "value" failed-value examples (not exhaustive): "invalid" × 4; other failures=0. Before custom processing; row/column correspondence to this output unknown.
- flow (selected): select_records row/column mapping unknown.
- flow: Join matched contribution=21 (sum L(k)*R(k)); output=21, including outer unmatched rows as declared.
- flow: left matched rows=20/23, unmatched rows=3; matched keys=20/23, unmatched keys=3; null-key rows=0, max eligible multiplicity=1.
- flow: right matched rows=21/22, unmatched rows=1; matched keys=20/21, unmatched keys=1; null-key rows=0, max eligible multiplicity=2.
- flow: left eligible unmatched-key examples (not exhaustive): ["21"] × 1; ["22"] × 1; ["23"] × 1.
- flow: right eligible unmatched-key examples (not exhaustive): ["99"] × 1.
- flow: right duplicate-key examples (not exhaustive): ["1"] × 2.
- flow: contract; Join: declared inner join; nullsEqual=false; validate=many_to_many; row order unspecified.
- **summary** (aggregate, cached)
  - inputs: `joined`
  - result: 1 row × 3 columns
  - scope: select_records "selected": row selection inside Python is unknown; inspect its definition.
  - columns: total float64, measured int64, rows int64
records: sample; 1 of 1 row, 3 of 3 columns (complete)
| total | measured | rows |
|---|---|---|
| 175 | 18 | 21 |
- flow (converted): Cast produced nulls for values it could not convert. "value" conversion failures=4/24 rows (errors=null). "value" failed-value examples (not exhaustive): "invalid" × 4; other failures=0. Before custom processing; row/column correspondence to this output unknown.
- flow (joined): Join type=inner, keys="id". Join matched contribution=21 (sum L(k)*R(k)); output=21, including outer unmatched rows as declared. left matched rows=20/23, unmatched rows=3; matched keys=20/23, unmatched keys=3; null-key rows=0, max eligible multiplicity=1. right matched rows=21/22, unmatched rows=1; matched keys=20/21, unmatched keys=1; null-key rows=0, max eligible multiplicity=2. left eligible unmatched-key examples (not exhaustive): ["21"] × 1; ["22"] × 1; ["23"] × 1. right eligible unmatched-key examples (not exhaustive): ["99"] × 1.
- flow (selected): select_records row/column mapping unknown.
- flow: Aggregate groups=1 from 21 rows; group size min=21, max=21.
- flow: "total" nonnull=18/21; per-group min=18, max=18; reducer=sum.
- flow: "measured" nonnull=18/21; per-group min=18, max=18; reducer=count.
- flow: "rows" row denominator=21/21; per-group min=21, max=21; reducer=count.
- flow: contract; Aggregate: one output row per group; group keys=[]; null keys form a group.