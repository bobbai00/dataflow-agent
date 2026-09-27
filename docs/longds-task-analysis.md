# LongDS: where the dataflow approach wins, where it falls short, and what to change

2026-09-26, branch `feat/state-registry`. One repetition of all 68 tasks
(2,225 turns), Luna, GPT-5.2 judge with the official prompt, one-hour session
cap. Dataflow arm: v4c (`react-lean2` settings; the model writes custom steps
as its own operators). Control: the upstream DSGym agent. Scores: dataflow
693 (31.15%), DSGym 688 (30.92%); cost $13.01 vs $8.44.

The analysis joins both arms per turn with the benchmark's own annotations
(state pattern, declared dependency turns). A turn has *clean inputs* in an
arm when every turn it depends on was correct in that arm's own session. A
*root failure* is a wrong turn with clean inputs: the first error of a
cascade. All 185 of our root failures were read and classified (question,
gold, our code and observations, both answers). Scripts are in
`logs/registry/` (`turn-dataset.py`, `turn-analysis.py`, `task-outcomes.py`,
`reuse-vs-fresh.py`, `root-summary.py`, `scan-divergence-all.py`); the
per-turn data and classifications are in `logs/registry/analysis/`.

## The shape of the result

The two arms are equally good when their inputs are right, and both are
dominated by cascades. They differ in where they fail.

| | Dataflow | DSGym |
| --- | --- | --- |
| Accuracy with clean inputs | 386/581 (66%) | 303/455 (67%) |
| on turns without dependencies (mostly turn 1) | 42/71 (59%) | 16/71 (23%) |
| on turns whose dependencies were all correct | 344/510 (67%) | 287/384 (75%) |
| clean inputs, last third of the session | 74/110 (67%) | 81/102 (79%) |
| Accuracy with a wrong dependency | 307/1644 (19%) | 385/1770 (22%) |
| Share of wrong turns that inherited an error | 87% | 90% |
| Turns that ran code | 92% | 62% |
| Same turn, both computed, both inputs clean (197 turns) | 127 (64%) | 159 (81%) |

Decomposed by source, the +5 total is the sum of a large win and a large
loss: +207 on turns where DSGym ran no code, −172 on turns both computed,
−30 on turns we never reached before the cap.

## Where the dataflow approach does well

1. **It always computes.** DSGym ran no code on 840 turns (38%) and was right
   on 45 of them; we were right on 251 of the same turns. Its give-ups are the
   model declaring the data inaccessible without running a cell ("the supplied
   data files were not accessible in the execution environment": Kiva task 3,
   turns 1 to 26), and sometimes reporting numbers with no code at all
   (LearnPlatform task 2 turn 1: "8,338,832 records", zero cells). Our loop
   has no path to an answer except through the dataflow tool. The 19 tasks we
   win by 5 or more (+163 turns) owe +154 of it to these turns.
2. **It gets the first turn right.** Turn 1 is usually the loading and
   cleaning audit. We are right on 40 of 68 tasks, DSGym on 14; DSGym ran no
   code at turn 1 in 46 tasks. The file inventory, raw previews and profiled
   scans make the first load reliable, and a correct root is worth a session:
   survey-2020 task 1 went from 3 to 19 correct when turn 1 came out right.
3. **Domains:** education 62.0% vs 49.5%, sports 23.9% vs 12.8%, business
   16.8% vs 14.4%, social good 27.7% vs 26.2%.

## Where it falls short

Per turn, given the same correct inputs, DSGym is more accurate (81% vs 64%
on the 197 shared clean turns), better late in a session, and recovers more
often after an upstream error. When its inputs were wrong and it re-read the
raw files in that turn, it recovered 49% of the time (27% when it reused
state); when we re-scanned, we recovered 21%, the same as reusing.

The 185 root failures, by cause (DSGym right on 70 of the same turns; the
downstream column counts later wrong turns that depend on these roots and
overlaps across roots):

| Cause | Roots | DSGym right | Later wrong turns downstream |
| --- | --- | --- | --- |
| Cleaning or definition choice by the model | 52 | 18 | 654 |
| Answer presentation | 39 | 18 | 233 |
| Misread question or convention | 28 | 4 | 453 |
| Engine or harness | 26 | 12 | 113 |
| Other, including judge noise | 17 | 5 | 162 |
| State or version | 9 | 5 | 40 |
| Statistical method | 5 | 1 | 55 |
| Reader differs from pandas | 5 | 4 | 51 |
| Precision drift from rounded intermediates | 4 | 3 | 34 |

By the dataflow mechanism that contributed:

| Mechanism | Roots | DSGym right |
| --- | --- | --- |
| None (the model's own analysis) | 126 | 37 |
| Composed answers (`answer_from`) | 30 | 17 |
| Operator semantics differ from pandas | 17 | 6 |
| Reader semantics | 5 | 4 |
| Entries hide details of earlier tables | 4 | 4 |
| Rounded tables reused downstream | 3 | 2 |

Two thirds of the roots are ordinary analysis mistakes that DSGym mostly
shares (it got only 37 of those 126 right). The fixable gap is in the
system's own mechanisms, and in engine time.

### 1. Composed answers (30 roots, DSGym right on 17)

The runtime composes the final answer from a table, so whatever the table
holds becomes the answer: unrounded values where the task states a decimal
rule (six answers ignored "4 decimal places": BI task 1 t11, WUR task 2 t20,
acea task 3 t11; survey-2018 task 1 t11 answered 24.489795918367346 for
24.49), float noise (fixed in f10b00d99), fractions where the task means
percents (PASSNYC task 2 t2: 0.01 for 1.0), required parts missing because
the answer comes from one table (WUR task 3 t18 omitted the per-country
rates; acea task 3 t14's projection dropped the name column), rankings
flattened into an object the judge reads as unordered (BI task 1 t8), and one
all-null answer accepted (survey-2022 task 3 t5).

### 2. Operators that behave unlike pandas (22 roots, DSGym right on 10)

The reference answers were produced with pandas, and the model writes its
functions with pandas habits. Where our native operators differ, the model's
code is silently wrong:

- **Filter resets the row index** (`runtime.py`, filter output). A function
  that aligns two tables by index then pairs the wrong rows with no error:
  survey-2022 task 1 t2 used the first 22,296 raw rows instead of the cleaned
  ones and poisoned turns 3 to 17 (India 8,132 vs gold 8,690); WUR task 3 t2
  paired 1,101 rows with 4,875 (r 0.22 vs gold 1.0).
- **Aggregate keeps a null group key as its own group**; pandas `groupby`
  drops it (survey-2021 task 2 t4: ten women with no country shifted a rank).
- **`row_number()` is 1-based**; the gold used pandas' 0-based positions
  (water task 1 t22: every row id off by one).
- **The reader** (measured over 353 CSV files of 30 datasets):
  missing-value tokens that pandas reads as missing (`NA`, `None`, `nan`,
  `N/A`, `#N/A`: 14.7 million cells, in the Kaggle surveys, CDP, LA, PASSNYC)
  stay text in our scan, which changes column types and counts (PASSNYC task
  2: replaying the model's exact code under pandas reproduces the gold on
  turns 8 and 17, under our scan our wrong answers); carriage returns inside
  quoted fields were dropped (317,000 cells; fixed in 5d2af5721); a blank
  header was named `column249`, not `Unnamed: 249` (fixed in 5c9e74562);
  duplicate header names are refused (pandas renames them `name.1`: 14
  files) and 18 files fail to parse that pandas reads (15 in Netflix). On the
  35 tasks whose data our scan reads differently, DSGym leads 35.8% to 31.6%;
  on the 33 read identically we lead 30.6% to 25.7%. That split is confounded
  with domain (the surveys are DSGym's strongest tasks), and the per-root
  reading attributes only 5 roots to the reader directly.

### 3. Engine time and the one-hour cap (171 turns unreached; DSGym right on 30)

Thirteen of our sessions reached the cap; DSGym's reached it once. In those
sessions the engine, not the model, took the time: Kiva task 2 spent 55 of
60 minutes in engine execution, the 2018 surveys 41 to 47, two CDP tasks 47
to 52, with many steps at exactly 240 seconds (the engine's no-progress
timeout). Each dataflow call executes and materializes every new or modified
table through the JVM and a Python worker, where DSGym's kernel keeps its
frames in memory.

### 4. State, context and reuse (16 roots)

- **In-place revisions rewrite recorded tables** (9 state roots): acea task 3
  t20 edited a shared function, which recomputed turn 16's table and changed
  the answer turn 23 relied on (Auser's wettest year 2010 became 2014).
- **Entries show row counts but not filters** (4 roots): WUR task 3 t4 and t8
  reused a 498-row scored subset for questions about all 500 universities.
- **Rounded tables feed later arithmetic** (3 roots): acea task 3 t32
  predicted with a slope rounded to 0.0003 on volumes near −30,000.

### 5. Harness and environment

Twenty of the 26 engine or harness roots are model requests that never
answered, all before the retry build (4fbff96b5); none since. The sandbox
lacks NLTK's stop-word corpus and an LZW GeoTIFF decoder (both arms). 32 of
4,077 program edits had doubled backslashes inside raw-string regexes
(policing task 2 t1 set the night share to 0 everywhere).

## What to change, in order of evidence

1. **Make composed answers safe.** Apply the rounding the request states
   ("rounded to N decimal places", else the session's convention), keep
   several rows as a list of row objects so order is explicit, refuse an
   answer that is all null, and state in the method section that
   `answer_from` is for a table that holds every quantity asked, on the scale
   asked (percent vs fraction). Direct effect: up to 17 turns DSGym got right,
   plus the turns built on them.
2. **Behave like pandas where the model assumes pandas.** Read the default
   missing-value tokens as missing (and say in the observation which tokens
   were converted, since `None` can be a real answer; `all_text=True` keeps
   them); rename duplicate headers as pandas does; parse as leniently as
   `read_csv`; keep the input's row labels through filter (or add a stable
   row id and flag index-based alignment across differently filtered
   tables); drop null group keys in aggregate as `groupby` does, or flag the
   null group; document `row_number()`'s base. Direct effect: up to 10 turns
   DSGym got right; the survey domain is where it should show.
3. **Cut engine latency on wide and large tables.** Keep a session's hot
   tables in memory between calls, skip re-materializing unchanged upstream
   tables, and fail fast instead of waiting 240 seconds. This recovers most
   of the 171 unreached turns and shortens every session.
4. **Protect recorded answers from in-place edits.** When an edit changes a
   table that a completed task answered from, say so in the receipt and point
   to `at(name, task=N)` or a new name.
5. **Show filters in entries**, not just row counts, and test the context
   hypothesis directly: our arm with full history on the ten tasks with the
   largest gap on shared clean turns, one repetition.
6. **Small ones:** add NLTK corpora and an LZW decoder to the sandbox; warn on
   doubled backslashes in raw-string regexes.

Caveats: one repetition per arm, so per-task swings are large; the
classification is a careful reading, not ground truth (17 roots stayed
unclear, 4 look like judge noise); downstream counts overlap across roots.
