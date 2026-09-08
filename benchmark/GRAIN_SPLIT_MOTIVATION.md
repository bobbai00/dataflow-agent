# Motivating example: where to cut an agent's operator

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

### 1(b) What the agent has built so far, and where it goes wrong

The DAG has one operator, the loader. Its code and its rendered output:

```python
# operator: identity_theft
def load():
    import glob
    files = sorted(glob.glob('data/legal/input/State MSA Identity Theft data/*.csv'))
    return pd.concat([pd.read_csv(f, skiprows=3, header=None,
                                  names=['metropolitan_area', 'reports'], dtype=str)
                      for f in files], ignore_index=True)
```

```
### Operator `identity_theft` (DataLoading)
Result:
  Output Table: 660 rows, 2 cols
  	metropolitan_area                                   reports
  0	Anniston-Oxford, AL Metropolitan Statistical Area   264
  1	Auburn-Opelika, AL Metropolitan Statistical Area    451
  2	Birmingham, AL Metropolitan Statistical Area        3,968
  ...
  659	NaN                                               NaN
  Column Schema and stats:
  - "metropolitan_area" (str): null=104, distinct=403, duplicate_values=153
  - "reports" (str): null=208, distinct=342, format=thousands
  Output Table profile:
  - duplicate rows: 256 of 660 (39%)
```

The agent now writes one operator that does the whole rest of the job — clean, cast,
filter to cross-state areas, sum:

```python
# operator: cross_state_total          input: identity_theft (660 rows, 2 cols)
def process(identity_theft):
    d = identity_theft.dropna(subset=['metropolitan_area', 'reports'])
    d['reports'] = pd.to_numeric(d['reports'].str.replace(',', ''), errors='coerce')
    cross = d[d['metropolitan_area'].str.contains(r', [A-Z]{2}(?:-[A-Z]{2})+ ', regex=True)]
    return pd.DataFrame({'total_reports': [cross['reports'].sum()]})
```

What the agent sees:

```
### Operator `cross_state_total` (DataProcessing)
Inputs: identity_theft (660 rows, 2 cols)
Result:
  Output Table: 1 rows, 1 cols
  	total_reports
  0	593524
```

Final answer: **593,524**. Wrong by a factor of 2.4.

**Why.** Inside the operator, `cross` had 94 rows but only **43 distinct areas**:
37 areas appear twice, 4 appear three times, 2 appear four times. `cross['reports'].sum()`
adds all 94 rows, so every cross-state area is counted once per state it touches.
Nothing the agent can see says so: the loader block shows the raw file grain, the
operator block shows one number. The 94-row table where the repetition is obvious was
never materialized — it lived and died inside the operator.

This is the dominant failure on this task in our corpus: of **336** runs of dataflow
agents, **165** answered ≈593k (no dedup), 99 answered 242,682 (deduped but dropped the
two cross-state *Micropolitan* areas), 40 answered 243,377.

---

## Part 2 — The naive approach: split at every statement

### 2(a) The split

Four statements, four operators. The last keeps the agent's operator id so downstream
references keep working; each stage aliases its input back to the original variable name.

```python
# cross_state_total__s1
def process(identity_theft):
    d = identity_theft.dropna(subset=['metropolitan_area', 'reports'])
    return d

# cross_state_total__s2
def process(cross_state_total__s1):
    d = cross_state_total__s1
    d['reports'] = pd.to_numeric(d['reports'].str.replace(',', ''), errors='coerce')
    return d

# cross_state_total__s3
def process(cross_state_total__s2):
    d = cross_state_total__s2
    return d[d['metropolitan_area'].str.contains(r', [A-Z]{2}(?:-[A-Z]{2})+ ', regex=True)]

# cross_state_total
def process(cross_state_total__s3):
    cross = cross_state_total__s3
    return pd.DataFrame({'total_reports': [cross['reports'].sum()]})
```

### 2(b) What every stage puts in front of the agent, every step from now on

```
### Operator `cross_state_total__s1`
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

### Operator `cross_state_total__s2`
Inputs: cross_state_total__s1 (452 rows, 2 cols)
Result:
  Output Table: 452 rows, 2 cols
  	metropolitan_area                                   reports
  0	Anniston-Oxford, AL Metropolitan Statistical Area   264
  1	Auburn-Opelika, AL Metropolitan Statistical Area    451
  ...                                        (same 20 rows, now numeric)
  Column Schema and stats:
  - "metropolitan_area" (str): null=0, distinct=401, duplicate_values=51
  - "reports" (numeric): null=0, mean=…, min=76, max=71624
  Output Table profile:
  - duplicate rows: 51 of 452 (11%)                                     ≈ 700 tokens

### Operator `cross_state_total__s3`
Inputs: cross_state_total__s2 (452 rows, 2 cols)
Result:
  Output Table: 94 rows, 2 cols
  	metropolitan_area                                                          reports
  0	Columbus, GA-AL Metropolitan Statistical Area                              1302
  1	LaGrange, GA-AL Micropolitan Statistical Area                              453
  2	Fort Smith, AR-OK Metropolitan Statistical Area                            302
  ...
  5	Washington-Arlington-Alexandria, DC-VA-MD-WV Metropolitan Statistical Area 19689
  ...
  90	Winchester, VA-WV Metropolitan Statistical Area                           191
  93	Minneapolis-St. Paul-Bloomington, MN-WI Metropolitan Statistical Area     5552
  Column Schema and stats:
  - "metropolitan_area" (str): null=0, distinct=43, duplicate_values=51
  Output Table profile:
  - duplicate rows: 51 of 94 (54%)                                      ≈ 700 tokens

### Operator `cross_state_total`
Inputs: cross_state_total__s3 (94 rows, 2 cols)
Result:
  Output Table: 1 rows, 1 cols
  	total_reports
  0	593524                                                              ≈ 80 tokens
```

**Why this is wasteful.**

| stage | rows | what it adds over the previous block | cost |
|---|---|---|---|
| `__s1` dropna | 660 → 452 | removes the 104 blank rows the agent already knows about | ≈700 tokens/step + a full-table profile |
| `__s2` cast | 452 → 452 | same rows, one dtype changed | ≈700 tokens/step + a full-table profile |
| `__s3` filter | 452 → 94 | **the table the sum consumes: 94 rows, 43 areas, 54% duplicates** | ≈700 tokens/step |
| final sum | 94 → 1 | the answer | ≈80 |

Contexts are append-only and re-shipped on every later step, so the two uninformative
blocks cost ≈1,400 tokens per remaining step and two extra full-table profiles per
execution, for the rest of the run. Only `__s3` carries the fact that matters. Measured
across the corpus, splitting the same work into 4-6 operators instead of 2 costs
2.3-3.6× per task; on 320k-row tables the extra profiles pushed steps to ~45 s.

---

## Part 3 — The optimized approach: compile against the input statistics

### 3(a) Inputs to the compiler

Available at the moment the agent submits `cross_state_total`, before anything runs:

1. **The code** (four statements above).
2. **The engine's full-table profile of the input**, already computed when `identity_theft`
   ran and already sitting in the render:

| `identity_theft` | value |
|---|---|
| rows | 660 |
| `metropolitan_area` (str) | null 104, distinct 403, duplicate_values 153 |
| `reports` (str) | null 208, distinct 349, format thousands |
| duplicate rows | 256 of 660 |

### 3(b) Propagate the profile through the statements

Each statement is a relational step with a known effect on rows and columns. The compiler
carries `(rows, columns, per-column facts, duplicate rows)` through them:

| statement | effect derived from the profile | flag |
|---|---|---|
| `dropna(subset=[area, reports])` | rows = 660 − 208 nulls = **452**; nulls → 0 | — |
| `to_numeric(reports)` | rows 452; `reports` str → numeric | — |
| `contains(regex)` | rows **≤ 452**, count unknown until run; a filter cannot create duplicates, so duplicate rows ≤ 51 and `distinct(area) < rows` still possible | — |
| `cross['reports'].sum()` | aggregate **without groupby** over a frame whose natural key `metropolitan_area` has **distinct 401 < rows 452** and **51 duplicate rows** | **grain mismatch: the sum will count repeated rows** |

Rules used: row counts follow nulls and filters; a `groupby(k)` is bounded by `distinct(k)`;
an aggregate over a frame whose key is not unique is flagged. Unknowns stay unknown —
they only limit where the compiler can act, never correctness.

### 3(c) Place the cut

**Rule:** cut where the flagged effect exists as a table. For an aggregate flag that is the
last frame the aggregate consumes — the output of the filter. Legality check: the tail
needs only `cross` (liveness holds). Everything before it is row-preserving or unflagged
and folds into the first stage.

Result — two operators instead of four:

```python
# cross_state_total__filter
def process(identity_theft):
    d = identity_theft.dropna(subset=['metropolitan_area', 'reports'])
    d['reports'] = pd.to_numeric(d['reports'].str.replace(',', ''), errors='coerce')
    cross = d[d['metropolitan_area'].str.contains(r', [A-Z]{2}(?:-[A-Z]{2})+ ', regex=True)]
    return cross

# cross_state_total
def process(cross_state_total__filter):
    cross = cross_state_total__filter
    return pd.DataFrame({'total_reports': [cross['reports'].sum()]})
```

### 3(d) What the agent now sees

Nothing injected; the standard render of the new operator:

```
### Operator `cross_state_total__filter`
Inputs: identity_theft (660 rows, 2 cols)
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
  Output Table profile:
  - duplicate rows: 51 of 94 (54%)

### Operator `cross_state_total`
Inputs: cross_state_total__filter (94 rows, 2 cols)
Result:
  Output Table: 1 rows, 1 cols
  	total_reports
  0	593524
```

94 rows feeding the sum, 43 distinct names, 54% duplicate rows — and the Washington row
is on screen twice, once from the DC file in the head and once from the West Virginia
file in the tail, directly above the block that sums them. Adding `drop_duplicates()`
before the sum gives **243,377**.

### 3(e) Cost of the three designs, per step

| | operators | extra blocks re-shipped each step | full-table profiles per run | answer |
|---|---|---|---|---|
| agent's fused operator | 1 | 0 | 0 | 593,524 — wrong, silently |
| naive statement split | 4 | 3 (≈2,100 tokens) | 3 | evidence present, behind two noise blocks |
| stats-driven split | 2 | 1 (≈700 tokens) | 1 | evidence present, alone, at the point of use |

### 3(f) Why the loader's stats were not enough

The loader block already said `distinct=403` and `duplicate rows: 256 of 660`. That is a
property of the raw files — diluted (mostly blank rows), three statements away from the
sum, and not attached to any decision. At the cut the same fact is `distinct=43 of 94`,
`duplicate rows 54%`, under the code line whose next step is `.sum()`. Same duplication,
different place; the place is what the compiler chooses.

*Footnote for the slide:* the second failure mode on this task — 99 runs at 242,682 — comes
from a regex that keeps only `Metropolitan Statistical Area` and drops the two cross-state
`Micropolitan` areas (LaGrange GA-AL, Lebanon-Claremont NH-VT). That is a scope decision,
not a data change; no split shows it.
