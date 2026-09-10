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

## 4. Pilot (2026-09-10, gpt-5.6-luna, 10 representative tasks, 1 rep)

Tasks: legal-easy-4, environment-easy-1, archeology-easy-10, astronomy-easy-1,
wildfire-hard-17, environment-hard-7, environment-hard-19, legal-hard-15,
environment-hard-16, archeology-hard-12 (the set used by the grain-split
pilots). Oracle file subset, 25 steps, 4 tasks in parallel. Four arms:

| arm | what |
|---|---|
| `Latest2kStatsCodeRep1` | code mode (pandas UDF operators), LATEST, 2k chars, stats — the DevFlow baseline |
| `NativeAllRep1` | typed operators, every result block rendered |
| `NativeRuleRep1` | typed operators, results shipped by the rule (full / count / header) |
| `CodeAgentSystemLunaChars2kGuidedRep0` | script agent (smolagents), 2k stdout cap |

### 4.1 Outcomes

| task | gold | code mode | native all | native rule | script agent |
|---|---|---|---|---|---|
| legal-easy-4 | 2111635 | Y | Y | Y | Y |
| environment-easy-1 | 4.796 | Y | Y | Y | Y |
| archeology-easy-10 | Singapore | Y | Y | Y | Y |
| astronomy-easy-1 | 15 | Y | Y | Y | Y |
| wildfire-hard-17 | 4830.9 | Y (5134.4) | Y (5134.4) | Y (5134.4) | Y (5134.4) |
| environment-hard-7 | 10.87 | n (0.11) | n (0.11) | Y | n (0.11) |
| environment-hard-19 | False | Y | Y | Y | n |
| legal-hard-15 | 243377 | n (194555) | n (184039) | n (194555) | n (242682) |
| environment-hard-16 | 60 | n (74) | n (74) | n (75) | n (74) |
| archeology-hard-12 | 409 | n (447) | n (447) | n (447) | n (447) |
| **pass** | | **6/10** | **6/10** | **7/10** | **5/10** |

wildfire-hard-17 passes on the approximate-numeric tolerance in every arm.
The three tasks every arm misses are the same convention coins seen in earlier
campaigns: Metropolitan-only scope on legal-hard-15, the beach-identity `@`
trap on environment-hard-16, conflict attribution on archeology-hard-12.
environment-hard-7 is the units coin (0.11 vs 10.87); one native run per arm
got it right. At n = 10 × 1 rep the noise floor is ±3 passes: the three
dataflow arms are indistinguishable on accuracy, the script agent one lower.

### 4.2 Cost and shape

| arm | steps / task | input tokens | cached | output tokens | cost | agent time (sum) | final DAG ops / task | UDF share |
|---|---|---|---|---|---|---|---|---|
| code mode | 6.4 | 523k | 67% | 16.8k | $0.062 | 15.1 min | 5.1 | 100% (code) |
| native all | 7.3 | 490k | 47% | 22.4k | $0.084 | 24.9 min | 10.9 | 0% |
| native rule | 7.3 | 542k | 47% | 24.5k | $0.092 | 35.5 min | 9.7 | 1% |
| script agent | 20.8 | 1,167k | 93% | 39.6k | $0.085 | 8.9 min | — | — |

Rendered `# Current Dataflow` section per step (chars): code mode mean 7,578 /
median 4,239; native all 10,440 / 7,269; native rule 12,464 / 6,071. Prompt
tokens per step: code 8,051; native all 6,564; native rule 7,350.

Reading the table:

- **Grain is fixed.** Native DAGs are twice as fine (9.7–10.9 operators per
  task vs 5.1), and 97–100% of the operators are typed: the UDF tail was one
  parser (archeology's tab-separated conflict file), a regex extraction, a
  correlation. The model writes the SQL the design assumed:
  `lower(trim("Violation")) = 'yes'`, `TRY_CAST(replace(reports, ',', '') AS INTEGER)`,
  `CASE WHEN … THEN 1 ELSE 0 END` under a `sum`, self-joins for year-vs-year-1.
- **Cost.** In the first native runs (before the timeout fix) native and code
  mode cost the same ($0.061–0.064 vs $0.062) with 14–28% fewer input tokens.
  The reruns cost 35–48% more, almost entirely two trajectories: native-rule
  environment-hard-19 spent 18 steps and $0.031 because five `Join` attempts
  named the same table twice (self-join) and were refused — the run started
  before the self-join fix landed — and wildfire-hard-17 took 12–15 steps in
  both native arms. Native prompts are shorter per step but cache worse (47%
  vs 67%): the system prompt is smaller and the snapshot changes more between
  steps, so a smaller share of each request is a stable prefix.
- **Result selection.** With the rule, 21% of rendered operator entries in
  the first run became a count line or a header (36 + 17 of 252); the median
  dataflow section is 16–32% smaller than with every block rendered. Total
  token effect is inside the noise at this scale: the native DAGs here are
  short chains of 4–10 operators where most operators are frontier or feed an
  aggregate, so the rule has little to fold. No failure in the rule arm traces
  to a hidden table; the rule arm was the only one to solve
  environment-hard-19 and environment-hard-7 in the same run.
- **Time.** Native agent time is 1.6–2.3× the code baseline. That is the
  engine, not the model: each typed operator over the 320k-row water data is a
  Python hop costing ~120 s (§3), and a native chain has 2–4 of them where a
  UDF had one.
- **Script agent.** 5/10 at $0.085 with 21 steps per task: luna ends its turns
  with `**Final Answer: …**` instead of calling smolagents' `final_answer`
  tool, so 7 of 10 runs ran to the step cap repeating the last computation.
  Its cost and step counts measure that harness mismatch as much as the agent.

### 4.3 Bugs found and fixed during the pilot

| symptom | cause | fix |
|---|---|---|
| every luna call failed with `Incorrect API key provided: ''` after the stack restart | the recreated LiteLLM container read provider keys from the shell that ran `docker compose up`; the worktree had no root `.env` | copy `.env` to the worktree, recreate `litellm` |
| `Execution failed … did not signal an event for 240 seconds` on environment tasks | 4-minute sync-execution idle timeout vs ~120 s per 320k-row hop under 4-way parallelism (§3) | native arms run with `execution_timeout_minutes=10` |
| `inputs must be distinct operators` refused every lag computation | Join rejected the same table on both sides | self-join compiles to a one-parameter `process()` used twice |
| ratio of two aggregates written as a UDF | no way to put two one-row tables side by side | `Join` without `on` = cross join; prompt guidance |
| Compute called with the wrong property shape (twice) | model guessed `expressions`/list shapes | validation error already names the expected shape; the model recovered next step |
| script-agent arm returned `No response from agent` for every task | LiteLLM `400 No connected db.`: the harness shell had no `LITELLM_MASTER_KEY` | export `CODE_AGENT_API_KEY=$LITELLM_MASTER_KEY` for that arm |
| kb.py watchdog killed a live 15-minute native run | the harness log is silent for the whole agent run | `--watchdog-min 30` for single long tasks |

### 4.4 What to run next

- 3 reps of the four arms on the same 10 tasks (noise floor), then the full 104.
- `NativeRuleInspectRep1` (rule + `inspectResult`): pull logs tell whether the
  model opens what the rule hid.
- Engine side: fuse consecutive row-preserving typed operators into one
  physical Python operator while keeping them separate logically — the ~120 s
  per hop is the cost that finer grain actually pays today.

Scripts used for the numbers above live in the session scratchpad
(`pilot_report2.py`, `outcome_matrix.py`, `render_size.py`, `dag_sizes.py`,
`native_trace.py`, `native_ops.py`); raw runs are under
`benchmark/Kramabench/system_scratch/<arm>/` with the pre-fix native runs kept
as `<arm>__run1`.
