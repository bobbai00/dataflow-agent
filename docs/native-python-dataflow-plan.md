<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

> **Superseded on 2026-09-22.** The JSON batch tool, the V1/V2 catalogs and
> `nativeToolMode` / `nativeCatalogVersion` described here were replaced by the
> expression program of [native-expression-mode.md](native-expression-mode.md).
> Operator semantics remain the reference; Transform/Derive are now `map`, UDF is `process`, and arguments are expression keywords, not JSON fields.

# Python-native operators and budgeted dataflow evidence

Status: implemented opt-in V2 contract and completed pilot, 2026-09-15.

The user subsequently authorized targeted evidence/repair improvements and a
four-arm, 104-task Luna/Terra-medium campaign. See the
[C8 implementation and full-workload protocol](checkpoints/native-python-dataflow-c8-campaign.md)
for exact behavior, tests, input corrections and comparison limits. Its live
gates and benchmark results must be recorded before claiming an improvement.
The checkpoint ledger at the end is the authority on what is implemented.
Examples labeled V2 are **not yet accepted by the running legacy catalog**.
The candidate opt-in V2 catalog now contains nineteen operators: the fourteen
C2/C3 core operators plus five C6 shape utilities. Matching-worker qualification
passes in DELTA/LATEST, and Terra-medium passes both real-model smoke modes.
The [14-attempt Luna/Terra pilot report](../benchmark/Kramabench/judgment_runs/native_python_dataflow_20260915/REPORT.md)
contains official cost/accuracy and input-timed data/flow evidence. Batching +
observe was cheaper and correct on both models in this one-task pilot; the
evidence treatments did not improve accuracy. V2 remains opt-in, not a default
rollout or a demonstrated general optimization win.

## 1. Scope and starting point

Implement on `feat/native-python-dataflow`, branched directly from
`feat/native-batch-observe` at
`41cd8ae97e30edfec90c847886ed4068dd0fa9b0` (shared batch scheduler).
The development worktree is
`.claude/worktrees/native-python-dataflow`. Do not use the separate
`feat/native-dataflow-evidence` prototype as the parent or merge it wholesale.

Preserve the existing `dataflow({operators, observe})` framework, shared
scheduler, forward references, existing-DAG edits, and DELTA/LATEST behavior.
The [batching contract](native-batch-tools.md) remains applicable. Run separate
agent services against the **same Texera backend**, with isolated workflows
and computing-unit registrations. Keep the existing services on 3008/3009;
reserve 3011 for this worktree after checking availability. An agent-only launch
must not restart shared backend services. For the candidate engine deployment,
the user explicitly authorized updating/restarting the shared master; this was
completed on 8085. Pilot references used isolated services on 3012 and 3013.

This work has two independently measurable parts:

1. Framework: a focused Python-native operator vocabulary with enforced
   contracts, actionable errors, and batch-oriented prompting.
2. Optimization: select useful, version-correct evidence from ordinary table
   profiles and operator input/output relationships, within the existing
   observation budget.

The reference remains native, all results, no statistics. Keep both that
historical reference and the batching-with-observe parent as controls; changing
the vocabulary and visibility policy changes the framework, not just the
optimization.

### What we are deliberately not building

- No dedicated `statistic`, `outliers`, hypothesis-test, or domain-analysis
  operators; no catalog mirroring of every operator in another paper.
- No benchmark-specific counters, golden-answer rules, or hardcoded inclusion
  criteria. Ordinary aggregates such as count/mean remain useful operators;
  ordinary null/distinct/distribution profiles remain useful metadata.
- No SQL expressions in the V2 API or SQL execution fallback for its operators.
  Existing saved V1 workflows retain their existing compiler and semantics.
- No attempt to infer an arbitrary Python program's row/column semantics from
  its source or from coincidentally equal input/output row counts.
- No autonomous correction of filters, joins, units, or scientific criteria.
  Evidence informs the model; it does not silently change its computation.
- No full benchmark campaign before correctness gates and a one-task pilot.

[DeepPrep](https://arxiv.org/pdf/2602.07371) motivates considering richer
operator/function boundaries. Our proposed Python contracts below are our own
API design, not a claim about that paper's exact callback implementation.
The research emphasis here is selective evidence from an executing dataflow,
not reproducing its operator list or search/training procedure.

## 2. Versioning and compatibility

Setting: `nativeCatalogVersion: "v1" | "v2"`, default `"v1"` until
rollout gates pass. Persist the version in each operator's `nativeOp` metadata
and in workflow snapshots. An absent version means V1. Initially require
`agentMode: "native"` and `nativeToolMode: "batch"` for V2; reject unsupported
combinations at settings validation rather than silently changing the mode.
This version gate is implemented in C2. Unsupported combinations return a
client error without partially updating the agent. A rejected creation must
not leave an agent registered. Operator/evidence qualification is complete;
default rollout is withheld because the pilot does not establish a quality win.

V2 tool schemas and prompts come from one versioned catalog. Do not present
both SQL Compute and Python Derive to the same V2 agent. A new V2 workflow uses
only V2 operators; a saved V1 workflow continues under V1. No automatic
SQL-to-Python migration, mid-turn catalog switching, or mixed-version graph
until explicit migration tests exist.

Use existing DataLoading/DataProcessing execution boundaries. The TypeScript
service emits Python but never imports Amber/frontend modules. Share pure
callback support in a worker module only when its deployment/version handshake
is available; initial generated helpers can be self-contained. A missing worker
capability must fail explicitly, not execute with older semantics.

## 3. Exact V2 tool and operator contracts

### 3.1 Common envelope

```json
{
  "operators": [
    {"op": "project", "id": "answer", "input": "source", "keep": ["value"]}
  ],
  "observe": ["answer"]
}
```

- `operators` is required; `[]` is a cached-observation-only call.
- `observe` is an optional array of operator IDs, default `[]`. Only explicitly
  requested successful result content is rendered. Receipts, invalidation,
  blocked dependencies, and errors remain visible without it.
- `op` and `id` are required for every edit. IDs follow the existing Python
  identifier validation and identify both additions and revisions.
- Retain the existing input-reference fields: sources have no input; unary
  operators require `input`; joins require `left` and `right`; union and UDF
  use ordered `inputs`. Internally a join still has ordered `[left, right]`
  ports, including when both refer to the same upstream ID.
- Unknown fields are rejected. Lists of column names must not contain
  duplicates. Referenced columns must exist; output names must be unique.
- Forward references and references to unchanged existing operators are legal.
  Duplicate edit IDs and cycles are rejected before mutation using the shared
  scheduler's graph validation, including paths through the existing DAG.
- The batch is not an atomic transaction. Independent valid edits can succeed;
  invalid edits and their dependents have separate error/blocked receipts.
- A post-batch execution phase computes the affected graph. This does not
  promise a single backend request for disconnected components.

All signatures below include the common fields. `?` denotes optional, and a
stated default is normative for V2. JSON examples are illustrative tables with
invented paths, not commands to run against benchmark data.

### 3.2 Data types, missing values, and function slots

Initial explicit scalar `dtype` values: `str`, `int64`, `float64`, `bool`,
`datetime`. Nullability is allowed unless a future schema explicitly forbids
it. Non-integral floats cannot silently become integers; a string such as
`"false"` cannot silently become boolean true. Datetimes normalize to UTC;
timezone-naive inputs require an explicit timezone when casting.

`func` is a string containing Python source defining **exactly one entry
function named `apply`**. Imports and helper functions are allowed; Python
syntax and entry signature are checked before execution. Do not rewrite
`true`, `false`, or `null` inside source/string literals when embedding JSON.

| Slot | Called with | Must return | Framework guarantee |
| --- | --- | --- | --- |
| Transform | `apply(value)` for one cell | One scalar of declared dtype or `None` | Same rows, same order, only declared columns change |
| Derive | `apply(row)` with a mapping of declared input columns | One scalar of declared dtype or `None` | Same rows, same order, one declared output column per specification |
| Filter | `apply(row)` with a mapping of declared input columns | `bool` or `None` | A stable subset of input rows |
| UDF | `load()` or `process(input_id, ...)` | A pandas DataFrame | No row/lineage guarantee beyond measured output schema |

Pandas/NumPy missing scalar values are normalized to `None` before scalar
callbacks. Output `None` is a missing value. A filter's `nulls` policy controls
`None`; other types, including truthy strings, are errors. No implicit
exception-to-null behavior in callbacks. NumPy scalar equivalents are accepted
only through explicit scalar conversion, not arbitrary object truthiness.

The wrapper owns a private row identity independent of pandas' user index.
Callbacks do not receive the entire DataFrame or private identity. It constructs
the output rather than trusting a returned table's length. Input indexes may
be duplicated or non-contiguous. An empty input still produces the declared
output schema without calling `apply`. User-source AST validation is **not a
security sandbox**; existing worker resource/isolation limits still apply.

Multiple changes inside one Transform or Derive read the original input, not
earlier outputs in the same operator. For dependent expressions, use separate
operators **in the same batch**. This makes dependencies explicit without an
extra LLM round trip. Vectorized callback modes are deferred until profiling
shows they are necessary; if added, they need explicit schemas and row-identity
checks, not an automatic whole-DataFrame shortcut.

### 3.3 Scan, Project, Cast, FillNull

```json
[
  {"op": "scan", "id": "raw", "files": "data/example.csv", "preview": 8, "skipLines": 80},
  {"op": "scan", "id": "source", "files": ["data/a.csv", "data/b.csv"], "header": true, "allText": true, "fileColumn": "source_file"},
  {"op": "project", "id": "selected", "input": "source", "keep": ["region", "amount"], "rename": {"amount": "value"}},
  {"op": "cast", "id": "typed", "input": "selected", "columns": [{"column": "value", "dtype": "float64"}], "errors": "raise"},
  {"op": "fill_null", "id": "filled", "input": "typed", "values": {"region": "Unknown"}}
]
```

- **Scan**: `files: string | string[]`; optional `format="auto"`,
  `skipLines=0`, `header=true`, `names`, `allText=false`, `delim`, `comment`,
  `widths`, `sheet`, `encoding`, `fileColumn`, `preview` (1..200).
  Reuse supported file-format routing with Python readers in V2. Supported
  explicit formats: `auto`, `csv`, `lines`, `fwf`, `whitespace`, `excel`,
  `html`, `json`, `parquet`; extension detection applies in `auto`.
  `names` requires `header=false` and an exact column count. `widths` applies
  only to FWF. Reject incompatible options rather than silently ignoring them.
  Do not silently swallow read/parse failures or rename duplicate headers.
  `fileColumn` adds a visible basename and must not overwrite an existing
  column; internal provenance keeps the full resolved identity separately.
  Preview is a diagnostic source, not the parsed full table.
  Resolve/deduplicate paths and read them in canonical sorted order. CSV/FWF/
  whitespace/HTML infer scalar values from text; `allText:true` disables that.
  JSON/Parquet/Excel preserve explicit string cells such as `"001"` and `"true"`.
  Text encoding uses an explicit `encoding` when supplied, otherwise BOM/UTF-8
  detection with a strict CP1252 fallback, recording the choice. Literal
  `NA`/`NULL` text is not automatically treated as missing. Multiple parsed
  files use compatible-type column alignment; parsing options apply to every
  selected file and incompatible options fail.
- **Preview offset contract**: text returns at most `preview` physical lines
  per selected file starting at zero-based `skipLines`, preserving absolute
  `line_no`. Blank lines and comments count as physical lines. Excel returns
  that window of physical rows per sheet, with absolute `row_no`. HTML's
  legacy preview synthesizes a header at row 0; `skipLines` skips data rows,
  their `row_no` stays one-based, and the header is included only at offset 0.
  Thus zero-offset HTML may have `preview + 1` display rows. Beyond EOF returns
  an empty table with a stable schema. Binary-file pointer previews cannot be
  offset: reject nonzero `skipLines` with a useful explanation.
  Preserve legacy caps (five text files, first workbook/HTML file) in the
  initial offset fix; V2 must report preview coverage/truncation explicitly.
  Do not claim a preview profile describes the full source. Legacy non-preview
  `format:"lines"` numbering stays relative after skipping; V2 should use
  absolute source positions, as a documented versioned change.
- **Project**: `keep?: string[]`, `drop?: string[]`,
  `rename?: {oldName: newName}`; at least one required. `keep` and `drop`
  are mutually exclusive. Select in `keep` order (otherwise input order),
  then rename. No row change. Missing columns/name collisions are errors.
- **Cast**: `columns: [{column, dtype, format?, timezone?}]`,
  `errors?: "raise" | "null"` (default `"raise"`). `format` and `timezone`
  apply only to datetime. Standard explicit Python conversions, not silent
  thousands-separator stripping or guesswork about decimal/date formats.
  Use Transform for normalization first. `errors:"null"` explicitly permits
  failed conversions; retain conversion-failure counts and bounded witnesses
  as generic conversion metadata, not a separate statistics operator.
- **FillNull**: `values: {column: scalar}` with at least one entry. Replace
  only missing cells and validate replacement compatibility. No implicit
  imputation, forward fill, group fill, or changes to row membership.

### 3.4 Transform and Derive replace SQL Compute

```json
[
  {
    "op": "transform", "id": "normalized", "input": "source",
    "columns": [{"column": "amount", "dtype": "str", "func": "def apply(value):\n    return None if value is None else str(value).strip().replace(',', '')"}]
  },
  {
    "op": "derive", "id": "rates", "input": "typed",
    "columns": [{"as": "rate", "inputs": ["events", "population"], "dtype": "float64", "func": "def apply(row):\n    p = row['population']\n    e = row['events']\n    return None if p in (None, 0) or e is None else 1000.0 * e / p"}]
  }
]
```

- **Transform**: `columns: [{column, dtype, func}]`, nonempty. Replaces only
  named existing columns, per-value. List/table returns are contract errors.
- **Derive**: `columns: [{as, inputs: string[], dtype, func}]`, nonempty;
  `replace?: boolean=false`. Adds columns, or explicitly replaces existing
  ones when `replace=true`. Each callback sees only its declared `inputs`.
  An empty `inputs` list permits constants. Undeclared column access is an
  actionable callback error. Independent derived columns may share an operator.

The transformation classification comes from the enforced operator contract,
not a model assertion or a heuristic code classifier. Special parsing or
scientific calculations can remain in UDF; simple string/number/date handling
no longer needs a whole-table UDF or SQL expression.

### 3.5 Filter

```json
{
  "op": "filter", "id": "eligible", "input": "typed",
  "columns": ["value", "region"],
  "func": "def apply(row):\n    v = row['value']\n    return v is not None and v > 0 and row['region'] != 'Unknown'",
  "nulls": "drop"
}
```

`columns: string[]`, `func`; `nulls?: "drop" | "keep" | "error"="drop"`.
`columns` declares all predicate inputs; `[]` permits a constant predicate.
Evaluation is per row; order is preserved and surviving rows retain identity.
An exception or non-boolean return does not silently drop a row. Record input,
kept, rejected, and missing-predicate counts. Distributions of relevant columns
before/after are observations, not proof the scientific criterion is correct.

### 3.6 Aggregate, Join, Union

```json
[
  {"op": "aggregate", "id": "totals", "input": "eligible", "groupBy": ["region"], "aggregations": [{"fn": "sum", "col": "value", "as": "total"}, {"fn": "count", "as": "rows"}]},
  {"op": "join", "id": "labeled", "left": "totals", "right": "labels", "on": [["region", "region_id"]], "type": "left", "validate": "many_to_one"},
  {"op": "union", "id": "combined", "inputs": ["part_a", "part_b"], "schema": "strict"}
]
```

- **Aggregate**: `groupBy?: string[]=[]`,
  `aggregations: [{fn, col?, as}]` (nonempty).
  `fn` is `count | count_distinct | sum | mean | min | max | median | stddev |
  first`. `as` is required. Only `count` may omit `col` (count rows); otherwise
  count ignores nulls. Numeric functions require numeric input: cast explicitly
  instead of silently converting malformed values. Null grouping keys form a
  group. Other reductions ignore null values; an all-null reduction is null
  except count/distinct-count (0); stddev is sample stddev (`ddof=1`, null for
  fewer than two nonnull values). `first` returns the first value, including a
  null, in input order. No grouping yields one row even on empty input; grouping
  an empty input yields zero rows with a declared schema. Preserve first-seen
  group order. No custom reducer callback in the first version; use UDF for
  special-purpose statistics. No SQL aggregate expressions.
- **Join**: `left: string`, `right: string`, `type?: "inner" | "left" | "right" |
  "full" | "cross"="inner"`; `on?: string | string[] | [string,string][]`.
  Non-cross joins require nonempty keys; never infer a cross join from a missing
  `on`. Cross join forbids `on` and accepts only the default
  `validate:"many_to_many"`; it has no equality keys whose uniqueness could
  satisfy another validation policy. `nullsEqual?: boolean=false`,
  `rightSuffix?: string="_right"`, `validate?: "one_to_one" | "one_to_many" |
  "many_to_one" | "many_to_many"="many_to_many"`. Validate uniqueness on the
  relevant eligible keys before merge (nonnull by default; null keys also
  participate when `nullsEqual:true`); explicit cardinality constraints failing
  are errors. Missing keys/suffix collisions/type mismatches are errors.
  Self-joins retain ordered left/right port identity. No promised global row
  order; use Sort when needed. Generic evidence measures unmatched keys and
  multiplicity even without a restrictive `validate`.
- **Union**: `inputs: string[]` (at least two),
  `schema?: "strict" | "align"="strict"`. Strict requires compatible named
  schemas; align takes the union of columns in first-seen order and fills
  absent values with null. Incompatible types require an explicit cast. Preserve
  all rows, input-port order and within-input order; never deduplicate silently.

### 3.7 Distinct, Sort, Limit, Window

```json
[
  {"op": "distinct", "id": "unique", "input": "source", "columns": ["entity"], "keep": "first"},
  {"op": "sort", "id": "ordered", "input": "unique", "by": [{"col": "value", "desc": true}], "nulls": "last"},
  {"op": "limit", "id": "top", "input": "ordered", "n": 10, "offset": 0},
  {"op": "window", "id": "lagged", "input": "source", "partitionBy": ["entity"], "orderBy": [{"col": "date"}], "columns": [{"fn": "lag", "col": "value", "as": "previous", "offset": 1}]}
]
```

- **Distinct**: `columns?: string[]` (whole row if omitted),
  `keep?: "first" | "last"="first"`. Missing values compare equal for this
  operation. Retain the chosen whole row and its relative input order.
- **Sort**: `by: [{col, desc?: boolean=false}]` (nonempty),
  `nulls?: "first" | "last"="last"`. Stable ties; same row identities.
- **Limit**: `n: integer>=1`, `offset?: integer>=0=0`. Stable positional slice;
  not a top-k guarantee without Sort. Out-of-range produces an empty schemaful
  table.
- **Window**: `partitionBy?: string[]=[]`, `orderBy: [{col, desc?}]`
  (nonempty), `columns: [{fn, col?, as, offset?}]` (nonempty).
  First release supports only `lag`, `lead`, `row_number`, `rank`, `dense_rank`.
  `lag`/`lead` require `col`; `offset` defaults to 1 and must be positive;
  the other functions forbid both. Rank is one-based; ties follow the declared
  order keys, row_number breaks ties stably. Missing order values sort last;
  missing partition keys form one partition. Calculate within partitions and
  restore input row order. No rolling/custom window callback yet; UDF handles
  it until a demonstrated need justifies a separate contract. All output names
  must be new and unique; multiple window outputs read the original input.
  Lag/lead preserve the referenced column's nullable scalar domain. Boundary
  nulls and nulls propagated from existing cells are measured separately.

### 3.8 Small shape-changing operators, gated by tests and need

```json
[
  {"op": "split", "id": "parts", "input": "source", "column": "label", "into": ["code", "description"], "separator": ":", "keepSource": true},
  {"op": "explode", "id": "items", "input": "source", "column": "tags", "encoding": "json", "empty": "drop"},
  {"op": "unpivot", "id": "long", "input": "source", "columns": ["y2024", "y2025"], "nameColumn": "year", "valueColumn": "amount"},
  {"op": "pivot", "id": "wide", "input": "long", "index": ["entity"], "columns": "year", "values": "amount"}
]
```

- **Split**: `column`, `into: string[]` (at least two), `separator` (nonempty
  literal), `keepSource?: boolean=true`. Split at most `len(into)-1` times;
  pad missing pieces with null, keep the remainder in the last output.
  Missing input gives all-null outputs. Reject non-string input and collisions.
  Output names must be new even when `keepSource:false`; dropping a source is
  not implicit permission to reuse its name. Empty-string pieces stay strings.
  Regex extraction stays in Transform/Derive, not a second regex mini-language.
- **Explode**: `column`, `encoding: "json"`,
  `empty?: "drop" | "null_row"="drop"`. Parse JSON-array strings, output one
  row per element in array order, repeat other columns, and record the parent
  identity/element position. Null or empty array follows `empty`; invalid JSON,
  non-array JSON and nonscalar elements fail clearly. Initial elements must be
  one compatible scalar type plus nulls. This deliberately avoids assuming
  arbitrary Python lists can pass the current engine's scalar-column transport.
  C6 uses the same strict logical-domain policy as Union: int64/float64 and
  bool/int64 mixing is rejected, not promoted. Normalize in UDF when intended.
  Integers must fit int64; numeric elements must be finite; JSON NaN/Infinity
  constants are invalid. Empty/all-null output has a nullable string domain
  until a later execution supplies a nonnull element. Types may therefore change
  on revision and must be observed/versioned. Empty parents can be dropped, so
  Explode's row effect is `multiply` (may shrink or expand), not `add`.
- **Unpivot**: `columns: string[]` (nonempty), `nameColumn?: string="variable"`,
  `valueColumn?: string="value"`. Other columns stay as keys. One output row
  per input row and selected column, including null cells; input-row order then
  selected-column order. Selected columns must share a compatible value type.
  As with Union, distinct known logical types require an explicit cast. Untyped
  all-null columns can adopt the other selected columns' type. Output names
  cannot collide with retained keys or each other; selected names are removed.
- **Pivot**: `index: string[]`, `columns: string`, `values: string`.
  Require unique `(index..., columns)` pairs; duplicates are an error with
  a witness, not an implicit aggregation. Aggregate first when intended. Null
  index values are valid keys, null pivot-column values are errors. Generated
  column names are strings; collisions are errors. Missing cells become null.
  Preserve first-seen row/key order and report the dynamic schema. Test empty
  input and schema changes before exposing this operator. `index`, `columns`
  and `values` must reference distinct columns. An empty input yields zero rows
  and only the index schema (zero columns when `index:[]`). Nonempty input with
  `index:[]` yields one row. Empty generated names are rejected. Missing cells
  count absent pairs, not input values that were already null.

These are bounded table operations, not special-purpose analysis operators.
Ship only after their individual execution/transport/empty-schema tests pass;
they need not all enter the first V2 release. Transpose, specialized reshape,
fitting, geospatial analysis, and unusual statistics remain in UDF. Concatenating
strings uses Derive; date parsing uses Cast/Transform, not extra tools.

### 3.9 General UDF escape hatch

```json
{
  "op": "udf", "id": "analysis", "inputs": ["eligible"],
  "code": "def process(eligible):\n    import pandas as pd\n    values = eligible['value'].dropna()\n    return pd.DataFrame({'q90': [values.quantile(0.9)]})"
}
```

`inputs?: string[]=[]`, `code: string`. Zero inputs requires `load()`; other
cases require `process(<input IDs in port order>)`. Return one pandas DataFrame.
The wrapper validates the engine-compatible output schema and surfaces import,
syntax, runtime, and transport failures. Do not advertise arbitrary packages as
installed. UDF is not a back door that acquires a row-preserving classification;
its semantic effect stays `unknown` unless using a future enforced contract.

## 4. Batching and system-prompt changes

The V2 prompt must describe Python contracts and common null/type pitfalls,
not just rename Compute. Generate signatures from the actual catalog and test
examples against tool validation and execution. Retain V1 prompt snapshots.

Principles to teach explicitly:

1. Batch a known chain, even when later operators depend on earlier ones or
   the array lists consumers first. The same scheduler resolves dependencies.
2. Use a separate observation boundary only when returned data is needed to
   choose the next operation (unknown header, dtype, inclusion criterion).
3. To see an operator's successful content, explicitly name it in `observe`.
   Omitted `observe` and `observe:[]` mean receipts/errors only.
4. Downstream operators still execute when needed. A hidden successful result
   is not an absent result. Upstream revisions invalidate affected descendants;
   receipts announce recomputation without leaking their table bodies.
5. Use a cached observe/inspect for existing evidence; do not recreate a source
   just to display it. Inspect cannot conjure uncollected full-table data.
6. Observe the final answer operator before answering. Handle errors first;
   never use a stale successful result after a failed revision.
7. A current result already visible from a completed observation can support
   a direct final answer; do not repeat an edit or cached read just because
   LATEST collapses the trajectory. LATEST renders the current dataflow and a
   bounded current-task last-action receipt, not the whole action history.
   The receipt contains statuses/targets, not parameters or hidden content.
   DELTA continues to retain event-frozen observations.

### Example A: known chain with forward references (V2)

```json
{
  "operators": [
    {"op": "aggregate", "id": "answer", "input": "positive", "aggregations": [{"fn": "mean", "col": "value", "as": "mean_value"}]},
    {"op": "filter", "id": "positive", "input": "typed", "columns": ["value"], "func": "def apply(row):\n    return row['value'] is not None and row['value'] > 0"},
    {"op": "cast", "id": "typed", "input": "source", "columns": [{"column": "value", "dtype": "float64"}]},
    {"op": "scan", "id": "source", "files": "data/values.csv", "allText": true}
  ],
  "observe": ["answer"]
}
```

One tool call, a dependency-ordered execution, and only the answer's successful
content. This is appropriate when the source schema is already known.

### Example B: dependent new columns, no extra round trip (V2)

```json
{
  "operators": [
    {"op": "derive", "id": "scaled", "input": "typed", "columns": [{"as": "percent", "inputs": ["fraction"], "dtype": "float64", "func": "def apply(row):\n    v = row['fraction']\n    return None if v is None else 100.0 * v"}]},
    {"op": "derive", "id": "rounded", "input": "scaled", "columns": [{"as": "display", "inputs": ["percent"], "dtype": "float64", "func": "def apply(row):\n    v = row['percent']\n    return None if v is None else round(v, 2)"}]}
  ],
  "observe": ["rounded"]
}
```

### Example C: upstream revision plus a new branch on an existing DAG (V2)

Assume `source -> typed -> positive -> answer` already exists. Revise
`positive` and add a consumer of the unchanged definition of `answer` together:

```json
{
  "operators": [
    {"op": "project", "id": "final", "input": "answer", "keep": ["mean_value"]},
    {"op": "filter", "id": "positive", "input": "typed", "columns": ["value"], "func": "def apply(row):\n    return row['value'] is not None and row['value'] >= 10"}
  ],
  "observe": ["final"]
}
```

`answer` must recompute before `final` reads it. Its unchanged ID or unchanged
row count is not permission to reuse its old values.

### Example D: deliberate discovery and cached observation (V1 and V2)

```json
{"operators":[{"op":"scan","id":"preview","files":"data/values.csv","preview":8,"skipLines":80}],"observe":["preview"]}
```

Use what the preview actually shows to choose the full Scan's parsing options.
Later, `{"operators":[],"observe":["answer"]}` displays the cached current
answer without rerunning the graph. `{"operators":[],"observe":[]}` displays
no successful table content. A preview past EOF is a valid empty result, not
proof the entire file is empty.

## 5. Errors are part of the public operator API

Hiding generated boilerplate is useful; hiding actionable failures is not.
The current batch path already exposes errors independently of `observe`.
Preserve that behavior and add structured, revision-specific diagnostics before
exposing new callback operators.

### 5.1 Implemented V2 diagnostic envelope

The existing error transport remains a string with a `NATIVE_ERROR_V2:` payload.
Snapshot storage binds that payload to the event and adds a sanitized
`nativeError` summary to the normal operator-result API. For example:

```json
{
  "nativeError": {
    "diagnosticId": "diag_0123456789abcdef01234567",
    "operatorId": "typed",
    "operatorRevision": "c8c41aa9b80450d1",
    "stepId": "step-12",
    "executionId": "12",
    "phase": "execution",
    "diagnostic": {
      "version": 1,
      "operatorId": "typed",
      "operatorRevision": "c8c41aa9b80450d1",
      "code": "CAST_INVALID_VALUE",
      "stage": "execute",
      "message": "Cannot cast 'value' to float64: invalid numeric value. Normalize the input or explicitly set errors:null.",
      "field": "columns[0]"
    }
  }
}
```

`phase:"attempt"` identifies a rejected submitted definition which never
replaced the stored DAG. Its `executionId` is null; execution-phase diagnostics
also use null when execution identity is unavailable, not an invented ID.
`field`, `source`, `hint`, and `retryable` are optional. Default repair hints are
selected by code while rendering if the payload has no hint. Callback failures
include `source: {entry:"apply", line:3, column:5, excerpt:"..."}` in the
**submitted function**, not the generated wrapper. Lines are one-based. The
outer identity owns the failed/blocked operator; a propagated diagnostic can
identify an upstream origin, verified against the same event's workflow.
Unknown/stale bindings withhold source attribution. Relevant bad values can
appear in a bounded message; this is not a new general-purpose witness or
statistics API. Consumed-input version references live in the private record
and expanded text only when the execution binding actually proves them.

| Stage / class | Examples | Expected response |
| --- | --- | --- |
| Validate | Unknown field, missing input/column, cycle, invalid dtype | Field path and expected shape; no engine execution |
| Compile | Python syntax/entry-signature error | Submitted source line/caret and repairable message |
| Execute / user code | Division by zero, import failure, bad conversion | Relevant input/type/witness and source location; no fake success |
| Contract | Wrong return type, undeclared access, invalid join cardinality | Actual versus required shape/type, bounded example |
| Dependency | Upstream edit/execution failed | `blocked` with upstream ID/revision; not a misleading empty table |
| Infrastructure | Timeout, worker death, unavailable package/backend | Distinct code and retryability; do not blame model syntax |
| Profile | Optional profiler unavailable or over budget | Valid data result remains valid; mark evidence unavailable |

Rules:

- Errors and blocked receipts bypass successful-result hiding and evidence
  ranking, including with `observe:[]`. Include them in DELTA and LATEST.
- Reserve a separate bounded diagnostic budget; never truncate away operator
  identity, error code, stage, or the essential repair message. Long values and
  extra witnesses may be elided with an explicit marker.
- Preserve bounded sanitized traceback and submitted-source context in private
  snapshot diagnostics. Accepted generated code/source maps remain in their
  immutable workflow snapshots; rejected preflight submissions have no generated
  execution to reconstruct. Use the `inspectError` contract below for expanded
  diagnostics, not successful-table inspection or an environment dump.
- A failed new revision supersedes its old success. Downstream results tied to
  the old revision cannot render as fresh. Independent branches may complete.
- An exception is not an output row. A generic UDF returning a user-defined
  error-looking table is still user data; the runtime must not treat that as
  its own diagnostic protocol.
- Catch syntax errors before expensive execution where possible. Do not execute
  a callback merely to validate its source. Keep worker traceback chains for
  diagnosis; strip framework noise only from the model-facing excerpt.
- Explicit lossy conversion (`errors:"null"`) is a successful operation with
  conversion metadata, not a hidden failure. It must not swallow infrastructure
  errors, missing columns, or contract violations.
- Diagnose failures without exposing credentials, global variables, or unrelated
  records. Witnesses are limited to relevant authorized input columns.

### 5.2 Error inspection, budgets and rejected-edit state

The V2 batch tool set adds `inspectError({operatorId, revision?, diagnosticId?})`.
It reads this agent's retained records only, never runs the engine, modifies a
workflow, creates a workflow snapshot, or returns successful table content.
Only `operatorId` means the current unresolved error. After repair, specify an
exact revision or diagnostic ID to inspect history. Revision lookup selects
the newest retained matching failure on the active branch; `diagnosticId`
disambiguates repeated executions and can address another retained branch of
the same agent. IDs are SHA-256-derived from the captured event/diagnostic,
not an authorization mechanism. Missing/pruned records are unavailable, never
reconstructed from today's code. A saved tool output is replayed as an event
fact: inline for native DELTA, or in the existing bounded inspection history
for other layouts/LATEST. It does not change to say "success" after repair.

The separate allowances are **1,200 detail characters per normal diagnostic
render** and **4,000 per expanded inspection**, not a whole-step or token
budget. The mandatory identity envelope is outside those allowances and is
never silently shortened. Ordinary message/hint/source excerpts have smaller
component caps; expanded inspection can show up to 1,600 message characters,
five submitted-source lines, and verified input-version references. Extra
detail is explicitly marked omitted. Private records retain at most 16,384
traceback characters and a 12,000-character submitted-source prefix, with
completeness flags; generated-runtime prefixes are not passed off as useful
expanded error excerpts. Credential-shaped strings and the known delegated
token are redacted without shifting source line numbers. This is defense in
depth, not a claim to recognize every possible secret embedded in arbitrary
user text. No environment enumeration, console dump, or table scan is performed.

Rejected definitions are separate control state from materialized tables.
Their old successes and dependent outputs are unavailable even though the last
accepted DAG definition remains visible. A later consumer cannot silently
execute that older definition, and an upstream rerun does not forgive a syntax
rejection. Independent targets can still execute. An explicit accepted
resubmission—including deliberately restoring identical accepted code—clears
the rejection and allows fresh execution; skipped dependent edits must be
resubmitted too. Historical snapshots/diagnostics remain unchanged.

External access is `POST /api/agents/:id/inspect-error` with the same query JSON
and the caller's Bearer token. It requires the agent owner, a bound workflow,
and a successful authenticated Texera workflow-read check. Decoding a JWT alone
is not signature verification; Texera's protected route verifies the supplied
token and current read permission. No stored-token fallback, redirects, raw
backend error body, or cached authorization is used. The check times out after
five seconds and fails closed. Responses: 200 for a retained diagnostic, 404
for unavailable history, 400 for invalid arguments, 401/403 for rejected access,
503 when permission verification is unavailable. The ordinary snapshot/result
API includes only the sanitized summary, not private records.

This new endpoint does **not** harden the pre-existing trusted-local agent REST
and WebSocket surfaces, which already expose workflows/traces and can drive
model tools. Protect those surfaces at deployment; do not treat this endpoint
alone as a multi-tenant security boundary. In-loop `inspectError` is scoped by
the existing delegated agent session and cannot select another agent or log
path. Full agent-service authentication is outside this operator experiment.

## 6. Data optimization: ordinary profiles, selectively exposed

### 6.1 What is calculated

For each materialized output port, collect a typed schema, row/column counts,
and ordinary per-column profiles from the executed data, not the rendered
sample. Reuse existing telemetry where correct; first audit its scope and
multi-yield/partition behavior before adding fields.

- `N`: rows; `null(c)`: missing values; nonnull count `N-null(c)`.
- `distinct(c)`: distinct nonnull values. Null ratio is `null(c)/N`; uniqueness
  ratio is `distinct(c)/(N-null(c))`. A zero denominator is undefined, not 0.
- Categorical frequencies: bounded top values/counts plus other-count and
  explicit truncation. Show all values only when cardinality fits the budget.
  Do not equate a top-k list with the complete distinct-value set.
- Numeric/date ranges over nonnull compatible values; optional fixed quantiles
  or histograms only when useful and supported by a documented exact/sketch
  algorithm. Do not label sampled/sketched quantiles exact.
- Generic structure: duplicate rows, all-null rows/columns, and unresolved
  headers when detectable. Preserve source file/sheet/parse/preview coverage.

Do not add arbitrary task-specific metrics. Operator-specific operational
facts (e.g., conversion failures or join multiplicity) belong to the operator
contract and flow evidence, not a custom-statistics API.

Counts may be merged across disjoint chunks/partitions; distinct counts cannot
be added. Use an exact set within limits or a mergeable sketch with accuracy
metadata. Min/max and histograms need compatible domains/bins. Multi-yield
DataFrames cannot silently overwrite each other's profile. If telemetry only
covers a sample/chunk, label it partial and suppress exact full-table claims.

Suggested structured carrier:

```json
{
  "version": 1,
  "resultVersion": "workflow/op-revision/port/execution/input-versions",
  "coverage": {"scope": "full", "rowsProcessed": 120, "complete": true},
  "schema": [{"name": "region", "type": "str"}],
  "rowCount": 120,
  "columns": {"region": {"nullCount": 2, "distinctCount": 4, "exact": true}}
}
```

Carry it as reserved result metadata, never a user-table column. TypeScript
consumes structured values, never parses human-readable rendered stats back
into facts. Instrument collection time, bytes, algorithm, and omissions.

### 6.2 What the model receives

Collection and exposure are separate. For an observed operator, select evidence
inside its existing result-character/token budget, competing with samples.
Do not append a new large block for every operator. Preserve complete small
answer tables ahead of redundant statistics. If the whole table is visible,
suppress statistics that merely restate it.

Prioritize schema/arguments used by the current operation, explicit join/group
keys, conversion/predicate inputs, provenance, actual structural anomalies,
and then generally relevant column/value coverage. Task text may provide a
generic relevance hint; no benchmark IDs, gold answers, or domain-specific
inclusion rules may enter the selector. Deterministic ties and omission reasons
make selections auditable. Do not select solely the first fixed number of
columns or only the rarest value: both can hide a useful eligibility field.

Successful facts remain opt-in through `observe`. An unobserved result does
not leak a data profile through its receipt. An observed downstream result can
include a compact relational fact referencing its inputs (with IDs/versions),
not dump all upstream tables. Existing cached inspection only exposes collected
samples/stats. If a requested metric was not collected, say so; computing it
requires an explicit execution/inspection capability, not a hidden rerun.

### 6.3 Implemented C5 exposure and budget contract

The selector and context integration are implemented in `7fe9e30cd`, with local
tests described in the [C5 checkpoint](checkpoints/native-python-dataflow-c5-selection.md).
The live C5 eight-case matrix now passes at the final candidate, as recorded
in the [Terra/live checkpoint](checkpoints/native-python-dataflow-c7-terra.md).
V2 keeps the same batch/operator API;
it does not gain a model-authored statistics tool or a second result budget.

- `nativeProfileCollection` controls collection on fresh workflows.
- A positive `dataLevel` or `columnStats:true` enables selected data profiles;
  a positive `flowLevel` enables selected flow evidence. For clean data-only,
  flow-only and combined ablations, set `columnStats:false` and use 0/1 levels.
  The Python framework control sets both levels to 0 and collection off; a
  collector-only control keeps both levels at 0 with collection on.
- All successful V2 result bodies use the same typed rendering path, including
  evidence-off arms. Their counts, schema, samples, facts and version labels
  share `maxOperatorResultCharLimit`. Complete small tables outrank redundant
  output profiles. Otherwise schema relevance, atomic sample rows and facts
  participate in a deterministic greedy selection with auditable omissions.
  This is not a learned or globally optimal selector.
- `Data measurement` labels ordinary profile facts and their full/partial
  coverage. `Flow guarantee` labels an enforced contract; `Flow measurement`
  labels version-matched counters and input/output comparisons. Native
  operational counters can remain exact when optional column collection is
  partial; missing counters cannot be reconstructed from marginal profiles.
- DELTA records the selection after each successful explicit observation,
  including cached reads. Settings/relevance changes do not rewrite it.
  Compaction can only shorten it and cannot expose an unobserved success.
  LATEST renders the current explicit observe set using current settings.
- Snapshot API responses may include event-owned `nativeObservations`: result
  and input version references, exposure options, rendered text, selected and
  omitted IDs/reasons, and atomic render chunks. This audit record is not
  automatically exposed for unobserved operators. V2 cached inspection with
  `stats:true` also uses structured profiles and the same result budget.

V2 now also requires backend capability `schema-fields-only-v1`. This prevents
synthetic row indices or name-based visualization handling from overwriting
schema-declared user columns. An older C4 typed backend is rejected explicitly;
build and deploy the matching engine/API before starting V2 live qualification.
Legacy/V1 transport and successful-result formatting remain compatible.

## 7. Flow optimization: inputs + semantics + measured outputs

Flow evidence is derived by joining version-matched input/output metadata with
the declared and enforced operator contract. Separate three kinds of facts:
guarantees from the contract, measurements from complete execution, and
heuristic warnings. Never present a warning as proof of task correctness.

| Operator family | Calculation / useful evidence | Limit |
| --- | --- | --- |
| Scan | Resolved sources, parsing choices, source positions, preview/full coverage | Preview counts describe the preview only |
| Project | Exact selected/dropped/renamed column mapping; same row identities | Equal row counts alone do not establish this for a UDF |
| Cast / Transform / Derive / FillNull | Declared input-to-output column dependencies; dtype changes; null delta; changed-cell and conversion counts when collected | A new null need not be an error if explicitly requested |
| Filter | `kept/N`, rejected and missing-predicate counts; distributions of predicate columns before/after | No automatic inference of the right eligibility rule |
| Aggregate | Input rows, output groups, group-size distribution, per-aggregate nonnull denominator | A correct mean calculation can still use the wrong population |
| Join | Per-key multiplicities, matched/unmatched rows and distinct keys on each port, output expansion | High key coverage does not establish semantic key correctness |
| Union | Input row sum versus output count, aligned-column gaps, provenance by input port | Identical filenames are not identical source identities |
| Distinct / Limit | Removed count and declared key or positional basis | Removing rows is not necessarily desirable |
| Sort / Window | Preserved identities, partition/order keys, ties, missing lag/lead outputs | Never imply unspecified order is meaningful |
| Split / Explode / Reshape | Named column lineage, parent-to-output mapping or expansion counts, pivot uniqueness | Dynamic output schema must be measured/versioned |
| UDF | Measured schema/count/profile changes and input port IDs | Semantic row/column mapping stays unknown |

For an equijoin, with eligible-key multiplicities `L(k)` and `R(k)`, matched
output contribution is `sum_k L(k)*R(k)` over common keys. Count unmatched
rows separately for the selected outer-join semantics, respecting `nullsEqual`.
Report row coverage and distinct-key coverage with their denominators; do not
confuse matching 119 output rows with matching 119 distinct entities. Exact
join facts may be collected during execution/key aggregation; profiles alone
cannot reconstruct joint-key overlap or composite-key multiplicity. Unknown
facts stay unknown rather than being estimated from unrelated marginal stats.

Row identities/provenance are internal metadata, not hidden user columns that
can collide with data. Prefer compact parent mappings and aggregate operational
counters; do not retain an unbounded full lineage graph per output row. Carry
full source identity and port roles even when visible basename tags collide.
Known projection/rename lineage can propagate; arbitrary callbacks declare
dependencies, not symbolic proofs of their formulas.

C6's local implementation records immediate-input mapping without an unbounded
lineage graph. Explode retains at most sixteen `(inputPosition, elementPosition)`
witnesses and an explicit completeness flag in internal metadata (a synthetic
null row has no element position). Unpivot records the exact row-major mapping
rule and selected-column order. These are positional identities within the
declared input port, not user columns or claims of full source-file lineage.
Window restores private positional identity after partition sorting; its
measurements distinguish boundary nulls from all output nulls. Pivot measures
unique pairs, index groups, generated columns and absent cells. C5 version and
budget gates also apply to these facts; missing/inconsistent counters stay
unavailable rather than being reconstructed from sampled rows.

### Result versions and invalidation

Key every result/evidence bundle by workflow, operator-definition revision,
output port, execution, input result versions, and source fingerprint where
available. File path alone is not a freshness guarantee; cached reads must
state their execution version. Upstream revision invalidates descendants'
data, profiles, flow facts and cached rendered views. Late messages from an
older execution must not overwrite the newer state.

- DELTA: freeze the observation and evidence selection for its event/revision;
  append updated receipts/results on revision, never rewrite historical facts.
- LATEST: render the current DAG and the current explicitly observed successful
  results, not the union of all historical `observe` sets. Stale data is hidden
  or clearly unavailable. Requested saved inspections remain pinned to their
  original versions and labeled separately.
- Same row count/schema does not mean same values. Recompute a downstream
  aggregate after its input changes even if it still has one output row.
- Profile failures do not invalidate a successful result; execution failure
  does. Missing/partial/stale metadata is not evidence of an empty table.

## 8. Implementation sequence and checkpoint gates

Each checkpoint is a small reviewable commit (or coherent commit series), with
tests before implementation and an updated ledger. Push normal commits to the
new branch; do not rewrite the batching parent or checkpoint untested scaffolding
as a finished feature. Working notes/results belong here or under a dated
`docs/checkpoints/` report; raw benchmark artifacts stay in the harness.

| Checkpoint | Work and primary locations | Required gate |
| --- | --- | --- |
| C0: plan | This document, committed alone from the batching parent | Review exact contracts/non-goals; push branch before implementation |
| C1: Scan discovery correctness | `agent-service/src/agent/native/codegen.ts`, catalog text, executed-code regression tests, `benchmark/e2e/` | Preview offsets/EOF/schema tests; real backend batch/error/revision smoke; DELTA and LATEST |
| C2: Python contract/error foundation | Versioned native catalog/compiler, worker-safe callback wrappers, source maps, error types/rendering and prompt generator | Syntax/runtime/contract failures actionable with hidden successes; nullable/empty inputs; no SQL in V2 callbacks; legacy tests unchanged |
| C3: focused V2 core | Scan/Project/Cast/FillNull/Transform/Derive/Filter, relational operators, generic UDF; batch schema and prompt examples | Forward chain + existing DAG revision + cached observe E2E for V2; prompt/schema consistency; independent failure recovery |
| C4: ordinary structured profiles | Worker telemetry, execution transport types, snapshot storage | Full versus partial coverage; multi-yield/partition merge; stats-disabled parity; bounded overhead |
| C5: flow facts and evidence selection | Pure native evidence extractor/selector, versioning, context renderers | Exact hand-computable facts, budget/omission checks, invalidation, no observed-content leaks in either mode |
| C6: shape utilities and integrated qualification | Window/Split/Explode/Unpivot/Pivot only as needed; end-to-end fixtures; diagnostics inspection | Per-operator transport/empty/dtype/error cases, entire workflow revision tests; real LLM smoke |
| C7: small evaluation | Named benchmark arms and dated report, no full campaign by default | One task/attempt per arm first; actual model-input audit and cache-aware cost; expand only after reviewing pilot |

C1 addresses a concrete discovery failure: preview formerly ignored
`skipLines`, so asking to inspect a later section returned the first section
again. Fix that verified contract bug before making statistics explain an
incorrect observation. It is a foundation checkpoint, **not** implementation
of the V2 catalog or evidence optimization.

### Test matrix

1. **Unit/schema/compiler**: reject extra fields/invalid ports/unsupported dtype,
   valid and malformed callbacks, literal preservation, null policies, output
   type mismatch, empty input, duplicate/non-contiguous indexes, callback
   mutation attempts, missing columns, missing packages, and source-line mapping.
   Test generated Python by actually executing it, not only matching strings.
2. **Operator semantics**: numeric/date conversion errors; all-null aggregates;
   null grouping and join keys; composite/duplicate keys; cardinality violations;
   suffix collisions; stable ties; partition boundaries; reshape duplicates and
   empty dynamic schemas. Test against small hand-computed expected tables.
3. **Scheduler/integration**: reversed chains, diamonds, independent branches,
   self-join ports, cycles through an existing graph, upstream revisions with
   unchanged descendants, same-shape/new-values outputs, partial edit failure,
   dependent blocking, and recovery using the same IDs.
4. **Observation/context**: omitted/empty/subset observe, cached read without
   execution, current LATEST versus frozen DELTA, runtime errors despite hidden
   results, pinned historical diagnostics, and every supported existing context
   mode/layout setting. Explicitly test real service snapshots and renderers.
5. **Profiles/flow**: empty/all-null/mixed/wide/large tables, categorical overflow,
   exact versus approximate coverage, many-to-many joins, filtered denominators,
   source identity, multi-yield/partition merges, stale out-of-order messages,
   unavailable profile, budgets, deterministic selection, and UDF unknownness.
6. **Real execution E2E**: real Texera compilation/workers, generated code,
   schema/result transport, mutation and observation paths, error repair, and
   cleanup of each test's own workflows/registrations. No-LLM debug smoke uses
   production context assembly but is not mislabeled a real-model run.
7. **Real LLM E2E**: model receives V2 prompt/tools, batches a dependent chain,
   explicitly observes its answer and repairs one injected recoverable failure.
   Capture `inputMessages` to prove actual visibility, not just stored snapshots.
   The four-turn chain/cached-observe/failure/repair protocol and input-timed
   audit are now implemented in the harness. They are locally tested with
   fixtures/mocks, **not yet run live**; see the
   [model-smoke checkpoint](checkpoints/native-python-dataflow-c6-model-smoke.md).
   Matching live qualification and caller-owned setup/cleanup remain required.
8. **Regression**: `bun test`, `bun run typecheck`; changed Python modules via
   pytest, changed Scala modules via their sbt project tests. Record preexisting
   failures separately by reproducing on the parent; do not call a failing suite
   green. Regenerate Python protos if a fresh backend or proto change needs them.

### Running the isolated candidate service

Use the supported launcher with a distinct port and state directory:

```bash
TEXERA_AGENT_SERVICE_PORT=3011 \
TEXERA_LOCAL_DEV_DIR=/tmp/texera-native-python-dataflow \
bin/local-dev.sh up agent-service --skip-build
```

Use the same variables for `status`, `logs agent-service`, and service-specific
shutdown. Backend endpoints remain the shared stack; no provider secrets go in
this document, committed fixtures, or logs. Configure private `.env` files as
described in [local development](local-dev-with-agent.md). The worktree may
reuse the provisioned venv/dependencies locally; do not commit their symlinks.

The harness now provides a source-pinned wrapper around this same agent-only
launcher, with fresh private state, live verification and verified empty-service
shutdown. See the [runtime checkpoint](checkpoints/native-python-dataflow-c7-runtime.md)
for its real lifecycle smoke and limits. It does not update the shared backend
or replace the required workflow/CU ownership and cleanup checks.

## 9. Evaluation: first prove correctness, then measure benefit

The user-requested extension adds a matched `gpt-5.6-terra` replication at
**medium reasoning** for every Luna arm, with separate result namespaces and
model-specific pricing. Prioritize the no-evidence/data-only/flow-only/combined
comparison for both models; keep collection/framework controls separate.
See the [Terra/live-runtime checkpoint](checkpoints/native-python-dataflow-c7-terra.md).

Freeze model, context mode/budget, maximum steps, task data, retry policy and
backend configuration. Seven arms for each of two models are registered in the
[isolated harness pilot](../benchmark/Kramabench/docs/native-python-pilot.md),
with names `DataflowSystem{Luna|Terra}PythonPilot<Arm>20260915Rep1`. Registration and
the one-attempt capture/official-scoring path are locally tested. Durable
execution journals, scoped phase reports and source-pinned agent-only lifecycle
checks are also implemented. Allocation journaling, verified owned-resource
cleanup and producing-result collector aggregation are now implemented; a real
setup-only lifecycle smoke passes. Frozen input/source checks, strict guard
returns, post-drain measurement finalization and owned single-arm orchestration
are now integrated and locally tested; see the [session checkpoint](checkpoints/native-python-dataflow-c7-session.md).
Production backend/worker qualification, prior-live-gate admission, the matching
worker/model runs and all 14 official attempts are complete. The
[final report](../benchmark/Kramabench/judgment_runs/native_python_dataflow_20260915/REPORT.md)
records measured source SHAs, exact medium-reasoning routes, actual-input
evidence witnesses, cache-aware cost and failures without replacement attempts.
A service port alone does not establish source/build provenance.
See the [attempt checkpoint](checkpoints/native-python-dataflow-c7-attempts.md)
for corrected final-step accounting/partial usage, and the
[runtime checkpoint](checkpoints/native-python-dataflow-c7-runtime.md) for the
execution journal and source-pinned launcher. The latest
[resource checkpoint](checkpoints/native-python-dataflow-c7-resources.md) records
collector measurement semantics, live setup/cleanup, current tests and gates.

| Arm | Framework | Evidence |
| --- | --- | --- |
| Controlled live native reference (`V1Reference`) | Pre-batching V1 native/all/no-stats | Off |
| Batch parent reference (`BatchParent`) | Pushed batching + explicit observe | Off |
| Python framework control (`V2Control`) | V2 batching + explicit observe | Off, collection off |
| Collector-only (`CollectorOnly`) | Same V2 | Off, collection on |
| Data-only (`DataOnly`) | Same V2 | Ordinary selected profiles only |
| Flow-only (`FlowOnly`) | Same V2 | Selected input/output/semantic facts only |
| Combined | Same V2 | Joint budgeted selection |

Keep measurement and exposure knobs separate: a collector-only control can
measure engine overhead without sending facts to the model. If a flow fact
requires profiling to compute, flow-only may collect that metadata but must not
render the data-profile block. Publish the exact effective settings for each arm.

Start with **one attempt of one task per relevant arm**, e.g. the previously
used `environment-easy-3` after verifying its exact harness ID. Treat it as a
plumbing/mechanism pilot, not a success-rate claim or a reason to tune to its
gold answer. Then preselect a small diagnostic and held-out set covering source
discovery, filtering/inclusion, casting, joins/provenance and aggregate
denominators. No automatic all-104-task campaign in this checkpoint sequence.

Use the existing KramaBench helpers (`load_cost_stats`, `react_metrics`,
`step_token_rows`, score helpers and compare commands). Primary cost is
`stats.json.cost_usd`, including cache discounts. Report input/cached/output
tokens, steps, batch sizes, observe requests, execution/inspection calls,
operator churn, errors/repairs, collection overhead and elapsed time separately.
The native trace helper now counts batch/operator/observe/partial-error events.
Actual execution counts and phase measurements use the out-of-band recorder
and the engine's explicit `phaseMetrics`, not tool receipts or heuristic state
names; see the [C7 measurement checkpoint](checkpoints/native-python-dataflow-c7-measurement.md).
The pilot runner persists and binds this evidence to each attempt.
More batching can still cost more if the schema, generated arguments, reasoning
or repeated repair grows; reduced round trips alone is not a win.

For paper-style comparisons, freeze an answer-type-aware pass threshold
(`>=0.9` if using the existing answer-aware convention) and distinguish it
from the CLI's strict comparison threshold. Verify the local helper's exact
behavior before reporting results. A later full campaign uses the same two
failed-task recovery rounds for every arm; preserve all attempts and report
total attempt cost as well as the final selected result. The single-attempt
pilot has no recovery-round accuracy claim.

Audit the first meaningful divergence in actual `react_steps.json`
`inputMessages`, then workflow, answer/evaluation and cost. Demonstrate that a
selected fact was visible **before** the improved decision. A changed key or
filter selected before evidence appeared is not attributable to evidence.
No promised score/cost improvement: expansion is justified by repeatable
mechanisms, acceptable execution overhead and held-out behavior, not one flip.

Store runs under the harness's `system_scratch/<SUT>/<task>/` and a dated
`judgment_runs/native_python_dataflow_<date>/` manifest/report, referencing
both repository and harness SHAs. Keep task traces/secrets/build output out
of source commits; commit only sanitized compact checkpoint evidence.

## 10. Checkpoint ledger

| Checkpoint | Status | Evidence / next action |
| --- | --- | --- |
| Parent | Verified | `feat/native-batch-observe` local and remote at `41cd8ae97` |
| C0 | Committed and pushed | `4f8c7f88e`; plan committed alone before implementation |
| C1 | Implemented and verified | `821f01435`; preview offsets, prompt guidance, and real-backend regression smoke; see [C1 checkpoint](checkpoints/native-python-dataflow-c1.md) for exact scope, commands, outcomes and limitations |
| C2 | Foundation implemented and verified | `1ffc49cf8`; opt-in Python callback catalog, runtime contracts and source-mapped diagnostics; 977 Bun tests, 34 Python tests, typecheck, DELTA/LATEST worker smoke pass; see [C2 checkpoint](checkpoints/native-python-dataflow-c2.md) for delivered scope and remaining diagnostic/telemetry work |
| C3 | Core implemented and verified | `67f69e151` plus `efb45ea94` engine schema fix; fourteen V2 operators, expanded prompt/examples, dependent batch/revision/error/empty-input worker tests in DELTA/LATEST; see [C3 checkpoint](checkpoints/native-python-dataflow-c3.md) for exact gates, follow-up validation and deployment requirements |
| C4 | Implemented; matching-worker profile matrix passes | `76243c008` + `97de1e243` collection/transport/version binding, with the expanded four-case profile fixture passing at final candidate `1c1204414`. See [C4 version checkpoint](checkpoints/native-python-dataflow-c4-versions.md), [transport checkpoint](checkpoints/native-python-dataflow-c4-progress.md), and [final live evidence](checkpoints/native-python-dataflow-c7-terra.md). Pilot collector component timings are measured, not whole-attempt overhead |
| C5 | Implemented; matching-worker evidence matrix passes | `7fe9e30cd` ordinary/flow facts, joint budget, DELTA/LATEST versioning and transport capability; eight live evidence cases pass at final candidate. [C5 design](checkpoints/native-python-dataflow-c5-selection.md). The pilot confirms actual data/flow delivery but no accuracy improvement; relevance and omission limits are in the final report |
| C6 | Implemented and live-qualified; efficiency limitation retained | `2674cd458` [shape operators](checkpoints/native-python-dataflow-c6-shapes.md), `a8ba50f35` [diagnostics](checkpoints/native-python-dataflow-c6-diagnostics.md), final agent `1c1204414`: six worker suites/20 cases and Terra-medium four-turn real-model smoke pass in DELTA/LATEST. **1,129 Bun tests**, typecheck, **184 harness tests** pass. LATEST still made five redundant cached reads; the pre-dispatch audit amendment and preserved failures are documented in [final live checkpoint](checkpoints/native-python-dataflow-c7-terra.md) |
| C7 | Completed one-task pilot; no broad optimization claim | Harness `1929be6`, candidate `1c1204414`: all **14 official attempts** scored and comparison-eligible, owned resources cleaned, **67/67 compilation and runtime requests pass**, plus nine preflight validation failures in Luna V2Control. Total scored-attempt token cost **$0.239003**. BatchParent correct/cheaper on both models; data-only/flow-only/combined do not improve accuracy. [Final report and reproducible audit](../benchmark/Kramabench/judgment_runs/native_python_dataflow_20260915/REPORT.md). Earlier [measurement](checkpoints/native-python-dataflow-c7-measurement.md), [runtime](checkpoints/native-python-dataflow-c7-runtime.md), [resource](checkpoints/native-python-dataflow-c7-resources.md), [attempt](checkpoints/native-python-dataflow-c7-attempts.md), and [session](checkpoints/native-python-dataflow-c7-session.md) checkpoints retain their historical test/protocol details |

Update this ledger at each checkpoint with commit reference, exact test commands,
results, environment/artifact paths, known limits and the next bounded task.
