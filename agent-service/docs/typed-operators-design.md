# Typed operators: table in, table out

Design of `agentMode: "native"` on `feat/op-granularity`. The tool-level
contract is in [operator-tools-spec.md](operator-tools-spec.md); the
motivating example is `benchmark/OP_GRANULARITY_MOTIVATION.md`; measured
numbers are in `benchmark/OP_GRANULARITY_PILOT.md`.

## 1. The idea

An operator is a function from tables to one table. The agent builds a DAG of
operators; the engine runs it and keeps every intermediate table together with
its statistics. Taking that literally fixes two things that used to be the
model's choice:

1. **Grain.** An operator is one relational operation with a small parameter
   set: Scan, Filter, Project, Compute, Aggregate, Join, Union, Unpivot, Distinct,
   Sort, Limit, and UDF for what those cannot do. The agent submits parameters, never
   code. The algebra decides where one operator ends and the next begins.
2. **What to show.** A new table has a known parent table and a known operator.
   The operator type says what the operator *can* change; the engine's
   statistics say what it *did*. The agent's parameters are its own words and
   are not news. What the data decided is.

One sentence carries both: **the agent wrote the parameters, the data wrote
the results.**

## 2. Tables and lineage

Every table `T` the engine holds comes with: schema, row count, per-column
facts (null, distinct, min / max / mean, top values, format hints such as
`thousands`), a sample, and a whole-table profile (duplicate rows, all-null
columns, empty rows). These are measured on the full table after every run by
the Python worker, so showing or hiding them costs the engine nothing.

The lineage of `T` is (operator type, parameters, parent tables). For a typed
operator the type fixes a priori what can move:

| type | rows | columns | what only the data can tell |
|---|---|---|---|
| Scan | creates | new | everything: shape, types, header / footer lines read as rows |
| Filter | drops | same | how many rows survived |
| Project | same | keep / drop / rename | nothing (the columns are in the parameters) |
| Compute | same | adds / replaces | parse failures (nulls), collapsed values (distinct) |
| Aggregate | collapses | new | the numbers |
| Join | drops or multiplies | both sides | match count, fan-out |
| Union | adds | union by name | row count, column mismatch |
| Unpivot | multiplies by the number of melted columns | keys + name + value | nothing beyond the count (the columns are in the parameters) |
| Distinct | drops | same | how many duplicates there were |
| Sort | same | same | nothing |
| Limit | drops | same | nothing beyond `n` |
| UDF | unknown | unknown | everything |

This table is `rowEffect` in `src/agent/native/catalog.ts`. It is the reason
result selection can be a rule instead of a guess.

## 3. Deciding what to show

Three shapes, decided per snapshot from (type, links, statistics), never by the
model (`src/agent/native/selection.ts`):

| shape | rendered | when |
|---|---|---|
| full | schema, stats, sample, profile | outputs of Scan, Aggregate, Join, UDF; the **input** of any Aggregate / Join / UDF; every **frontier** table (no consumer yet); anything errored or not typed |
| count | `Result: Output Table: 94 rows, 3 cols (from 452 rows)` | Filter, Distinct, Union, Limit whose output feeds a row-preserving operator or another row-dropper |
| header | header, `Inputs:`, `Properties:`, no `Result:` | Project, Sort; Compute whose new or replaced columns kept their null and distinct counts. A moved count renders as a count line: `"reports": null 208 → 0` |
| retired probe | header, `Properties:`, one line `Result: (preview superseded by scan \`csn_data\`)` | a `preview` Scan nobody reads once a real Scan covers its file(s); an errored preview nobody reads keeps its first error line. Applies in every mode, `all` included: it is about probes, not about what the data decided |

Why exactly these:

- The input of a grain-sensitive consumer is shown in full because that
  table's grain (distinct of the key against its row count) is what the
  consumer's result depends on, and it is the last place the grain is visible.
- The frontier is the table the agent acts on next; it needs the schema.
- A row-dropper's only news is its count. A column-only operator's only news
  is a parse failure or a collapse, both measurable as null / distinct
  movement of the same column between input and output.

Between two shipped tables the operators fuse into one stage from the agent's
point of view: it sees the stage's input, the stage's output, and one count
per row-set change inside.

Worked example, legal-hard-15 ("total identity-theft reports from cross-state
metropolitan areas"), six operators, numbers from the runs:

```
scan      identity_theft   660 rows   full    52 files; title and footer lines read as rows: null=104 areas, null=208 counts
filter    non_blank        452 rows   count   Output Table: 452 rows, 3 cols (from 660 rows)
compute   reports_num      452 rows   header  "3,968" → 3968, 0 parse failures: nothing moved, nothing to show
filter    cross_state       94 rows   count   Output Table: 94 rows, 3 cols (from 452 rows)
distinct  cross_unique      43 rows   full    input of the aggregate: distinct=43 of 94 rows is the fact behind the 2.4× error
aggregate total              1 row    full    243377
```

Three of six tables are shown in full; the naive render shows six. Without the
`distinct` the agent answers 593,524 (165 of 336 runs in the corpus did); the
94-row table with `distinct=43` is where that is visible, and it is shown
because an Aggregate consumes it.

`resultSelection: "all"` renders every table (retired probes excepted) and is
the baseline for measuring the rule.

Why probes need their own rule: in the first 36 per-operator-tool runs the
model deleted 1 of 115 previews, and a preview with no consumer is by
definition a frontier table, so the rule alone rendered every one of them in
full at every step — 20% of the LATEST context.

## 4. Two contexts, the same tables

**LATEST** is a snapshot of the DAG: one block per operator in topological
order, each block its own user message so a provider prefix cache credits
unchanged operators (`messageLayout: "opSplit"`, the default). A block:

```
### filter operator `web_fraud`
Inputs: contributors (139 rows, 4 cols)
Properties: {"predicate":"\"Data Contributor\" LIKE 'FTC - Web Reports (Fraud%'"}
Result: Output Table: 6 rows, 4 cols (from 139 rows)
```

Sources have no `Inputs:` line; a full shape replaces the count line with the
table, its `Column Schema and stats:` and `Output Table profile:`; a header
shape stops after `Properties:`. UDF blocks show the code instead of
properties.

The provider's prompt cache (gpt-5.6 through LiteLLM, measured) credits a step
only for an earlier prompt that is a prefix of the whole new prompt. A shared
prefix that stops inside an earlier prompt earns nothing beyond the system
prompt, however long it is (3-turn session: 55 of 63 messages identical, 13%
cached). Every layout decision below follows from that one rule:

- the first message is byte-identical from step 1 (LATEST always ends it with
  the `# Current Dataflow / ## Operators` header and splits even a single
  operator; DELTA ends it at `# Agent Events`);
- LATEST renders typed operators in creation order, not topological order, so
  a new source is appended instead of inserted before existing blocks;
- the DELTA transcript ends on the tool results, never on a constant
  `Continue.` user turn (with it: 4335 of 7656 tokens cached; without: 7647 of
  7783); on a later turn the new request is rendered inline at its
  chronological position, so it is the last message when the turn starts and
  stays in place as the turn's events append after it.

What still breaks the prefix, by design: a block whose shape changes once a
consumer arrives (full → count), a modified operator, a retired preview. Each
costs the suffix after it for one step.

**DELTA** is a transcript. The action is the tool call itself, in text form
`- add filter operator `web_fraud`; inputs: contributors; properties: {...}`
(`modify` when the id existed, `- delete operator `x``). The observation is
the receipt, then `- filter operator `web_fraud` added|updated` with the result
in the selected shape. The rule applies at observation time: a new table is
the frontier, so it is full; when a later turn consumes it, the earlier
observation is history and is not re-rendered.

The "operators needing attention" section (errors first) uses the same header
and the same error text as the block.

## 5. Decisions and their reasons

- **One tool per operator type, not one batch tool.** Each tool's schema is
  the operator's parameters plus `id` and its input reference(s); the provider
  validates the shape, the service validates the values. No summary argument,
  no JSON envelope. Calling a tool with an existing id is the modify. In the
  pilot this moved the prompt-cache hit rate from 57% to 90% and the cost to
  code-mode parity (`OP_GRANULARITY_PILOT.md`).
- **Parameters compile to Python, the engine is unchanged.** Filter, Compute,
  Aggregate carry SQL fragments and compile to one DuckDB statement over the
  input frame (the model knows SQL; there is no SQL-to-pandas translator to
  maintain). Project, Join, Union, Distinct, Sort, Limit have no expressions
  and compile to the pandas call. Scan reads utf-8 delimited text with DuckDB
  and everything else with pandas. The result lands as an ordinary
  `DataLoading` / `DataProcessing` operator, so statistics, storage and the
  GUI need nothing new.
- **Selection is a rule, not a model choice.** A pull tool (`inspectResult`)
  exists as an experimental arm. The rule is deterministic, free, and does not
  depend on the model knowing what it has not seen.
- **No fusion or splitting.** Grain is set by the algebra and the engine runs
  one Python operator per typed operator. The price is engine time: about
  120 s per hop over 320k rows in this engine (22-file scan 74 s; scan plus
  one filter 195 s; 0.7 s locally). Fusing consecutive row-preserving
  operators into one physical operator is an engine concern for later and
  changes nothing above.
- **Errors in the agent's terms.** The engine's message points into generated
  Python the agent never saw; it is rewritten as `filter `x` failed: Binder
  Error: …`, `not executed — upstream `x` failed: …`, and a missing path lists
  what the directory actually contains.

## 6. Where it lives

| piece | file |
|---|---|
| catalog: types, `rowEffect`, JSON schemas, signatures | `src/agent/native/catalog.ts` |
| parameters → Python | `src/agent/native/codegen.ts` |
| result selection rule | `src/agent/native/selection.ts` |
| the tools (upsert, delete, receipts) | `src/agent/tools/native-typed-tools.ts` |
| same-turn ordering by input references | `src/agent/tools/tool-call-scheduler.ts` |
| error rewrite | `src/agent/tools/result-formatting.ts` (`formatNativeError`) |
| LATEST / DELTA renders, attention section | `src/agent/util/context-utils.ts` |
| system prompt | `src/agent/prompts/native-mode.md`, `src/agent/prompts.ts` |
| tests | `src/agent/native/native.test.ts` |
