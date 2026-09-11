# Motivating example: which operator results to send to the agent

Task `legal-hard-15` (KramaBench). All numbers below are computed on the real files;
all renders are in the format the agent actually reads.

---

## Part 1 — Setting and baseline

### 1(a) Data and question

**Question.** *How many total Identity Theft reports were there in 2024 from
cross-state Metropolitan Statistical Areas?* Gold answer: **243,377**.

**Data.** 52 files, one per state, `State MSA Identity Theft data/<State>.csv`.
Each file lists the metropolitan areas that touch that state, with two title lines
and a blank line before the header:

```
Alabama.csv                                              Georgia.csv
Metropolitan Areas: Identity Theft Reports,              Metropolitan Areas: Identity Theft Reports,
,                                                        ,
Metropolitan Area,# of Reports                           Metropolitan Area,# of Reports
"Anniston-Oxford, AL Metropolitan Statistical Area",264  "Albany, GA Metropolitan Statistical Area",606
"Auburn-Opelika, AL Metropolitan Statistical Area",451   "Athens-Clarke County, GA ... Area",386
"Birmingham, AL Metropolitan Statistical Area","3,968"   "Atlanta-Sandy Springs-Roswell, GA ... Area","42,616"
"Columbus, GA-AL Metropolitan Statistical Area","1,302"  "Augusta-Richmond County, GA-SC ... Area","2,113"
...                                                      "Columbus, GA-AL Metropolitan Statistical Area","1,302"
```

Two things matter for this task:

- A **cross-state** area (`GA-AL`, `PA-NJ-DE-MD`) appears **once in every state file it
  touches**, with the same count each time. Washington DC-VA-MD-WV appears four times.
- Report counts are strings with thousands separators (`"3,968"`).

So the table's natural grain is *(state, area)*; the question's grain is *area*.

### 1(b) The operator set, and the dataflow the agent builds

The agent does not write code. It assembles the workflow from a **fixed set of native
operators**, each fully specified by its parameters:

| operator | parameters | effect on the row set |
|---|---|---|
| `Scan` | file pattern, lines to skip, header, column names and types | creates a table |
| `Filter` | predicate | drops rows |
| `Project` | columns to keep / rename | none |
| `Compute` | new column = row-local expression (arithmetic, cast, string, date) | none |
| `Aggregate` | group-by keys, functions (`sum`, `count`, `avg`, `min`, `max`, `median`, `count distinct`) | collapses rows |
| `Join` | keys, join type | multiplies or drops rows |
| `Union` | — | adds rows |
| `Distinct` | columns | drops rows |
| `Sort` | columns, order | none |
| `Limit` | n, offset | drops rows |
| `UDF` | Python code | unknown |

The granularity of an operator is therefore set by the algebra, not by the agent: one
operator is one relational operation, and each operator type is one tool: the tool's
arguments are the operator's parameters plus the output table's `id` and its input
table(s). For this task the agent submits five calls in one turn:

```
scan     (id="identity_theft", files="data/legal/input/State MSA Identity Theft data/*.csv",
          skipLines=3, header=false, columns=["metropolitan_area", "reports"], allText=true)
filter   (id="non_blank",   input="identity_theft",
          predicate="metropolitan_area IS NOT NULL AND reports IS NOT NULL")
compute  (id="reports_num", input="non_blank",
          columns={"reports": "TRY_CAST(replace(reports, ',', '') AS INTEGER)"})
filter   (id="cross_state", input="reports_num",
          predicate="regexp_matches(metropolitan_area, ', [A-Z]{2}(-[A-Z]{2})+ ')")
aggregate(id="total",       input="cross_state",
          aggregations=[{"fn": "sum", "col": "reports", "as": "total_reports"}])
```

The engine runs the chain and holds the full table on every edge, with its statistics
(rows, per-column nulls and distinct counts, duplicate-row count):

| operator | type | rows out | what the data did |
|---|---|---|---|
| `identity_theft` | Scan | 660 | 52 files; title and footer lines read as rows (104 null areas, 208 null counts) |
| `non_blank` | Filter | 452 | dropped the 208 blank and footer rows |
| `reports_num` | Compute | 452 | `reports` str → int, 0 parse failures |
| `cross_state` | Filter | 94 | kept the cross-state rows: **43 distinct areas, 51 duplicate rows** |
| `total` | Aggregate | 1 | `593524` |

The agent answers **593,524**. Wrong by a factor of 2.4.

**Why.** The table the `Aggregate` consumes has 94 rows but only **43 distinct areas**:
37 areas appear twice, 4 appear three times, 2 appear four times. `sum(reports)` adds all
94 rows, so every cross-state area is counted once per state it touches. The fix is one
more operator — `Distinct` between `cross_state` and `total` — which gives **243,377**.
To add it, the agent has to notice that the 94-row table is not at *area* grain.

This is the dominant failure on this task in our corpus: of **336** runs of dataflow
agents, **165** answered ≈593k (no dedup), 99 answered 242,682 (deduped but dropped the
two cross-state *Micropolitan* areas), 40 answered 243,377.

Five operators, five result tables the engine already has. The question of this document:
**which of them go into the agent's context, and at what fidelity.**

---

## Part 2 — The naive approach: send every operator's result

### 2(a) What the agent sees, every step from now on

Every operator gets the standard block — schema, stats, sample rows, table profile:

```
### Operator `identity_theft` (Scan)
Properties: files = "State MSA Identity Theft data/*.csv", skipLines = 3, header = false
Result:
  Output Table: 660 rows, 2 cols
  	metropolitan_area                                   reports
  0	Anniston-Oxford, AL Metropolitan Statistical Area   264
  1	Auburn-Opelika, AL Metropolitan Statistical Area    451
  2	Birmingham, AL Metropolitan Statistical Area        3,968
  ...
  659	Source: Consumer Sentinel Network Data Book 2024…  NaN
  Column Schema and stats:
  - "metropolitan_area" (str): null=104, distinct=403, duplicate_values=153
  - "reports" (str): null=208, distinct=342, format=thousands
  Output Table profile:
  - duplicate rows: 256 of 660 (39%)                                    ≈ 700 tokens

### Operator `non_blank` (Filter)
Properties: predicate = "metropolitan_area IS NOT NULL AND reports IS NOT NULL"
Inputs: identity_theft (660 rows, 2 cols)
Result:
  Output Table: 452 rows, 2 cols
  	metropolitan_area                                   reports
  0	Anniston-Oxford, AL Metropolitan Statistical Area   264
  1	Auburn-Opelika, AL Metropolitan Statistical Area    451
  ...                                        (≈20 rows shown, 2k-char cap)
  Column Schema and stats:
  - "metropolitan_area" (str): null=0, distinct=401, duplicate_values=51
  - "reports" (str): null=0, distinct=342, format=thousands
  Output Table profile:
  - duplicate rows: 51 of 452 (11%)                                     ≈ 700 tokens

### Operator `reports_num` (Compute)
Properties: reports = CAST(REPLACE(reports, ',', '') AS INTEGER)
Inputs: non_blank (452 rows, 2 cols)
Result:
  Output Table: 452 rows, 2 cols
  	metropolitan_area                                   reports
  0	Anniston-Oxford, AL Metropolitan Statistical Area   264
  1	Auburn-Opelika, AL Metropolitan Statistical Area    451
  ...                                        (same 20 rows, now numeric)
  Column Schema and stats:
  - "metropolitan_area" (str): null=0, distinct=401, duplicate_values=51
  - "reports" (numeric): null=0, mean=2835.0, min=76, max=71624
  Output Table profile:
  - duplicate rows: 51 of 452 (11%)                                     ≈ 700 tokens

### Operator `cross_state` (Filter)
Properties: predicate = "REGEXP_LIKE(metropolitan_area, ', [A-Z]{2}(-[A-Z]{2})+ ')"
Inputs: reports_num (452 rows, 2 cols)
Result:
  Output Table: 94 rows, 2 cols
  	metropolitan_area                                                          reports
  0	Columbus, GA-AL Metropolitan Statistical Area                              1302
  1	LaGrange, GA-AL Micropolitan Statistical Area                              453
  2	Fort Smith, AR-OK Metropolitan Statistical Area                            302
  ...
  6	Washington-Arlington-Alexandria, DC-VA-MD-WV Metropolitan Statistical Area 19689
  ...
  90	Winchester, VA-WV Metropolitan Statistical Area                           191
  93	Minneapolis-St. Paul-Bloomington, MN-WI Metropolitan Statistical Area     5552
  Column Schema and stats:
  - "metropolitan_area" (str): null=0, distinct=43, duplicate_values=51
  - "reports" (numeric): null=0, mean=6314.1, min=100, max=67819
  Output Table profile:
  - duplicate rows: 51 of 94 (54%)                                      ≈ 700 tokens

### Operator `total` (Aggregate)
Properties: sum(reports) AS total_reports
Inputs: cross_state (94 rows, 2 cols)
Result:
  Output Table: 1 rows, 1 cols
  	total_reports
  0	593524                                                              ≈ 80 tokens
```

### 2(b) Why this is wasteful

| operator | rows | what its block adds over what the agent already has | cost |
|---|---|---|---|
| `identity_theft` Scan | 660 | the raw files — new information | ≈700 tokens/step |
| `non_blank` Filter | 660 → 452 | one number: 208 rows gone. The agent wrote the predicate; the 20 sample rows and the stats are the Scan block minus the blanks | ≈700 tokens/step + a full-table profile |
| `reports_num` Compute | 452 → 452 | nothing: same rows, one column typed exactly as the agent's own `CAST` says, 0 nulls | ≈700 tokens/step + a full-table profile |
| `cross_state` Filter | 452 → 94 | **the table the sum consumes: 94 rows, 43 areas, 54% duplicate rows** | ≈700 tokens/step |
| `total` Aggregate | 94 → 1 | the answer | ≈80 |

Contexts are append-only and re-shipped on every later step, so the two uninformative
blocks cost ≈1,400 tokens per remaining step and two extra full-table profiles per
execution, for the rest of the run. The one fact that decides the task sits in the fourth
block, formatted exactly like the two blocks above it that say nothing. Measured across the
corpus, rendering the same work as 4-6 operators instead of 2 costs 2.3-3.6× per task; on
320k-row tables the extra profiles pushed steps to ~45 s.

With fixed-grain operators every DAG looks like this. In our traces the same solutions,
re-expressed one relational operation per operator, average 15.7 operators per task
(median 11, p90 35) against 5.4 today. Sending every result is three times the blocks.

---

## Part 3 — The optimized approach: send only what the data decided

### 3(a) The rule

**The agent wrote the parameters; the data wrote the results. Ship a result only where the
data, not the parameters, decided it.** Native operators make this decidable per operator
type, because the type says what the data *can* decide, and the engine's statistics say
whether it *did*. Three fidelities — a block, a line, nothing:

| operator output | what the data decided | ship |
|---|---|---|
| `Scan`, `Aggregate`, `UDF` | a new table | **block** (schema, stats, sample) |
| the input of an `Aggregate` or `Join` | the grain the consumer will collapse or multiply — its parameters cannot tell, and this table is the last place it is visible | **block** |
| other `Filter`, `Distinct`, `Union`, `Limit` | the row count | **line**: rows in → rows out |
| `Compute` | values of one column; only its null / distinct counts can surprise | **line** only if null or distinct count moved against the source column, else nothing |
| `Project`, `Rename`, `Sort` | nothing | nothing |

Every input to the rule is already in the engine: the operator type, its parameters, and the
per-table statistics it computes anyway. Between two shipped tables the operators fuse into
one stage from the agent's point of view: it sees the stage's input, the stage's output, and
one count per row-set change inside.

### 3(b) The rule applied to this DAG

| operator | type | decision | because |
|---|---|---|---|
| `identity_theft` | Scan | block | new table |
| `non_blank` | Filter | line | rows 660 → 452; not consumed by an aggregate |
| `reports_num` | Compute | nothing | `reports`: null 0 → 0, distinct 342 → 342; the `CAST` did exactly what its parameter says |
| `cross_state` | Filter | **block** | rows 452 → 94, **and** its output is what `total` sums |
| `total` | Aggregate | block | new table, 1 row |

### 3(c) What the agent now sees

Nothing injected, no new notation; the same render with two entries reduced to their header:

```
### Operator `identity_theft` (Scan)
Properties: files = "State MSA Identity Theft data/*.csv", skipLines = 3, header = false
Result:
  Output Table: 660 rows, 2 cols
  ...                                                    (block unchanged from Part 2)

### Operator `non_blank` (Filter)
Properties: predicate = "metropolitan_area IS NOT NULL AND reports IS NOT NULL"
Result: Output Table: 452 rows, 2 cols (from 660)

### Operator `reports_num` (Compute)
Properties: reports = CAST(REPLACE(reports, ',', '') AS INTEGER)

### Operator `cross_state` (Filter)
Properties: predicate = "REGEXP_LIKE(metropolitan_area, ', [A-Z]{2}(-[A-Z]{2})+ ')"
Inputs: reports_num (452 rows, 2 cols)
Result:
  Output Table: 94 rows, 2 cols
  	metropolitan_area                                                          reports
  0	Columbus, GA-AL Metropolitan Statistical Area                              1302
  1	LaGrange, GA-AL Micropolitan Statistical Area                              453
  2	Fort Smith, AR-OK Metropolitan Statistical Area                            302
  3	Memphis, TN-MS-AR Metropolitan Statistical Area                            5502
  4	Texarkana, TX-AR Metropolitan Statistical Area                             317
  5	Philadelphia-Camden-Wilmington, PA-NJ-DE-MD Metropolitan Statistical Area  28438
  6	Washington-Arlington-Alexandria, DC-VA-MD-WV Metropolitan Statistical Area 19689
  ...
  87	Washington-Arlington-Alexandria, DC-VA-MD-WV Metropolitan Statistical Area 19689
  88	Weirton-Steubenville, WV-OH Metropolitan Statistical Area                 130
  ...
  93	Minneapolis-St. Paul-Bloomington, MN-WI Metropolitan Statistical Area     5552
  Column Schema and stats:
  - "metropolitan_area" (str): null=0, distinct=43, duplicate_values=51
  - "reports" (numeric): null=0, mean=6314.1, min=100, max=67819
  Output Table profile:
  - duplicate rows: 51 of 94 (54%)

### Operator `total` (Aggregate)
Properties: sum(reports) AS total_reports
Inputs: cross_state (94 rows, 2 cols)
Result:
  Output Table: 1 rows, 1 cols
  	total_reports
  0	593524
```

94 rows feeding the sum, 43 distinct names, 54% duplicate rows — and the Washington row
is on screen twice, once from the DC file in the head and once from the West Virginia
file in the tail, directly above the block that sums them. Adding `Distinct` before
`total` gives **243,377**.

### 3(d) Cost of the two designs, per step

| | operators | result blocks re-shipped each step | full-table profiles per run | where the evidence is |
|---|---|---|---|---|
| every operator's result | 5 | 5 (≈2,900 tokens) | 5 | present, fourth of five identical-looking blocks |
| only what the data decided | 5 | 3 (≈1,500 tokens) + 2 header lines | 3 | present, alone, directly above the sum |

Same DAG, same engine, same five operators on screen. The agent's view is fused where the
data did nothing and open where it did.

### 3(e) Why the Scan's stats were not enough

The Scan block already said `distinct=403` and `duplicate rows: 256 of 660`. That is a
property of the raw files — diluted (mostly blank rows), three operators away from the
sum, and not attached to any decision. At the aggregate's input the same fact is
`distinct=43 of 94`, `duplicate rows 54%`, directly above the operator whose function is
`sum`. Same duplication, different place; the rule ships the place where it is consumed.

*Footnote for the slide:* the second failure mode on this task — 99 runs at 242,682 — comes
from a predicate that keeps only `Metropolitan Statistical Area` and drops the two cross-state
`Micropolitan` areas (LaGrange GA-AL, Lebanon-Claremont NH-VT). That is a scope decision,
not a data change; no result table shows it.
