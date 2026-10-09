# Operators as tools: specification

The contract between the model and the agent-service in `agentMode: "native"`.
Design and rationale: [typed-operators-design.md](typed-operators-design.md).
Source of truth for names, schemas and signatures: `NATIVE_OPERATORS` in
`src/agent/native/catalog.ts`; the tools, the validator and the prompt catalog
are all generated from it.

## 1. The tools

| tool | arguments (required in bold) | one line |
|---|---|---|
| `scan` | **id**, **files**, skipLines, header, columns, allText, delim, comment, format, widths, sheet, encoding, fileColumn, preview | file(s) → table |
| `filter` | **id**, **input**, **predicate** | keep rows where the SQL predicate is true |
| `project` | **id**, **input**, keep / drop / rename (at least one) | columns only, rows untouched |
| `compute` | **id**, **input**, **columns** `{name: "SQL scalar expression"}` | add or replace columns; cannot add or drop rows |
| `aggregate` | **id**, **input**, groupBy, **aggregations** `[{fn, col?, as?}]` | one row per group; no groupBy = one row |
| `join` | **id**, **left**, **right**, on `[[leftCol, rightCol]]`, type inner \| left \| right \| full \| cross | no `on` = cross join; left = right = self-join |
| `union` | **id**, **inputs** (2+) | stack by column name |
| `unpivot` | **id**, **input**, **columns**, nameColumn, valueColumn | wide to long: one row per (input row, column) |
| `distinct` | **id**, **input**, columns | one row per distinct combination (whole row when omitted) |
| `sort` | **id**, **input**, **by** `[{col, desc?}]` | order rows |
| `limit` | **id**, **input**, **n**, offset | first n rows |
| `udf` | **id**, inputs, **code** | `def process(<input ids>)` or `def load()` returning a DataFrame |
| `deleteOperator` | **id** | remove an operator nobody reads |

The catalog line the prompt shows for each tool, generated from the same
table (`toolSignature`):

```
scan(id, files, skipLines?, header?, columns?, allText?, delim?, comment?, format?, widths?, sheet?, encoding?, fileColumn?, preview?)   csv/tsv/txt, xlsx, html, json, parquet; ...
filter(id, input, predicate)   keeps rows where the SQL boolean predicate is true
project(id, input, keep?, drop?, rename?)   keep / drop / rename columns; rows untouched
compute(id, input, columns)   columns: {name: SQL scalar expression}; adds or replaces columns; cannot add or drop rows
aggregate(id, input, groupBy?, aggregations)   aggregations: [{fn, col?, as?}], fn ∈ sum count avg min max median count_distinct string_agg first stddev; no groupBy = one row
join(id, left, right, on?, type?)   on: [[leftCol, rightCol]], type inner|left|right|full|cross; omit `on` for a cross join; left = right for a self-join
union(id, inputs)   stacks two or more tables by column name
unpivot(id, input, columns, nameColumn?, valueColumn?)   wide → long: one row per (input row, column in `columns`); nameColumn/valueColumn name the two new columns
distinct(id, input, columns?)   one row per distinct combination of columns (whole row when omitted)
sort(id, input, by)   by: [{col, desc?}]
limit(id, input, n, offset?)   first n rows after offset
udf(id, inputs?, code)   code: `def process(<input ids>)` returning pd.DataFrame, or `def load()`; only for what no other tool does
```

## 2. Common contract

**Id.** `^[A-Za-z_][A-Za-z0-9_]*$`. The id names the output table
(`orders_2023`, `total_by_state`, never `op1`); downstream operators reference
it, and in `udf` it doubles as the `process()` parameter name.

**Inputs.** `input` (one), `left` / `right` (join), `inputs` (union, udf). An
input must be an existing operator or one created earlier in the same turn.
An operator cannot read its own output.

**Upsert.** A new id adds the operator. An existing id replaces its parameters
and inputs whole (no merge), recompiles the code, keeps the id, the position
and every outgoing link, and rewires the inputs. Refused: a Scan (source)
becoming a processing operator or vice versa; modifying an operator that is
not typed. Receipts:

```
added filter operator `web_fraud`; inputs: contributors
modified join operator `pairs`; inputs: left = shifted, right = shifted
added scan operator `reports`
```

**Validation before the engine.** Parameters are checked against the tool's
JSON schema (Ajv); an error names the signature:
`` `x`: invalid parameters for aggregate: /aggregations/0/fn must be equal to one of the allowed values. Expected: aggregate(id, input, groupBy?, aggregations) … ``.
Compile-time refusals (wrong arity, `columns` with a header, udf parameter
names that do not match `inputs`) are returned the same way. The engine only
ever runs code that compiled.

**Turns.** A turn may carry several calls; the scheduler orders them by their
input references (a call may name an id created earlier in the same turn) and
the workflow executes once after the turn. Execution re-materializes the
results of every added or modified operator **and all its descendants**, so a
modify upstream refreshes the whole chain below it.

**Delete.** `deleteOperator(id)` is refused while consumers exist:
`` `probe` still feeds `a`, `b`; re-point or delete those first. ``

## 3. Per-tool specification

### scan

| argument | type | meaning |
|---|---|---|
| `files` | string \| string[] | path or glob, verbatim from the task; several matches are unioned by column name |
| `skipLines` | int ≥ 0 | lines (or sheet rows) to skip before the header |
| `header` | bool, default true | first remaining line is the header |
| `columns` | string[] | column names for a header-less file; **requires `header: false`** (selecting columns is `project`) |
| `allText` | bool | read every column as text (files whose numbers carry separators or footnotes; cast later with `compute`) |
| `delim` | string | delimiter; `"whitespace"` for space-aligned columns |
| `comment` | 1 char | skip lines starting with it |
| `format` | auto \| csv \| lines \| fwf \| whitespace | `lines`: one row per line (`line_no`, `line`); `fwf`: fixed width, with `widths`; `whitespace` = `delim: "whitespace"` |
| `widths` | int[] | fixed-width column widths |
| `sheet` | string \| int | xlsx sheet name or index; html table index |
| `encoding` | string | detected when omitted: utf-8, else cp1252 |
| `fileColumn` | string | add the source file's base name as this column |
| `preview` | 1..200 | inspect a file before the real scan (below) |

Format resolution when `format` is `auto`, by extension of the first file:
`.xlsx .xls .xlsm` → excel; `.html .htm` → html; `.json .jsonl .ndjson` → json;
`.parquet` → parquet; `.gpkg .shp .npz .npy .cdf .nc .h5 .hdf5 .pkl .zip .gz
.db .sqlite` → binary (refused with a loader hint); anything else → csv.

Reader per format:

| format | reader |
|---|---|
| csv, utf-8, no `comment`, `delim` ≠ whitespace | DuckDB `read_csv([files], header, skip, union_by_name, names, all_varchar, delim, filename)` |
| csv otherwise (cp1252 bytes, `comment`, `delim: whitespace`) | pandas `read_csv` per file (`sep=r'\s+'` for whitespace, `encoding_errors='replace'`), concatenated |
| lines | every line of every file, `line_no` restarting per file |
| fwf | pandas `read_fwf(widths=…)` |
| excel | pandas `read_excel(sheet_name, header, skiprows)` |
| html | pandas `read_html(...)[sheet]` |
| json | dict of scalars → `key`, `value` table; equal-length lists → columns; records → `json_normalize` |
| parquet | DuckDB `read_parquet(union_by_name)` |

Encoding is detected on the first 4 MB of each file; DuckDB reads only utf-8,
so a cp1252 file (19 legal / wildfire CSVs) takes the pandas path
automatically.

`preview: n` returns a table the model can read as text:

| file kind | preview rows |
|---|---|
| text | `file`, `line_no`, `line`: the first n raw lines of up to 5 files |
| xlsx | `sheet`, `row_no`, `line`: the first n rows of every sheet, cells joined by ` \| ` (display only) |
| html | `table`, `row_no`, `line`: header plus first n rows of every table |
| binary | one row per file: name, size, and the loader hint |

Errors: a path that does not exist lists what the directory actually contains
(`not found: …/omni2.txt. …/omni2_low_res/ contains: omni2.text,
omni2_2023.dat, omni2_2024.dat`); a binary format says which library to use in
a `udf` loader (geopandas for gpkg / shp, numpy.load for npz, cdflib for cdf).

### filter

`predicate`: a DuckDB boolean expression over the input columns. Compiles to
`SELECT * FROM t WHERE (<predicate>)`. Column names with spaces or punctuation
go in double quotes; string literals in single quotes; `NULL` needs `IS NULL`.

### project

At least one of `keep: [col]`, `drop: [col]`, `rename: {old: new}`; applied in
that order. Compiles to pandas column selection / rename. Unknown columns are
an error naming the available ones.

### compute

`columns: {name: expression}`. A name that exists is replaced (`SELECT *
REPLACE (expr AS name)`), a new name is appended (`SELECT *, expr AS name`). A
difference of two timestamps comes back in seconds (the engine has no
interval type).
Scalar functions, `TRY_CAST`, `CASE WHEN`, string / date functions, and window
functions (`lag(x) OVER (ORDER BY t)`, `row_number() OVER (...)`) are allowed;
aggregates without `OVER` are not (that is `aggregate`).

### aggregate

`groupBy: [col]` (optional) and `aggregations: [{fn, col?, as?}]` with `fn` ∈
sum, count, avg (mean), min, max, median, count_distinct, string_agg, first,
stddev. `count` without `col` counts rows. Output columns: the group keys then
one column per aggregation, named `as` or `fn_col`. Compiles to one `SELECT …
GROUP BY` statement; integral sums come back as int64.

### join

`on: [[leftCol, rightCol], …]`, `type` inner (default) | left | right | full |
cross. Same-named non-key columns from the right get the suffix `_right`. No
`on` (or `type: cross`) pairs every row with every row, the way to put two
one-row aggregates side by side before a `compute`. `left` and `right` may be
the same id (self-join, e.g. a year against the previous year). Compiles to
`pandas.merge`.

### union

`inputs: [a, b, …]`, two or more; rows stacked, columns matched by name,
missing columns null. Compiles to `pandas.concat`.

### unpivot

`columns: [col]` are melted: for every input row and every listed column, one
output row with the other columns kept as keys, `nameColumn` (default
`variable`) holding the column's name and `valueColumn` (default `value`) its
value. Compiles to `pandas.melt`. Added after the multi-turn runs, where every
native session built the same wide-to-long ledger as four `compute` /
`project` operators plus a `union`.

### distinct

`columns: [col]` optional; one row per distinct combination, whole row when
omitted, first occurrence kept. Compiles to `drop_duplicates`.

### sort

`by: [{col, desc?}]`. Compiles to `sort_values`.

### limit

`n ≥ 1`, `offset ≥ 0`. Compiles to `iloc[offset:offset+n]`.

### udf

`code` defines exactly one function:

- `def process(a, b, …)` — the parameter names **are** the input ids, in the
  order of `inputs`; each parameter is that operator's output as a pandas
  DataFrame. Returns a DataFrame.
- `def load()` — no inputs; reads files with any library. Returns a DataFrame.

Rules: one step per udf; never filter, join, group, sort or deduplicate inside
it (those are tools); pandas, numpy, scipy, scikit-learn, geopandas, shapely,
skyfield, sgp4, cdflib, duckdb, pyarrow, openpyxl, lxml are available in the
worker. Return plain columns (geometry as WKT or dropped); object columns the
engine cannot type are pickled as binary and stringified by the next typed
operator.

### deleteOperator

Removes the operator and its links. Refused while consumers exist.

## 4. Compilation

Every typed operator lands as an ordinary engine operator: Scan and a `load()`
udf as `DataLoading`, everything else as `DataProcessing`, with the generated
Python in the operator's `code` property and the typed view
`{type, properties, inputs}` on `OperatorPredicate.nativeOp` (never forwarded
to the engine).

| type | body |
|---|---|
| Scan | `def load()` per §3 |
| Filter, Compute, Aggregate | `def process(<input>)`: `_ready()` prelude, `duckdb.connect()`, register the frame as `t`, one statement, `.df()` |
| Project, Join, Union, Distinct, Sort, Limit | `def process(...)`: the pandas call |
| UDF | the code as written (parameter check only) |

`_ready()` copies the input frame, de-duplicates column names (`c`, `c_1`),
and coerces object columns with mixed Python types to text so DuckDB's frame
scan never rejects them; an input with no columns passes through unchanged.

## 5. Errors

The engine reports errors against the generated Python. For a typed operator
the text the agent sees is rewritten (`formatNativeError`):

| engine says | agent sees |
|---|---|
| `(line 21) \`d = _con.sql(q).df()\` - BinderException: Binder Error: Referenced column "reports" not found …` | `filter \`x\` failed: Binder Error: Referenced column "reports" not found …` |
| `execution failed — … Execution error: up: (line N) … X` | `not executed — upstream \`up\` failed: X` |
| `execution failed — … The operation timed out.` | `not executed — the execution timed out before this operator produced a result` |
| `FileNotFoundError: not found: …` | the message plus the directory's contents |

followed by `Operator properties: {…}` (the agent's own parameters, never the
code). UDF errors keep the engine's line pointer, since the agent wrote that
code. The attention section uses the same text.

## 6. Rendering

Result shapes (full / count / header) are decided by the rule in the design
doc, §3. `resultSelection: "scoped"` keeps that decision and adds how much of a
full table renders, from the operator's type and the columns its parameters
name (`native/selection.ts`, `selectScopedShapes`):

- Columns: statistics and sample values only for the columns the operator's
  own parameters reference (filter predicate, compute sources and new columns,
  join keys, group-by and aggregation columns, sort keys) plus the columns its
  consumers read from it. The `Output Table` line and the complete `Schema`
  line always render. Scan, udf, aggregate, distinct and limit keep every
  column.
- Sample size: a share of the arm's `maxOperatorResultCharLimit`, applied as
  the formatter's per-operator character cap (header plus the head and tail
  rows that fit). Scan, udf, aggregate, distinct, limit 1; join, compute 0.3;
  sort, unpivot 0.2; filter 0 (0.2 when the predicate matches text); project,
  union 0. Everything is decided once, when the result arrives, and never
  rewritten, so the prompt stays append-only.
- DELTA history (`profileDiff`, statistics of the two runs, not the tables): an
  operator that re-executed because something upstream changed renders one
  line of what moved (`rows 660 → 452`, `"x": null 0 → 12`, min / max, columns
  added or dropped) or joins one `re-executed, unchanged: …` line; the frontier
  operator keeps its full shape. An operator the model revised renders by its
  type plus `change: …` against its previous run. Typed observations carry the
  `Inputs:` line once, above the result.

Formats:

LATEST block (one user message per block, topological order):

```
### aggregate operator `total`
Inputs: cross_unique (43 rows, 3 cols)
Properties: {"aggregations":[{"fn":"sum","col":"reports","as":"total_reports"}]}
Result:
  Output Table: 1 rows, 1 cols
  	total_reports
  0	243377
  Schema (1 cols): total_reports (numeric)
```

```
### filter operator `cross_state`
Inputs: reports_num (452 rows, 3 cols)
Properties: {"predicate":"regexp_matches(metropolitan_area, ', [A-Z]{2}(-[A-Z]{2})+ ')"}
Result: Output Table: 94 rows, 3 cols (from 452 rows)
```

```
### project operator `top3_named`
Inputs: top3 (3 rows, 3 cols)
Properties: {"keep":["state","reports"],"rename":{"reports":"total"}}
```

```
### scan operator `csn_preview`
Properties: {"files":"data/legal/input/2024_CSN_Data_Contributors.csv","preview":12}
Result: (preview superseded by scan `csn_data`)
```

DELTA action (text form of the tool calls of one turn):

```
- add filter operator `web_fraud`; inputs: contributors; properties: {"predicate":"..."}
- modify filter operator `web_fraud`; inputs: contributors; properties: {"predicate":"..."}
- add join operator `pairs`; inputs: left = shifted, right = shifted; properties: {"on":[["prev_year","year"]]}
- add union operator `all_years`; inputs: boston, chatham
- add scan operator `reports`; properties: {"files":"data/legal/input/State MSA Identity Theft data/*.csv","skipLines":3,"header":false,"columns":["metropolitan_area","reports"]}
- add udf operator `fit`; inputs: pairs
    code:
      def process(pairs): ...
- delete operator `contributors_preview`
```

DELTA observation:

```
added filter operator `web_fraud`; inputs: contributors

Observation:

- filter operator `web_fraud` added
  result:
    Inputs: contributors (139 rows, 4 cols)
    Output Table: 6 rows, 4 cols
    ...
```

`updated` replaces `added` for a modify; a refused call keeps its error line.
The transcript ends on the tool results of the last turn (no trailing user
message), so each step's prompt is the previous prompt plus the new turn. On a
later user turn the new request is also rendered inline at its chronological
position (after the previous turn's final answer), so the turn's first prompt
ends with the request and the turn's later steps extend it. Earlier requests
appear as `user` messages at their positions. In LATEST the blocks are in
creation order for the same reason (append-only prompts).

Catalog (`versionedMode`) and session (`sessionTurns`) layouts use
`messageLayout: "turnSplit"` by default: one user message per finished turn
entry, one per step of the live turn, one per top-level section, with the
`# Your Task` directive placed right after the live turn's task. Typed
operators appear in catalog entries as `#### filter operator \`id\` (added)`
with their `Properties:`; `recallState` returns parameters, not generated
code. Every place that identifies the operator a call wrote accepts the typed
tools' `id` as well as the code tool's `operatorId` (`writtenOperatorId`).

## 7. Prompt

`src/agent/prompts/native-mode.md`, filled by `buildNativeModeSystemPrompt`:
what a dataflow is; the catalog lines of §1; upsert / delete semantics; SQL
notes (quoting, `TRY_CAST`, regex, dates, `NULL`, window functions); build
rules (several operators per turn; no udf for what a tool does; ratios via
cross join; preview before scan; non-delimited text via `whitespace` /
`comment` / `fwf` / `lines`; binary via udf loader; fix in place with the same
id; delete probes); the context layout for LATEST or DELTA; the result shapes
in force (`all`, `rule` or `scoped`); the result-table format; the key principles
carried over from code mode minus the pandas-specific ones.

## 8. Settings

| setting | values | default |
|---|---|---|
| `agentMode` | `native` (this document), `code`, … | per request |
| `resultSelection` | `all`, `rule`, `scoped` | `all` |
| `contextMode` | `latest`, `delta` | per request |
| `messageLayout` | `opSplit` (LATEST), `native` (DELTA) | chosen from `contextMode` when unset |
| `execution_timeout_minutes` (harness) | idle timeout of one execution | 4; native arms use 10 (one Python hop over 320k rows ≈ 120 s) |

Harness arms (`benchmark/Kramabench/systems/dataflow_system.py`):
`DataflowSystemLunaNativeTools{Rule,All}Rep1` (LATEST) and
`DataflowSystemLunaNativeToolsRuleDeltaRep1` (DELTA). Multi-turn
(`benchmark/longds/arms.py`): `luna-native-rule-delta`, `luna-native-rule-latest`.
