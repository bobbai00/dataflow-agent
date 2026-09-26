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

Campaign `LongDS_Lean_20260926` (react-lean, Survey/BI/Water, GPT-5.2 judge,
one-hour session cap, Luna), `logs/registry/report.py` against the saved
controls. Trial 1:

| Arm | Survey | BI | Water | Correct/96 | Cost |
| --- | --- | --- | --- | --- | --- |
| react-lean t1 | 25/30 $0.115 (70 calls) | 30/30 $0.072 (50) | 8/36 $0.247 (80) | 63 | $0.435 |
| react-registry t1–t3 | 26, 26, 25 at $0.157, 0.141, 0.166 (94, 88, 98) | 28, 27, 30 at $0.077, 0.080, 0.074 (67, 69, 65) | 13, 11, 14 at $0.239, 0.204, 0.248 (96, 83, 95) | 67, 64, 69 | $0.474, 0.426, 0.488 |
| react-efficient t1–t3 | 20, 27, 28 | 28, 28, 29 | 13, 10, 9 | 61, 65, 66 | $0.411, 0.419, 0.423 |
| DSGym t1–t3 | 18, 20, 11 | 23, 16, 27 | 15, 10, 8 | 56, 46, 46 | $0.343, 0.277, 0.256 |

### Where the money went (trial 1, `call-anatomy.py`, `code-shape.py`, `context-anatomy.py`)

- **Calls per turn reached DSGym parity.** BI 1.67 (DSGym 1.6–1.8), Water 2.22
  (2.1), Survey 2.33 (2.5). The runtime composed the answer on 77% of BI
  turns (16 of 30 in a single call), 80% of Survey turns and 36% of Water
  turns. Only 3 of 54 `answer_from` calls were pure shaping calls.
- **An answer call is cheap.** In the registry arm it costs $0.0009 (BI),
  $0.0014 (Survey), $0.0016 (Water): a cached read of the prompt (22–49k
  tokens at $0.02/M), a ~1k-token cache write, ~150–320 output tokens. A tool
  call costs $0.0014–0.0036, of which output is about half.
- **Survey saved 22%** ($0.115 vs $0.14–0.17): 64 tool calls in both arms,
  the same 2.2k characters of code per turn, 24 answer calls fewer.
- **BI and Water did not.** The model spent the saving on code: 1428 vs
  915–1063 code characters per turn on BI and 6397 vs 4445–5852 on Water
  (43 docstrings where the registry arm wrote none, answer-shaping maps,
  more lambdas), so output tokens rose 8–16% on BI and 10–35% on Water while
  cached reads fell 22% and 9%.
- **Where a Water prompt goes.** At turn 36 the entries block is 237k
  characters, 60% of it function bodies of earlier tasks (registry: 55%).
  Cached reads are $0.02/M, so those bodies cost about $0.06 of the $0.25
  session; a rolling block of recent code rewritten each task would cost more
  in cache writes than it saves, and rewriting earlier entries breaks the
  cache prefix (`prompt-cache-append-only`). Data-measurement lines are 0–3%
  of the observation text the model read (complete tables omit them), so
  turning them off buys nothing.
- **Non-composed turns are judgment answers.** On Water 23 of 36 answers name
  winners, booleans and labels assembled from several tables; no table can
  express them, so the answer call is inherent there.
- **Registered operators were adopted little**: 3 calls on Water, 0 on BI and
  Survey (the model kept writing new process functions).
- **Flags**: BI raised one (the null-denominator judgment on the Python mean,
  the fact its imputation turns hinge on); Survey's 300-column raw table is
  above the profile's 128-column limit, so its header-row trap raised none.

### v1 over three trials

63, 60 and 46 of 96 at $0.435, $0.460 and $0.409. Trial 3's Survey collapsed
to 7/30: the model kept the duplicated header row as a respondent from turn 1
(raw count 23999 instead of 23998) and every later count inherited it. The
header-row flag exists for exactly this and did not fire, because the raw
table's 300 columns are beyond what a profile reaches the agent with (below).

### v2: `react-lean2` (commit 21a6ded43)

Targeted the output tokens: `answer_from: "t[key=column:digits, other]"`
renames, picks and rounds without a shaping statement, and the compact code
contract (`nativeCompactCode`: docstrings only on registered operators, no
comments, one-sentence reasoning, reuse before variants). Trial 1
(`LongDS_Lean2_20260926`, port 3052): Survey 20, BI 26, Water 12 = 58/96 at
$0.392. Code per turn fell to the registry arm's level (BI 1069 characters, no
docstrings), but `answer_from` adoption halved (BI 47%, Survey 40%), and an
answer call costs more than the shaping map v1 wrote inside the computing
call, so BI cost rose to $0.079. Two defects found in its traces: the refusal
of an `answer_from` was stored as the table's `note`, which entries fold into
the task's change line, so one refusal (Survey turn 9, a 58-row table) rode in
every later prompt; and the empty string counted as a missing-value token, so
every raw-line preview raised a flag. Fixed in 917a70d35 (`answerNote`,
event-only; token removed).

### v3: `react-lean2` settings, revised prompt (daa7dd6d8, 4870f9b70)

v1's `answer_from` guidance (compose in the computing call, shaping statements
allowed, the projection optional) with the compact code contract minus its
"observe only" sentence. Trial 1 BI: 29/30 at $0.057 with 44 calls (1.47 per
turn), 83% of turns composed, 927 code characters per turn: the first BI
session below the efficient arm ($0.063–0.067) and 25% below the registry
arm. Water: 7/36. Campaign `LongDS_Lean3_20260926` (three tasks, port 3052)
and `LongDS_Lean36_20260926` (goodbooks, LA, NFL, port 3051), three trials
each.

### Composed answers are as accurate as written ones

Over every lean session judged so far, turns whose answer the runtime composed
score no worse than turns the model answered in text: Water 18/59 (31%) vs
29/121 (24%), BI 87/92 (95%) vs 55/58 (95%), Survey 46/79 (58%) vs 28/41
(68%) with the trial-3 cascade in both columns. `answer_from` is not what
costs Water accuracy; the lean variants' Water scores (7–12) sit at the low
end of a band where every arm ranges 8–15.

### Wide tables: the profile never reaches the agent

Survey's raw table has 300 columns. The profiler's `max_columns` was 128 and
its own payload cap 64 KB; both are raised (400 columns, 512 KB: a 300-column
survey profile is 289 KB, a prefix of a few hundred rows within the 0.2 s
budget, with the header row and the tokens in the top values), and the flags
read existence facts from a prefix profile. The remaining gap is the engine's
result transport: `StructuredResultTransport.partitionStatistics` drops any
profile payload over 64 KB per worker (`metadata_payload_budget`), and it
parses the payload as JSON to recognize a profile, so compressing it would
misroute it. Raising that cap is a one-line Scala change with an engine
rebuild and a master restart, not done during the campaigns; until then the
header and token flags cover tables up to about 120 columns.
