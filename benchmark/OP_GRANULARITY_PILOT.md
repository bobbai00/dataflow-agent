# Native operator mode — implementation and pilot report

Branch `feat/op-granularity`. Companion to `OP_GRANULARITY_MOTIVATION.md`
(the legal-hard-15 motivating example). This document records what was built,
how it behaves on real runs, and what the first pilot measured.

---

Design and contract, kept current with the code:
`agent-service/docs/typed-operators-design.md` (table in, table out; lineage;
result selection; renders) and `agent-service/docs/operator-tools-spec.md`
(one tool per operator, upsert / delete, Scan formats, compilation, errors).

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
  all_varchar, union_by_name, filename)` for utf-8 delimited text. Everything
  else is pandas from the same parameters: files whose bytes are not utf-8
  (detected on the first 4 MB; 19 legal / wildfire CSVs are cp1252, which
  DuckDB rejects), `delim: "whitespace"`, `comment: "#"`, `format: "fwf"` with
  `widths`, `format: "lines"` (one row per line, parsed downstream with
  `compute`), xlsx (`sheet`), html (`sheet` = table index), json (a dict of
  scalars becomes a key/value table; records are normalized), parquet.
  `preview: n` returns the first n raw lines of a text file, the first n rows
  of every xlsx sheet or html table, and for a binary format one row with a
  loader hint (gpkg / shp / npz / cdf are `udf` loaders). Verified on every
  unusual KramaBench file: TLE, OMNI `.dat` / `.lst`, SP3, commented Swarm
  density text, xlsx with title rows, html, json dict, cp1252 csv, gpkg.

The typed view (`type`, `properties`, ordered `inputs`) rides on the operator
predicate as `nativeOp`. The execution payload never forwards it; the renderer
prints `(Filter)` and `Properties:` from it and never shows generated code.

Files: `agent-service/src/agent/native/{catalog,codegen,selection}.ts`,
`agent-service/src/agent/tools/native-typed-tools.ts`,
`agent-service/src/agent/prompts/native-mode.md`.

### 1.3 Tools and prompt

One tool per operator type — `scan filter project compute aggregate join union
distinct sort limit udf` — plus `deleteOperator`. A tool's arguments are the
operator's parameters at top level, the output table's `id`, and its input
table(s) (`input`; `left`/`right` for join; `inputs` for union and udf). There
is no summary argument: the type and the parameters are the summary.

- **Upsert by id.** A new id adds the operator; an existing id replaces its
  parameters and inputs in place and keeps every outgoing link (a Scan cannot
  become a processing operator or vice versa). Downstream operators are
  re-materialized after the edit.
- **A chain is several calls in one turn.** The scheduler orders same-turn
  calls by their input references, so a call may name an id created by an
  earlier call in the same turn; the workflow executes once after the turn.
- **`deleteOperator(id)`** refuses while consumers exist and names them.
- Tool schemas, the Ajv validator and the prompt's catalog are generated from
  the same `NATIVE_OPERATORS` table, so they cannot disagree. (The earlier
  `addOperators` batch tool is kept in the tree but no longer wired.)

Before this change the model spent 34–38% of an operator's output tokens on
its parameters and the rest on the envelope (JSON framing 27%, the summary
20%, id / inputs / type); the per-operator tool drops the summary and most of
the framing.

The system prompt is generated from the same catalog (one signature line per
tool), plus SQL notes, build rules (one relational operation per operator;
UDF only for what the catalog cannot do; preview a file before its Scan; fix
in place with the same id), the result-table format, and the key principles
carried over from code mode minus the pandas-specific ones.

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
| after `modifyOperator`, intermediate operators below the edit showed no `Result` | post-step execution materialized only the edited operator and the downstream sinks | native mode re-materializes every descendant |

### 4.4 The cache fix, applied (`message_layout="opSplit"`)

None of the arms above carried the LATEST cache fix (one user message per
`### Operator` block, so gpt-5.6 credits unchanged operators as whole-message
matches). Three byte-identical variants with it, same 10 tasks, 1 rep:

| arm | pass | steps / task | input tokens | cached | uncached / step | output | cost |
|---|---|---|---|---|---|---|---|
| code mode, single block | 6/10 | 6.4 | 523k | 67% | 2,571 | 16.8k | $0.062 |
| code mode, opSplit | 7/10 | 7.6 | 657k | 88% | 1,130 | 20.0k | $0.051 |
| native all, opSplit | 6/10 | 6.4 | 412k | 54% | 2,941 | 18.3k | $0.064 |
| native rule, opSplit | 7/10 | 6.1 | 438k | 57% | — | 17.3k | $0.063 |

With the fix, native mode costs what code mode cost without it, and code mode
gets cheaper still. Why native benefits less — per step, compare each rendered
operator block with the previous step's (prefix semantics: a block is a hit only
if it is unchanged and nothing before it moved):

| blocks across steps | code mode opSplit | native all opSplit | native rule opSplit |
|---|---|---|---|
| hit: unchanged, same position | 67% | 34% | 42% |
| new, appended at the end | 21% | 37% | 35% |
| new, inserted before the end | 6% | 8% | 6% |
| unchanged but shifted by an insertion or deletion | 3% | 13% | 11% |
| content changed | 2% | 8% | 6% |

Two reasons. Native steps append more genuinely new content (a chain of 3–4
operators per call), which no cache can serve. And the snapshot is ordered
topologically: a new Scan or a deleted preview lands or vanishes before
existing operators and shifts every block after it — 11–13% of native blocks
were unchanged yet uncacheable for that reason, against 3% in code mode, whose
DAGs are half the size and lose fewer probes. Rendering native operators in
creation order (which the model already keeps close to topological) would
recover most of that; the rule's full-to-count flips account for the rest of
the "content changed" share.

### 4.5 DELTA mode check

Native mode was first exercised only under LATEST. The DELTA renderer was then
taught about typed operators (an `addOperators` action lists its operators one
per line as `id (Type) <- inputs: {properties} — summary`; observations carry
`- operator id (Type) added|updated`; a refused batch keeps its error as
`- addOperators (k of n not added): [ERROR] …`; the selection rule applies to
observations with LATEST semantics) and run on four tasks
(`DataflowSystemLunaNative{Rule,All}DeltaRep1`, data_level 2, column stats,
2k chars, single-block framing):

| check (4 runs, 14 events each arm) | rule | all |
|---|---|---|
| typed action lines / raw JSON operators | 32 / 0 | 34 / 0 |
| typed observation verbs / untyped | 36 / 0 | 34 / 0 |
| count-shape results (rule only) | 4 | 0 |
| refused-batch outcome lines | 0 | 1 |
| `Column Schema and stats` / `Output Table profile` blocks | 16 / 3 | 17 / 2 |
| generated-code leaks outside error blocks | 0 | 0 |
| pass | 3/4 | 2/4 |
| cost | $0.019 | $0.018 |

Stats and profiles render wherever the table exceeds the sample (small
results print the whole table and skip them, as in code mode). The descendant
re-materialization fix showed up live: after `modifyOperator` on a Filter, the
Compute below it rendered a fresh result in the same observation. DELTA's own
cache fix (`cache_aligned_context`) was not enabled here (cache 52–53%).

### 4.6 What to run next

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

---

## 5. One tool per operator (2026-09-11)

The batch tool (`addOperators({operators: [...]})`) was replaced by one tool
per operator type with upsert-by-id semantics; contract in
`agent-service/docs/operator-tools-spec.md`. Same 10 tasks, 1 rep, luna,
opSplit framing everywhere:

| arm | pass | steps / task | ops / task | input tokens | cached | output tokens | out tok / op | cost |
|---|---|---|---|---|---|---|---|---|
| code mode | 7/10 | 7.6 | 5.9 | 657k | 88% | 20.0k | 339 | $0.051 |
| native all, addOperators | 6/10 | 6.4 | 9.9 | 412k | 54% | 18.3k | 185 | $0.064 |
| native rule, addOperators | 6/10 | 6.1 | 11.9 | 438k | 57% | 17.3k | 145 | $0.063 |
| native all, per-op tools | 4/10 | 8.6 | 8.7 | 707k | 89% | 16.7k | 192 | $0.048 |
| native rule, per-op tools | 5/10 | 8.5 | 10.1 | 824k | 90% | 15.8k | 157 | $0.051 |

- **Cache 54–57% → 89–90%, cost $0.063 → $0.048–0.051**: code-mode parity.
  Every step's prefix is now the system prompt plus unchanged operator blocks;
  the batch tool's long JSON arguments were the part that never cached.
- **Output tokens only −9% to −13%.** Luna's output count includes reasoning
  (legal-easy-4: 241 of 527 output tokens), so the envelope removed per
  operator (summary, JSON framing) is a minority of what is billed.
- **More steps, more input, all cached.** With one tool per operator the model
  emits 1.2 operators per turn against 2.0 in a batch; steps rose 6.1 → 8.5 and
  input tokens 438k → 824k, at 90% cached. The prompt asks for whole stages
  per turn; the habit is one call per turn.
- **Pass 5/10 and 4/10 against 6/10** is within one rep's noise and has no
  tool-mechanism cause: no refused calls in 28 runs, no loops; the modify
  path (same id) was used 1–5 times per task where needed. The flips:
  `environment-hard-19` (True/False) went the other way in both per-op arms;
  `environment-hard-7` came out as 0.11 for 10.87 (percent vs proportion) in
  the all arm. The remaining failures are the same convention misses as every
  arm since the first pilot (legal-15 Micropolitan, hard-16, hard-12,
  wildfire-17 partial).
- **DELTA** with per-op tools (`DataflowSystemLunaNativeToolsRuleDeltaRep1`,
  legal-easy-4 + legal-hard-15): 1/2 (legal-15 convention), $0.011, 67%
  cached; the tool result carries the receipt and the typed observation
  (`- filter operator `cross_state_rows` added`, then the result in the rule's
  shape). The action is the model's own tool call.

## 6. Unusual file types

The 104 tasks name sources that are not plain csv in 30 of them: xlsx (13),
txt (6), tle / dat / sp3 (2 each), html (2), gpkg (2), json, cdf, lst, npz (1
each). Eight were added to the test set, one per layout:

| task | source | what Scan needed |
|---|---|---|
| archeology-easy-4 | xlsx, title rows, header on row 5, units row | sheet preview, `skipLines: 5` |
| biomedical-easy-2 | xlsx, 179 columns | sheet preview, `sheet` |
| legal-hard-2 | html (6 tables) + 52 csv | table preview, `sheet: 1` |
| environment-hard-8 / -9 | txt list of names + 8 csv | `header: false, columns` |
| astronomy-easy-5 | TLE (2-line records), skyfield | `format: lines` → udf |
| wildfire-easy-2 | two gpkg | udf loader (geopandas), WKT geometry |
| astronomy-hard-9 | whitespace `.dat` (55 cols) + TLE + spec text | `delim: whitespace` or `lines` |

Scan was extended for them (spec §3): encoding detection (19 legal / wildfire
csv files are cp1252, which DuckDB rejects), `delim: whitespace`, `comment`,
`format: lines | fwf`, html table index, json objects, parquet, line-form
previews of sheets and html tables, a loader hint for binary formats, and a
missing path that lists the directory. All verified locally on every unusual
file in the lake before the runs.

Results, 1 rep (native arms with per-op tools; code mode = the opSplit arm of §4.4):

| task | native rule | native all | code mode | notes |
|---|---|---|---|---|
| archeology-easy-4 | pass, 7 steps, $0.005 | pass, 7 steps, $0.004 | pass, 9 steps, $0.006 | native: 15 steps / $0.011 before the line-form preview |
| biomedical-easy-2 | 68.1 (68.5) | 68.1 | pass | `Case_excluded` convention; native looped 5 modifies before the `columns` guard, 2 after |
| legal-hard-2 | pass, 12 steps, $0.009 | pass, 11 steps, $0.008 | pass, 9 steps, $0.007 | html table 1 joined to 52 csv files |
| environment-hard-8 | pass, 8 steps, $0.013 | pass, 13 steps, $0.024 | pass, 7 steps, $0.007 | native: 9 previews in one turn, 8 scans in the next |
| environment-hard-9 | pass, 8 steps, $0.013 | pass, 11 steps, $0.008 | pass, 6 steps, $0.007 | |
| astronomy-easy-5 | pass, 11 steps, $0.008 | pass, 11 steps, $0.008 | pass, 10 steps, $0.009 | `format: lines` + skyfield udf |
| wildfire-easy-2 | pass, 9 steps, $0.005 | pass, 8 steps, $0.005 | pass, 7 steps, $0.004 | geopandas udf loader, `.to_wkt()`, sjoin inside the udf |
| astronomy-hard-9 | 13 (24), 21 steps, $0.033 | 21, 12 steps, $0.040 | no answer at the 26-step cap, $0.046 | see below |
| **total** | **6/8, $0.090** | **6/8, $0.100** | **7/8, $0.089** | |

Scan itself is no longer the reason for any miss. `biomedical-easy-2` is an
answer convention (exclude the 2 `Case_excluded` patients; code mode happened
to apply it). `astronomy-hard-9` first failed on the task text's `omni2.txt`
(the lake has `omni2.text`): the model never saw the format spec and guessed
the AP column. With the directory listing in the missing-file error the rerun
found `omni2.text` on its second call, read it as `format: lines`, filtered
the field table out of it, and still answered 13 for 24 after 21 steps — the
lag-correlation modelling is the hard part, and code mode did not finish it
either. `wildfire-hard-21` (json) is unusable in this checkout: its `ZHVI.csv`
is a 0-byte Kaggle placeholder.

Two more traps the traces exposed and closed: the model passed the preview's
` | ` cell separator back as `delim` (the tool description now says it is
display-only), and asked for `format: "whitespace"` (now an alias of
`delim: "whitespace"`).

Scripts for §5–§6: `arm_table.py`, `scores.py`, `answers.py`,
`verify_tools.py`, `gen_odd.ts` / `run_odd.py` (local execution of compiled
Scan chains over the unusual files) in the session scratchpad.

## 7. Trace audit and fixes (2026-09-11)

Audit of the 36 LATEST runs (18 tasks × rule / all) and 2 DELTA runs above
(`trace_audit.py`, `cache_steps.py`, `cache_probe.ts`). Ranked by cost:

| anomaly | evidence | cause | fix |
|---|---|---|---|
| leftover previews rendered in full every step | 54 of 63 previews never deleted (rule), 45 of 52 (all); preview blocks = 20% / 18% of the final context | a preview has no consumer, so the rule makes it a frontier table | probe retirement: a preview nobody reads whose files a real Scan covers renders one line, `Result: (preview superseded by scan \`x\`)`; an errored one keeps its first error line; every mode |
| cache reset at steps 2 and 3 of every run | 34 / 41 resets, all at steps 2–3 | first message differed three times: task only → task + single block merged → task + `# Current Dataflow` header | header always present from step 1; a single operator is split too |
| DELTA never cached the transcript | cached = 5149 (system prompt) at every step with 11 of 12 messages identical | probe against LiteLLM: the trailing `Continue.` user message after the tool results limits the hit to system + tools (4335 of 7656 tokens); without it the previous prompt is a full hit (7647 of 7783). Same for a user-text rendering | no `Continue.` after tool results (kept after a thought-only assistant turn); DELTA step-1 message ends at `# Agent Events` |
| one Python operator chain per file | environment-hard-8: 29 operators (rule), 68 (all), 31k-token context | the task lists 8 like files; the prompt mentioned globs only | prompt: like files are one scan with the list of paths |
| `TypeError: Unmatched type … got 0 days 06:22:09` | Compute of `epoch - prev_epoch` | the engine has no interval type | DuckDB stages return timedelta columns in seconds; SQL note |
| errored probe repeated 9 steps | astronomy-hard-9 (all): failed `omni2.txt` preview kept its full error block in 9 contexts | model moved on without deleting it | covered by probe retirement (errored, no consumer → one line) |
| `format: "whitespace"` refused | 3 refusals, the only kind | natural spelling | alias of `delim: "whitespace"` (§6) |

Not anomalous: 0 text-only turns, 0 loops beyond 4 calls on one id, 10–12
modifies per arm all purposeful, 3 engine errors in 18 rule runs. Half the
steps carry a single tool call (1.9 calls per non-final step); the prompt asks
for whole stages and this did not move, so wall-clock on the 320k-row water
data stays at 130–215 s per step (the chain re-executes every step).

Verification, targeted reruns after the fixes (1 rep each):

| run | before | after |
|---|---|---|
| legal-easy-4, LATEST rule | 7 steps, 5 ops, 43.4k in, 82% cached, $0.0029; cache reset at steps 2 and 3 | 7 steps, 5 ops, 42.4k in, 83%, $0.0029; first message identical at every step, no reset; preview shows `(preview superseded by scan \`csn_data\`)` |
| astronomy-easy-5, LATEST rule | 11 steps, 10 ops, 3 udf (one a hand-written lag), 94.4k in, 91%, $0.0082 | 9 steps, 8 ops, 1 udf; the lag is `lag(epoch) OVER (ORDER BY epoch)` in a compute and the gap `date_diff('second', …)`, so the timedelta path (unit-tested) was not needed; 67.6k in, 87%, $0.0058 |
| environment-hard-8, LATEST rule | 8 steps, 29 ops (one chain per file), 143.6k in, 78%, $0.0128 | 7 steps, 7 ops (one scan of the 8 files), 54.6k in, 87%, $0.0044 |
| legal-easy-4, DELTA rule | 8 steps, 57.3k in, 63% cached, cached tokens flat at 5149 every step, $0.0057 | 7 steps, 46.4k in, 84%, cached 5440 → 5920 → 6568 → 6804 → 7060 (90–98% per step), $0.0028 |

All four answers exact. The DELTA number is the one that changes the earlier
picture: DELTA now caches like LATEST.

## 8. Multi-turn (2026-09-11)

LongDS task `sports/nfl_big_data_bowl_2023/task1`, first 3 of 42 turns, one
agent and one workflow for the whole session, luna, arms
`luna-native-rule-delta` / `luna-native-rule-latest` (`benchmark/longds/arms.py`).

What carries over between turns without any change: the operators, their
typed parameters, their materialized tables and statistics, the upsert-by-id
tools (an earlier turn's operator can be modified by id), the delete guard,
and the re-materialization of edited chains. In every session turn 2 read
three or four turn-1 tables by id (`season_player_workspace`,
`pressure_event_ledger`, the published lists) and turn 3 read turn 2's
combined view; the DAG grew 23 → 49 → 61 operators (DELTA) and 42 → 62 → 80
(LATEST).

Three things did not work and were fixed:

| problem | evidence | fix |
|---|---|---|
| DELTA: the new request was on top, the transcript ended with the previous turn's final answer and a `Continue.` user turn | turn 3 answered "Please provide the next question or analysis step." (1 step, 0 tool calls); the request sat 70k tokens earlier | on a later turn the request is also rendered inline at its chronological position, so it is the last message when the turn starts and stays in place as events append |
| DELTA: an earlier turn's request was glued into the previous tool result | `## User Event 2` inside a `tool` message | rendered as a `user` message |
| LATEST: topological block order inserted new sources before existing blocks | every step of turn 3 cached 13% with 55 of 63 messages identical | creation order (append-only) |

The last one exposed how the provider's cache works: a step is credited only
for an earlier prompt that is a prefix of the whole new prompt; identical
messages after the first divergence earn nothing. Measured on the same
session after the fix: cached 47% → 78%, cost $0.135 → $0.091, 3/3 turns
answered both times. The remaining breaks are all shape flips of the rule
itself (16 in 32 steps: a frontier block rendered full turns into a count or
header line once consumed) and two error-then-fixed blocks. That is the open
design question: a shape that flips costs the whole suffix for one step;
keeping it full costs a cached block per step.

DELTA after the fixes: 3/3 turns answered, every turn start ends with the
user's request (no `Continue.`), step 2 of each turn extends step 1 (97%
cached), session cached 76% → 88%, $0.090. Cross-turn reuse in both layouts:
turn 2 read four turn-1 tables by id, turn 3 read three turn-2 tables; no
earlier operator was modified.

| arm, 3 turns | turns answered | cached | cost |
|---|---|---|---|
| DELTA native, before | 3/3 (turn 3 was a no-op in the first session) | 76–79% | $0.083–0.093 |
| DELTA native, after | 3/3 | 88% | $0.090 |
| LATEST native, before | 3/3 | 47% | $0.135 |
| LATEST native, after | 3/3 | 78% | $0.091 |

### 8.1 Four layouts, one task, after the fixes (2026-09-12)

Same task, first 3 turns, gpt-5.6-luna, each session run alone with a resource
sentinel. Engine rebuilt with the three leak fixes cherry-picked from the
campaign branch (`9effd3cd4` threads, `079ee3204` operator-cache teardown,
`1e0163860` Flight sockets): Java listening sockets stayed at 10 through all
four sessions (they had grown 57 → 295 over the previous four), threads flat
at ~620, free memory flat at 53 GB.

Two agent-service changes made the catalog and session layouts usable with
typed operators: every place that identifies the operator a tool call wrote
now accepts the typed tools' `id` (before, the catalog showed no operators
from turn 1, `recallState` found nothing, and the native catalog run hit the
25-step cap on two turns with empty answers), and both layouts are split into
one message per finished turn and per live step, with the `# Your Task`
directive moved before the step log (`messageLayout: "turnSplit"`, now their
default).

| arm | turns correct (gpt-5.2 judge) | steps per turn | input tokens | cached | steps extending the previous prompt | cost |
|---|---|---|---|---|---|---|
| code, full history (session) | 2/3 | 5 / 4 / 6 | 295k | 66% (was 34%) | 8 of 12 | $0.037 |
| code, catalog (v33) | 1/3 | 7 / 10 / 10 | 497k | 84% (was 44%) | 14 of 24 | $0.047 (was $0.100) |
| native, DELTA | 1/3 | 8 / 14 / 9 | 1,815k | 89% | 25 of 28 | $0.090 |
| native, LATEST | 0/3 | 9 / 14 / 9 | 1,248k | 79% | 11 of 29 | $0.091 |
| native, full history (session) | 1/3 | 11 / 16 / 8 | 2,011k | 82% (was 11%) | 24 of 32 | $0.127 (was $0.326) |
| native, catalog | 1/3 | 7 / 22 / 14 | 1,308k | 86% (was 36%) | 33 of 40 | $0.084 (was $0.153, two empty turns) |

Reading, with one repetition per cell: caching is now where the layouts'
structure says it should be, and the remaining misses are the shape flips of
the rule (LATEST) and the turn boundaries. Cost is a different story: on this
multi-turn task the typed operators cost 2–3× the code-mode arms, because each
turn takes two to three times the steps (typed chains of 8–22 operators per
turn against one or two pandas blocks) and every step re-sends the session.
Accuracy does not separate the arms at n = 1; the code-mode session arm's 2/3
is one judge verdict away from the rest.

### 8.2 Catalog and session layouts with typed operators, second pass (2026-09-13)

Three findings from the §8.1 traces, each fixed and re-run:

- The catalog's "Dataflow delta" recognised only the code-mode write tools, so
  a finished turn listed no typed operators and `recallState` guessed ids
  (`No finished turn has a version of \`season_players\``). Typed tools are
  writes in every verb loop now; entries read
  `#### scan operator \`season_blockers_raw\` (added)` / `Properties: {…}` /
  `Result: 86 rows x 12 cols, ~13k chars — Schema: …`.
- Two prompt-cache breaks per turn came from the layout itself: the `### Steps`
  header appeared at step 2 inside the directive's message, and the DELTA
  `Inputs:` line moved to an operator's most recent edit, rewriting an earlier
  observation. `### Steps` is its own message; typed operators carry the
  `Inputs:` line on every edit (code-mode renders unchanged, golden tests).
- Every native run built the wide-to-long pressure ledger as four `compute` /
  `project` operators plus a `union`. `unpivot` (columns → rows, pandas melt)
  is now an operator; no udf was needed anywhere in the four native runs and
  window functions covered ranks and percentiles (102 `compute` calls with
  `OVER`).

| arm, 3 turns | correct (gpt-5.2 judge) | steps per turn | cached | steps extending the previous prompt | cost |
|---|---|---|---|---|---|
| native, catalog | 2/3 (was 1/3, before that two empty turns) | 10 / 11 / 10 (was 7 / 22 / 14) | 86% | 27 of 28 | $0.071 |
| native, full history (session) | 1/3 | 10 / 12 / 21 | 90% | 33 of 40 | $0.126 |

The only remaining non-extending step in the catalog run is the first step of
each turn, where the finished-turn entry replaces the in-progress rendering.

Engine result cache, checked directly: the cherry-picked regression probe
(`agent-service/benchmark/e2e/cache-probe.ts`, 9 patterns) passes — unchanged
operators complete from cache, the cache survives the 30 s idle teardown and a
sub-plan re-execution. In the native sessions the per-step wall time stayed at
10–13 s while the DAG grew from 14 to 102 operators, and the Java listening
sockets stayed at 10 through six sessions after the leak fixes.
