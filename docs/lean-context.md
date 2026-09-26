# Lean context: answer_from, registered operators, contract flags

Branch `feat/state-registry`, 2026-09-26. Four mechanisms on top of the
definition registry (`docs/definition-registry.md`), each aimed at one of the
cost or accuracy findings of the registry campaign, and one benchmark arm
(`react-lean`) that turns all four on.

| Finding (registry campaign, 2026-09-25) | Mechanism | Setting |
| --- | --- | --- |
| The answer call is ~43% of a two-call turn's cost; late turns are not cheaper | `answer_from`: the runtime composes the final answer from an observed table and ends the turn | `nativeAnswerFrom` |
| The model re-derives the same step (a cleaning rule, a ranking) as new process code, task after task | Registered operators: a `def` is called by name, persists with its consumers, is listed with its settings | `nativeRegisteredOperators` |
| 80–93% of failures cascade from data-contract traps at turns 1–4 (literal `"nan"` strings, header rows, multiplied joins) that nothing carries forward | Contract flags: judgments from the operator's contract and the whole-table profile, stored on the table, inherited through lineage; `expect` for the model's own contract | `nativeContractFlags` |
| Entries are 95–97% of the prompt; rows of every observed table and every function body ride in them | Lean context: `observe: ["t[a,b]"]`, probe one-liners, rows only for answer sources, one function body per session | `nativeLeanContext` |

## answer_from

`dataflow({..., answer_from: "summary"})` names a table whose complete
contents are the answer. After execution the post-step path composes
`**Final Answer: <single-line JSON>**` from the table:

- one row → an object of its columns;
- several rows with two columns whose first column is a unique text key → an
  object keyed by it;
- one column over several rows → `{column: [values]}`;
- otherwise `{<table>: [row objects]}`.

`DriverRunTurnInput.shouldStop` is a new driver hook: the Vercel driver passes
`[stepCountIs(maxSteps), () => shouldStop()]` as `stopWhen`, and the SDK
evaluates it after `onStepFinish`, so the composition inside the post-step
path ends the loop without another model call. `sendMessage` then records the
composed text as the final agent step (no usage) and returns it as the
response. A table that is empty, not completely held, over 50 rows, or over
4,000 characters is refused: the reason lands as a `note` on the table's
observation ("answer_from not applied: …; write the final answer yourself")
and the loop continues. The answer table is always observed, so its rows reach
the entry and `from` names it.

Verified: unit (`answer.test.ts`: mapping, refusals, tool receipt, loop stop and
continue through the real `TexeraAgent` with a scripted driver) and live
(`benchmark/multiturn/lean-smoke.ts`, task 3: the model set `answer_from` on
its first call; one model call, composed `{"mean_composite":72.83}`).

## Registered operators

A `def` whose docstring states what its output table holds, whose parameters
without a default are its input tables, and whose remaining parameters have
literal defaults, is called by name:

```python
def rank_by_score(scores, top=10, key="composite"):
    """One row per learner in the top ranks by the chosen score column, with rank."""
    ...
top5 = rank_by_score(scored, top=5)
```

Nothing is declared. `program_parser.py` records `tables`, `keywords` (literal
defaults; `null` for a non-literal one), `doc` and `variadic` per def, and the
called name's span (`operator: true`) so restores and forks rewrite the call
with its function. `normalizeStatement` compiles the call to a `Process` with
`properties.params` (the settings the call passed), the def's closure as
`code`, the def as `entry`, the docstring (or `doc=`) as `doc`; the runtime
validates that the passed keywords are parameters with a default and executes
`function(*frames, **params)`. The statement keeps the model's line as its
source, so entries, forks and restores treat it like any other statement; the
shared-function mechanism makes the def persist with its consumers and a
redefinition revise all of them (`compileAnalysisProgram` re-normalizes the
consumers through the same path). `DefinitionRegistry.recordOperator` keeps
one version per distinct body; the task-start index lists `Your operators`
with signature, doc, version and consumers.

Refusals name the cause: wrong table count, a keyword the def does not take
(with the accepted settings), a non-literal setting or default, no docstring,
variadic parameters. Verified in `registered-operators.test.ts` (parser,
compile, engine execution, tool round trip with revision and versions, fork,
restore, entries) and live (task 2 of the smoke calls the task-1 def by name
with other settings).

## Contract flags

`native/flags.ts`. A flag is the boundary condition of a stated contract, met
on this table, computed from the engine's whole-table profile and counters:

| Code | Contract | Text |
| --- | --- | --- |
| `LITERAL_MISSING` | text encoding: `"nan"`, `"NULL"`, `"N/A"`, `""`… are text | `column "q40" holds the text "nan" in 143 rows: text, not a missing value (null cells in "q40": 0)` |
| `HEADER_IN_DATA` | a value equal to the column's name is a header row | `column "year" contains its own name as a value in 3 rows: a header row repeated inside the data` |
| `NUMERIC_TEXT` | numbers stored as text do not compare or reduce | `column "score" holds numbers as text ("12", "7.5", …): comparisons and reducers need a cast` |
| `JOIN_MULTIPLIED` | a join without `validate=` multiplies rows when keys repeat | `join produced 1842 rows from 721 and 300: keys repeat on at least one side (a key occurs up to 4 times), so rows were multiplied` |
| `CAST_LOST` | `errors="null"` makes unparsable values missing | `cast made 12 values of "x" missing: they did not parse` |
| `AGG_NULLS_IGNORED` | reducers skip nulls | `mean/sum("x") ignored 57 null values of the input: its denominator is 664, not 721` |
| `FILTER_EMPTY`, `FILTER_ALL` | a filter that kept nothing or everything did not select | `filter kept all 721 rows: the predicate dropped nothing` |
| `MAP_ALL_NULL` | an added column that is null everywhere | `added column "unit_price" is null in every row` |
| `UNION_ALIGNED` | `schema="align"` fills absent columns with null | `input 2 has no column "x": filled with null in its 300 rows` |
| `EMPTY` | 0 rows | `0 rows: everything built on this table is empty` |
| `EXPECT_OK`, `EXPECT_FAILED` | the model's `expect` | `expectation failed: rows=0, expected 700-800` |

Flags live on `OperatorInfo.flags` with their `origin` table. `applyContractFlags`
walks the event's DAG in dependency order after execution and before the
observation is frozen, computing flags for tables that have none (results are
immutable once earned) and re-checking `expect` for the tables named. A
descendant inherits an encoding flag while the column is still text and, for
`LITERAL_MISSING`, while its own complete profile still shows the tokens; it
inherits `JOIN_MULTIPLIED`, `CAST_LOST`, `MAP_ALL_NULL` and `UNION_ALIGNED`
as facts about its rows. The upstream origin wins over a fresh own flag on the
same column, so the model reads where the fact came from (`(from survey)`).

Shown: in every observation of the table (with or without rows), in the
entry of the task that raised it (own flags only), and in the task-start index
(`⚠ survey: column "q40" …`, own flags of current tables). `expect={"cohort":
{"rows": [700, 800], "unique": ["id"], "nonnull": ["score"], "columns":
["region"]}}` is checked on the profile or, for a completely held table, on
its rows.

Verified in `flags.test.ts` (each code, inheritance and resolution, expectations,
the DAG pass, entries and index) and live (the smoke's loader raises the three
encoding flags; `top3` inherits the header and numeric-text flags from
`learners` but not the token flag, because its three rows hold no token; the
index of task 2 lists the flags).

## Lean context

- `observe: ["t[a,b]"]`: the tool records `observeColumns`, the agent passes
  them per table into `captureNativeObservations`, and `selectNativeObservation`
  projects the schema (`Complete table (all rows; 2 of 5 columns):`); unknown
  names are ignored, no match shows everything. Data evidence lines already
  honor the projection.
- Entries (`buildTaskEntry({lean: true})`): a table nothing reads and the
  answer did not come from keeps `statement; rows=N` (no columns, missing or
  value lists); only the answer's sources keep rows (other observed tables are
  listed by size); a function body shown by an earlier entry becomes
  `# def clean: code as in task 1 (cleaned)`.

Verified in `lean-entries.test.ts` and in the smoke (task 1's entry as seen by
task 2).

## Settings, arm, harness

`nativeAnswerFrom`, `nativeRegisteredOperators` (requires analysis state),
`nativeContractFlags`, `nativeLeanContext` (requires task efficiency); all
four fixed for a session (`updateSettings` refuses a change after the first
task). Arm `react-lean` = `react-registry` + the four
(`run-longds-turns.ts`, `run_official.py`, `session_budget.py`); per-turn stats
add `answer_composed`, `answer_from_calls`, `expect_calls`,
`projected_observes`. Live smoke: `bash logs/registry/smoke.sh
agent-service/benchmark/multiturn/lean-smoke.ts <outdir>` against the maint
stack with the sandboxed engine.

## Results

Campaign `LongDS_Lean_20260926` (react-lean, Survey/BI/Water, three trials,
GPT-5.2 judge, one-hour session cap): pending; `logs/registry/report.py`
compares it with react-registry, react-efficient and DSGym.
