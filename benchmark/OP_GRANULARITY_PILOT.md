# Native operator mode — implementation and pilot report

Branch `feat/op-granularity`. Companion to `OP_GRANULARITY_MOTIVATION.md`
(the legal-hard-15 motivating example). This document records what was built,
how it behaves on real runs, and what the first pilot measured.

---

## 1. What was built

### 1.1 The operator set

`agentMode: "native"`. The agent assembles the dataflow from a fixed operator
set, each operator fully specified by a small JSON `properties` object. One
operator is one relational operation; the grain of the DAG is set by the
algebra, not by the model.

| operator | parameters | row-set effect |
|---|---|---|
| `Scan` | `files` (path or glob), `skipLines`, `header`, `columns`, `allText`, `delim`, `sheet`, `encoding`, `fileColumn`, `preview` | creates |
| `Filter` | `predicate` (SQL boolean) | drops |
| `Project` | `keep` / `drop` / `rename` | none |
| `Compute` | `columns: {name: SQL scalar expression}` | none |
| `Aggregate` | `groupBy`, `aggregations: [{fn, col, as}]` | collapses |
| `Join` | `on: [[left, right]]`, `type` | drops or multiplies |
| `Union` | — | adds |
| `Distinct` | `columns` | drops |
| `Sort` | `by: [{col, desc}]` | none |
| `Limit` | `n`, `offset` | drops |
| `UDF` | `code` (pandas `process(<input ids>)` / `load()`) | unknown |

The set is the one the trace study derived from 20,079 final-DAG operators of
3,364 luna runs: these twelve cover 91% of processor calls; the UDF tail is
statistics/fitting, regex extraction, custom parsers and geospatial work.

### 1.2 How an operator runs

Route A: the agent-service compiles parameters to Python and lands an ordinary
`DataLoading` / `DataProcessing` operator. Nothing in the engine changes; the
Python worker's per-column statistics (`_publish_column_stats`) and the
snapshot storage work as before.

- `Filter`, `Compute`, `Aggregate` carry SQL fragments, so each compiles to one
  DuckDB statement over the input DataFrame (`SELECT * FROM t WHERE (…)`,
  `SELECT * REPLACE (… AS col) FROM t`, `SELECT keys, SUM(x) AS y FROM t GROUP BY keys`).
  DuckDB was already a worker dependency; the agent writes SQL, which it knows,
  and no SQL-to-pandas translator exists.
- `Project`, `Join`, `Union`, `Distinct`, `Sort`, `Limit` have no expressions
  and compile to the pandas call.
- `Scan` compiles to DuckDB `read_csv([files], header, skip, names,
  all_varchar, union_by_name, filename)` with pandas fallbacks for xlsx / html /
  json, and a raw-line `preview` mode for inspecting a file before the real Scan.

The typed view (`type`, `properties`, ordered `inputs`) rides on the operator
predicate as `nativeOp`. The execution payload never forwards it; the renderer
prints `(Filter)` and `Properties:` from it and never shows generated code.

Files: `agent-service/src/agent/native/{catalog,codegen,selection}.ts`,
`agent-service/src/agent/tools/native-op-tools.ts`,
`agent-service/src/agent/prompts/native-mode.md`.

### 1.3 Tools and prompt

- `addOperators({operators: [{id, type, inputs, properties, summary}, …]})` —
  a chain per call, executed once after the turn.
- `modifyOperator({operatorId, properties, inputs, summary})` — properties
  replaced whole, code recompiled.
- `deleteOperator`, and optionally `inspectResult` (read-only re-render of an
  existing result).

The system prompt is generated from the same catalog the tool validates
against (one signature line per operator), plus SQL notes, build rules (one
relational operation per operator; UDF only for what the catalog cannot do;
preview a file before its Scan; fix in place), the result-table format, and
the key principles carried over from code mode minus the pandas-specific ones.

### 1.4 Result selection

`resultSelection: "rule"` ships only what the data decided. Decided once per
snapshot from operator type, DAG links and the engine's statistics:

| shape | rendered | for |
|---|---|---|
| full | schema + stats + sample | Scan, Aggregate, Join, UDF outputs; the input of any Aggregate / Join / UDF; every frontier operator (nothing consumes it yet) |
| count | `Result: Output Table: 452 rows, 2 cols (from 660 rows)` | Filter, Distinct, Union, Limit feeding a row-preserving operator or another filter |
| header | operator + Properties, no Result | Project, Sort; Compute whose new or replaced columns kept their null and distinct counts (moved facts render on a count line) |

`resultSelection: "all"` renders every block (the legacy render).

---

## 2. Verification

- `tsc --noEmit` clean; 870 tests pass (10 new for codegen and the rule).
- A 15-operator native chain executes on the legal-hard-15 files with the real
  engine semantics replicated locally: Scan 660 rows → Filter 452 → Compute →
  Filter 94 → Distinct 43 → Aggregate 243,377 (gold); grouped Aggregate, Sort,
  Limit, Project, left Join, Union and a UDF all produce the expected tables.
- End to end (agent + engine + harness), native rule mode solves legal-easy-4
  in 4 steps for $0.002 and environment-easy-1 in 5 steps for $0.003, with the
  Y/y trap handled as `lower(trim("Violation")) = 'yes'`.

---

## 3. Engine cost of finer grain (measured)

Direct execution, no LLM (`agent-service/benchmark/e2e/native-hang-e2e.ts`),
22-file water scan (319,911 rows) on the running stack, 4 pilot tasks in
parallel:

| workflow | wall time |
|---|---|
| Scan only (materialize 320k rows) | 74 s |
| Scan + DuckDB Filter (165,911 rows out) | 194 s |
| Scan + pandas Filter (same predicate) | 196 s |
| Scan + Filter, locally in plain Python | 0.7 s |

One Python-operator hop over a 320k-row table costs about 120 s in this engine
(tuple streaming, `DataFrame.from_records`, output tuples, Iceberg write,
statistics), and DuckDB adds nothing over pandas. A typed chain adds several
such hops where a code-mode UDF had one, so the harness's 4-minute idle
timeout (`execution_timeout_minutes`, forwarded as the sync-execution event
timeout) tripped on the environment tasks in the first native runs. The native
arms now run with 10 minutes; the finding itself is a real cost of finer
physical grain and the argument for fusing row-preserving typed operators into
one physical operator while keeping them separate logically.

---

## 4. Pilot

(filled in below from the runs)
