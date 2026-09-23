<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Native mode: the dataflow as a program of operator expressions

Since 2026-09-22 the agent has two modes:

- **native** (default): the model writes the dataflow as a program of
  `name = operator(...)` statements over one operator catalog. Three custom
  operators carry Python: `filter` (row → bool), `map` (row → one value per
  declared column) and `process` (tables → table). The service compiles every
  operator to Python for the engine.
- **code**: the previous script-based approach. Every operator is one free
  Python `def load()` / `def process(...)` function written through
  `createOrModifyOperator`.

The former `general` mode (Texera's built-in typed operators), the V1 native
catalog (SQL predicates and `Compute`) and the V2 JSON batch tool are gone.
`nativeToolMode`, `nativeCatalogVersion` and `allowedOperatorTypes` are
rejected at agent creation and on PATCH, so old experiment configurations
cannot silently become new arms.

## The program

```python
def rating_value(row):
    text = row["rating"]
    if text is None:
        return {"product": row["product"], "numeric_rating": None}
    parts = [p.strip() for p in text.split("or")]
    return {"product": row["product"], "numeric_rating": sum(float(p) for p in parts) / len(parts)}

domestic = filter(reviews, lambda row: row["country"] == "Greece", doc="Keeps reviews whose country is Greece")
rated = map(domestic, rating_value, doc="Keeps product and the numeric rating parsed from the rating text")
average_rating = aggregate(rated, by=["product"], average=mean("numeric_rating"))
```

1. One assignment per operator. The left name is the output table; assigning
   to an existing name revises that operator and keeps its consumers.
2. Positional arguments are the input tables; keyword arguments are the
   parameters. The DAG's edges are derived from the operands, never declared
   separately.
3. Statements may refer to tables defined later in the program or in earlier
   calls; the shared `ToolCallScheduler` orders them. A statement whose input
   was rejected is blocked; independent statements still land.
4. Functions are lambdas or top-level `def`s referenced by name. A `def` that
   calls another `def` ships with it. Types are bare names (`str`, `int64`,
   `float64`, `bool`, `datetime`); reducers and window functions are calls.
5. A column whose name is not an identifier is addressed by string:
   `row["Acres Burned"]`, `**{"Acres Burned": float64}`.

A statement that does not parse fails alone (`PROGRAM_SYNTAX` at its line,
its dependents blocked, the other statements landed). An argument error
fails only its statement.

## The tool

`dataflow({ edits, delete, observe })` is the only tool. A call runs four
steps in a fixed order, and the prompt tells the model so:

1. `delete`: ids of operators to remove. Refused while another operator that
   survives the call still reads the deleted one (a consumer deleted or
   re-pointed in the same call counts as handled).
2. `edits`: the statements above (create or modify operators) plus the `def`s
   they use. Empty when the call only deletes or re-reads cached results.
3. Execution: new and modified operators run with everything downstream of
   them; untouched operators keep their results.
4. `observe`: the ids whose table contents the model wants to see. Everything
   else shows only a receipt (`executed, N rows; result not requested`).
   Errors are always shown.

There is no separate delete or inspection tool: a rejected edit's diagnostic
travels in the receipt, and a repeated identical resubmission is paused until
corrected arguments land.

## Operators

`native/catalog.ts` is the single source: each operator's surface name,
runtime type, input arity, row effect, prompt signature and the normalizer
from a parsed call to the runtime `properties`. The prompt's operator
reference is generated from it, so prompt, parser and engine cannot drift.

| Surface | Runtime type | Rows out |
| --- | --- | --- |
| `scan(files, format="auto", skip_lines=0, header=True, names=None, all_text=False, delim=None, comment=None, widths=None, sheet=None, encoding=None, file_column=None, preview=None)` | Scan | created |
| `project(T, keep=None, drop=None, rename=None)` | Project | same |
| `cast(T, column=dtype, ..., errors="raise")`, `datetime(format=, tz=)` | Cast | same |
| `filter(T, fn, doc="...")` | Filter | drop |
| `map(T, fn, doc="...")` (returns the new row as a dict) | Map | same |
| `aggregate(T, by=[], name=reducer("col"), ...)` | Aggregate | one per group |
| `join(L, R, on, how="inner", nulls_equal=False, suffix="_right", validate="many_to_many")` | Join | multiply |
| `union(T1, T2, ..., schema="strict")` | Union | add |
| `distinct(T, columns=None, keep="first")` | Distinct | drop |
| `sort(T, by, nulls="last")` | Sort | same |
| `limit(T, n, offset=0)` | Limit | drop |
| `window(T, partition_by=[], order_by=[...], name=fn, ...)` | Window | same |
| `unpivot(T, columns, name="variable", value="value")` | Unpivot | add |
| `pivot(T, index, columns, values)` | Pivot | collapse |
| `process(T1, ..., Tn, fn=function, doc="...")` | Process | unknown |

`map` replaces the earlier Transform and Derive; `process` replaces UDF;
`fill_null`, `split` and `explode` were retired on 2026-09-23 because traces
never needed them (a `map` expresses each). Every custom operator (`filter`,
`map`, `process`) takes a required one-sentence `doc` stating the logical
semantics of its function; it is stored on the operator and leads its flow
guarantee in observed results, since nothing else about custom code can be
measured. The
runtime (`native/python/runtime.py`) no longer takes declared input columns
for filter and map: every function sees the whole row, and the columns it
actually read are recorded (`operations.predicateColumns`,
`operations.columnDependencies`). Flow evidence and the lineage ranking read
those measurements instead of declarations.

## From text to engine

```text
program text ──python/program_parser.py (ast, no execution)──▶ statements + defs
             ──catalog normalize + Ajv──▶ NativeOpView {type, properties, inputs, source, functions}
             ──graph checks, ToolCallScheduler──▶ applyNativeOperator (native-upsert.ts)
             ──validateNativeOperator (Python syntax + entry signature, one subprocess)
             ──compileNativeOp──▶ DataLoading / DataProcessing operator calling execute_native
```

A rejected statement carries an `attempted` view whose identity is the parsed
arguments, so reordering keywords or reformatting is not counted as a
correction by the repeat-failure throttle (`NativeValidationRepair`).

## What the model sees

- **DELTA / `native` layout** (default): the tool-call transcript. The
  assistant part carries the program as written; the tool result carries the
  receipt and the observation. Observations are frozen when captured, so the
  transcript stays an append-only prefix for the provider cache.
- **LATEST / `opSplit`, `opBlock`**: one message per operator. Each block
  shows `Definition:` — the `def`s it uses followed by the statement as
  written — instead of the former `Inputs:` / `Properties:` JSON. A process
  body appears only in `opBlock` (or with code-in-snapshot); the statement
  alone otherwise.

## Errors

Every failure reaches the model as one receipt line per operator with a fixed
envelope: `[CODE; stage; revision R] message`, then `Hint:` (one repair hint
per code, always present), `Field:` (the model-facing argument, e.g. `how`,
`orderBy`, `columns[0].func`), the failing line of a submitted function
(`scaled line 2: return row["Amount"] * 2.0`), and `Diagnostic: diag_…` for
the receipt. Messages name the cause: the column, the value, the option.

The layers, in the order a statement passes through them:

| Layer | Stage | Catches | Codes |
|---|---|---|---|
| Program parse | validate | the statement that does not parse fails at its line; dependents blocked; the rest lands | `PROGRAM_SYNTAX` |
| Argument normalizer (TypeScript) | validate | unknown keyword, enum, type, table count, undefined function, non-window function; carries the signature | `INVALID_ARGUMENTS` |
| Runtime validate (Python, no data) | validate / compile | argument rules, Python syntax, entry signature, duplicate outputs | `*_ARGUMENT`, `*_OPTIONS`, `DTYPE`, `INPUT_PORTS`, `OPERATOR_ID`, `COLUMN_COLLISION`, `PYTHON_SYNTAX`, `CALLBACK_SIGNATURE` |
| Runtime execute (Python, with data) | execute / contract | missing columns, value and type failures, custom-code failures, output contract | `MISSING_COLUMN`, `SCAN_*`, `CAST_INVALID_VALUE`, `FILL_TYPE`, `FILTER_NULL`, `CALLBACK_*`, `PYTHON_IMPORT`, `AGGREGATE_TYPE/RANGE`, `JOIN_TYPE/CARDINALITY`, `UNION_SCHEMA/TYPE`, `SPLIT_TYPE`, `EXPLODE_JSON/TYPE`, `UNPIVOT_TYPE`, `PIVOT_NULL_KEY/DUPLICATE`, `PROCESS_RETURN_TYPE`, `OUTPUT_SCHEMA`, `OUTPUT_VALUE_TYPE`, `ROW_CONTRACT` |
| Producer boundary | contract | an input table fails the transport contract before the consumer runs; the producer is blamed | `INPUT_VALUE_TYPE`, `INPUT_SCHEMA`, `INPUT_TABLE_TYPE` |
| Graph | dependency | assigned twice, unknown input table, cycle, consumer of a rejected statement | `UPSTREAM_FAILED` |
| Infrastructure | infrastructure | timeout, worker loss, backend refusal; never mistaken for user-code failures | `EXECUTION_TIMEOUT`, `WORKER_UNAVAILABLE`, `BACKEND_UNAVAILABLE`, `EXECUTION_ERROR` |

Column errors are cross-cutting on purpose: an invalid partition key is
`MISSING_COLUMN` with `Field: partitionBy`; the field, not the code, says
which argument. Mixed-type object columns cannot enter any operator, so
"sort a mixed column" is reported against the operator that produced it.

The engine aborts a run at its first failure and hands every unfinished
operator the same payload. The renderer distinguishes a consumer of the
failed operator (`not executed; upstream \`x\` failed (CODE). Repair that
operator`) from a bystander that merely shares the run (`not executed; the
run stopped when \`x\` failed (CODE). \`y\` does not read from \`x\`, so its
own definition is not implicated; it runs once that operator is repaired or
deleted`). A failing operator left in the DAG therefore blocks unrelated
results on every later call until it is repaired or deleted.

Source of truth: `agent-service/benchmark/tests/test_native_error_taxonomy.py`
holds one row per failure case (operator, mistake, code, stage, field, message
fragments) and fails if a runtime code has no row or a hint is missing;
`native-program.test.ts` holds the argument-layer table; the e2e driver below
asserts the rendered receipts against a live stack.

## Settings

Defaults: `agentMode: native`, `nativeProfileCollection: true` (collection
cannot change on an existing workflow), `dataEvidence: false`,
`flowEvidence: false`, `contextMode: delta`. Native mode forces provider
parallel tool calls off; the program is the batch.

## Verification

From `agent-service/`:

```bash
bun test                    # 1,050 tests, 84 files
bun run typecheck
../.venv/bin/python -m pytest -q benchmark/tests   # runtime + error taxonomy, 247 tests
TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3061 bun run benchmark/e2e/native-program-run.ts
TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3061 bun run benchmark/e2e/native-errors-run.ts
```

The smoke needs a running backend and agent service; it makes no LLM call and
covers a forward-referenced chain with a process loader, hidden receipts, a
cached read, an upstream revision refreshing a descendant, a preview window
with `skip_lines`, a syntax error that changes nothing, a partial failure, an
execution error superseding a success, and a delete through `dataflow`. The errors
driver triggers every layer of the taxonomy through the real tool and engine
and asserts that each receipt carries the code, stage, argument, cause and
hint, and that consumers and bystanders of a failed operator are attributed
correctly.

Benchmark arms: `DataflowSystemTerraNativeExprDataOnly20260922` and the
seeded variant in `benchmark/Kramabench/systems/native_expression_system.py`.
Historical arms that pass retired settings fail at agent creation by design.
