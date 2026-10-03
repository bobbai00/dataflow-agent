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

# Operator definitions: catalog, commands and receipts

Status: proposal preview. This file shows the operator definitions the model
reads in the system prompt, writes in an edit, and reads again in an observation.
The catalog below is a snapshot of `graphCatalogText()` from the current
`NATIVE_OPERATORS`; the formatting proposal keeps those contracts.

| surface | definition shown | connections and Python |
|---|---|---|
| system prompt | generic signature, defaults and brief contract for each kind | named input/output ports; no instance IDs or implementation code |
| edit call | complete expression after `create operator <id>:` or `update operator <id>:` | explicit edge commands; named functions indented under their operator |
| inspect receipt | the stored expression for that operator, shown whole | actual input IDs; attached functions when include_implementation is true |
| task catalog or earlier-input provenance | the same stored expression, capped by definitionChars | actual input IDs, result shape and columns |
| ordinary edit receipt | definition omitted because the call holds it | changed operator IDs and edge lines; rollback includes the restored definition |

Inputs are supplied through edges. The definition itself has no upstream
table arguments. A signature is the contract for a kind of operator; a
definition is the particular expression that created or updated one operator.

## Complete catalog shown in the system prompt

Each entry has the signature, a `Ports:` line and the brief contract. All
16 entries are shown below. The same block appears inside the
[complete proposed system prompt](system-prompt.md#complete-proposed-system-prompt).
Internal JSON Schema and normalization functions remain in the runtime catalog.

```text
scan(files, format="auto", skip_lines=0, header=True, names=None, all_text=False, delim=None, comment=None, widths=None, sheet=None, encoding=None, file_column=None, preview=None)
    Ports: no inputs -> out.
    Read a file or glob: CSV/TSV, text, Excel, HTML, JSON or Parquet. Use format="lines", "fwf" or "whitespace" for other text layouts. preview=n reads a sample of raw lines or sheet rows; use a full scan for computation. names requires header=False; all_text=True preserves codes such as 001. sheet selects an Excel sheet or HTML table; file_column records the source.

values(column=value_or_list)
    Ports: no inputs -> out.
    A literal one-column table named by its keyword: values(country=["Canada", "Mexico"]) is 2×1 and values(threshold=0.25) is 1×1. Cells are str, int, float, bool or None, one type per column. For values the request names and no table holds.

project(keep=None, drop=None, rename=None)
    Ports: in -> out.
    Keep or drop columns, then rename them with {old: new}. Row order and count stay unchanged.

cast(column=dtype, ..., errors="raise")
    Ports: in -> out.
    Types: str, int64, float64, bool, datetime(format=..., tz=...). Write dtype names without quotes, for example amount=float64. Failed conversions raise an error, or become missing with errors="null". Naive datetimes need a timezone.

filter(fn, doc="what the predicate keeps")
    Ports: in -> out.
    fn(row) returns True to keep a row, False or None to drop it. Preserves order and columns.

map(fn, doc="what the new row holds")
    Ports: in -> out.
    fn(row) returns the whole new row as a dict. Use {**row, "new": value} to retain existing columns. One output row per input, with consistent keys and scalar values.

aggregate(by=[], name=reducer("col"), ...)
    Ports: in -> out.
    One row per group; by=[] gives one row. Reducers: count(), count(col), count_distinct, sum, mean, min, max, median, stddev, first. count() counts rows; count(col) counts non-null values. Reductions skip nulls except first; an all-null sum is null. stddev is the sample standard deviation.

join(on=None, how="inner", nulls_equal=False, suffix="_right", validate="many_to_many")
    Ports: left, right -> out.
    on is a column, list of columns, or [(left_col, right_col)]. how: inner, left, right, full, cross, semi, anti. semi keeps the left rows with a match, anti those without, each once, left columns only. For a cross join, omit on or use None/[]; join(how="cross") attaches a single-row benchmark to every input row. Null keys do not match by default. validate: many_to_many, one_to_one, one_to_many, many_to_one; cross uses many_to_many. A colliding right column gets suffix, repeated until free (the receipt lists renames); output order is unspecified.

union(schema="strict")
    Ports: in[0], in[1], ... -> out; at least two inputs, consecutive indices (0..255).
    Stack tables in input order, retaining duplicates. strict requires matching schemas; align fills absent columns with null. Cast incompatible types first.

distinct(columns=None, keep="first")
    Ports: in -> out.
    Keep one whole row per key (all columns by default). keep="first" or "last"; missing keys compare equal. Preserves relative row order.

sort(by, nulls="last")
    Ports: in -> out.
    Stable sort: by=["amount"] ascending, or by=[("amount", "desc"), "name"]. nulls="first" or "last".

limit(n, offset=0)
    Ports: in -> out.
    Keep n rows from offset. Sort first when selecting a top-k.

window(partition_by=[], order_by=[...], name=fn, ...)
    Ports: in -> out.
    Output keywords name columns: prev=lag("value") creates prev. Also lead, row_number, rank, dense_rank. Order within partitions; ranks start at 1; keep input row order.

unpivot(columns, name="variable", value="value")
    Ports: in -> out.
    Wide to long: one output row per input row and selected column, including nulls. Remaining columns are keys; selected columns need compatible types.

pivot(index, columns, values)
    Ports: in -> out.
    Long to wide. Each (index, columns) pair must be unique; aggregate first if needed. Absent cells become null, null pivot keys fail. Retrieve the result to learn its new column names.

process(fn=function, doc="what it does")
    Ports: in[0], in[1], ... -> out; one input per fn parameter, in order; zero for a loader.
    One custom operation the catalog cannot express. fn takes one DataFrame per input, in order, and returns one DataFrame. Zero inputs are for loading unsupported formats. Keep filtering, deriving columns, joining and aggregation in predefined operators.
```

## A predefined operator

For a synthetic `orders` table, the model writes this in an edit's `changes`:

```dataflow
create operator totals: aggregate(by=["region"], total=sum("amount"))
create edge orders.out -> totals.in
```

The edit receipt confirms the two graph commands without repeating the
aggregate expression:

```text
### 1. edit: ok
2 changes applied.
- **totals** (aggregate, created)
  - inputs: orders
- created edge: orders.out -> totals.in
```

After execution, the call
`{"type": "inspect", "target": "operator", "operator_id": "totals", "include_implementation": false}`
shows its full definition:

```text
### 1. inspect totals: ok
- **totals** (aggregate, executed)
  - definition: `aggregate(by=["region"], total=sum("amount"))`
  - inputs: orders
  - result: 4 rows × 2 columns
  - columns: region str, total float64
```

A task's catalog entry uses the same definition, with the task's change word
in the header. A rollback includes it in the edit receipt because that call
names the task to restore and does not contain the restored expression.

## A join and its input ports

The two-input operator's definition and edges are separate:

```dataflow
create operator compared: join(on="region", how="inner", validate="many_to_one")
create edge totals.out -> compared.left
create edge budgets.out -> compared.right
```

Inspection names the ports so the model can distinguish the two inputs:

```text
### 1. inspect compared: ok
- **compared** (join, executed)
  - definition: `join(on="region", how="inner", validate="many_to_one")`
  - inputs: left `totals`, right `budgets`
  - result: 4 rows × 3 columns
  - columns: region str, total float64, budget float64
```

## A map with attached Python

For a synthetic `units` table with columns `k` and `value`, the edit contains
the complete function under the operator:

```dataflow
create operator score: map(fn=double_score, doc="Doubled k for each unit")
    def double_score(row):
        return {**row, "score": row["k"] * 2}
create edge units.out -> score.in
```

An inspection with `include_implementation: true` returns:

````text
### 1. inspect score: ok
- **score** (map, executed)
  - definition: `map(fn=double_score, doc="Doubled k for each unit")`
  - functions:
    ```python
    def double_score(row):
        return {**row, "score": row["k"] * 2}
    ```
  - inputs: units
  - result: 70 rows × 3 columns
  - columns: k int64, value str, score int64
````

With `include_implementation: false`, only the `functions` field is omitted.
An inline lambda remains inside `definition`, exactly as authored, for example
`map(lambda row: {**row, "score": row["k"] * 2}, doc="Doubled k for each unit")`.
An update replaces the complete definition and repeats all attached functions.

## A process with a DataFrame function

A process definition names its function; the attached Python defines the
operation. This example assumes `yearly_changes` already contains the
prepared columns `x_change` and `y_change`:

```dataflow
create operator correlation: process(fn=correlate, doc="Pearson correlation between yearly changes")
    def correlate(df):
        return pd.DataFrame({"correlation": [df["x_change"].corr(df["y_change"])]})
create edge yearly_changes.out -> correlation.in[0]
```

Inspection with implementation returns:

````text
### 1. inspect correlation: ok
- **correlation** (process, executed)
  - definition: `process(fn=correlate, doc="Pearson correlation between yearly changes")`
  - functions:
    ```python
    def correlate(df):
        return pd.DataFrame({"correlation": [df["x_change"].corr(df["y_change"])]})
    ```
  - inputs: yearly_changes
  - result: 1 row × 1 column
  - columns: correlation float64
````

The result is a table retrieved with the same record formats as any native
operator. See [retrieve.md](retrieve.md#sample) for complete sample receipts
and [inspect.md](inspect.md) for stale, failed and historical definitions.
