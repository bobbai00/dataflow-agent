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

## Follow-up (2026-09-27): why DSGym fails, and DSGym with our task text

### DSGym with upstream's prompt

The tie decomposes by what DSGym did on the turn:

| DSGym did | Turns | DSGym right | Dataflow right |
| --- | --- | --- | --- |
| Gave up without code | 619 | 0 | 166 |
| Answered without code | 185 | 45 | 75 |
| Ran code | 1,385 | 643 | 442 |
| Session lost (policing task 1, context overflow) | 36 | 0 | 10 |

- **It often never starts.** 45 of 67 sessions began without running code
  (goodbooks task 1's first reply: "Unable to compute the review pool because
  the source-data execution results were not available"). Turn 1 right: DSGym
  14 of 68, dataflow 40.
- **Refusals are mostly false and self-reinforcing.** 23 of 34 sampled
  mid-session refusals were false: data never read (10), tables still in the
  kernel (7), a known calculation declined (6). After a refusal the next turn
  refuses 75% of the time, after a computed turn 8%.
- **Invented and retyped numbers.** 38 no-code answers hold numbers no output
  printed (survey-2018 task 3 turn 1 wrote a full gender table without reading
  the file); survey-2022 task 2 turn 3 retyped 23,998 where the kernel held
  23,997.
- **Output floods.** CDP task 1's prompt went from 2,053 to 503,157 tokens
  after one print; policing task 1 reached 1.3M tokens, past the model's limit.
- **Its own computed mistakes are ordinary.** Of 57 read: analysis slips 21,
  judge or answer-key faults 10, script state 9 (5 rebuilt an earlier step
  differently, 3 stale columns, 1 retyped number).
- **Not DSGym problems.** With clean inputs it stays 73-90% accurate at every
  prompt size, past 60k tokens, and state-changing turns are not worse.
- **Model-specific.** An older DSGym run on the stronger model gave up on 0 of
  72 turns. And upstream's prompt names only the data folder, where ours
  lists every file.

### DSGym with the dataflow arm's task text

`dsgym-shared` (df93f4973) keeps DSGym's agent, system prompt and
`<python>`/`<answer>` protocol, and sends each turn the text the dataflow arm
receives (file inventory, session rules, answer contract).

| Run (68 tasks, 2,225 turns) | Right | Accuracy | Cost |
| --- | --- | --- | --- |
| DSGym, upstream prompt | 688 | 30.9% | $8.44 |
| DSGym, our task text | 723 | 32.5% | $9.18 |
| Dataflow v4c (2026-09-26) | 693 | 31.1% | $13.01 |

- It runs code on 86% of turns (was 63%). Of the 528 turns it used to refuse
  it now computes, 163 are right.
- **Refusals persist.** Turn 1 without code in 37 of 68 sessions (21
  refusals); after a refusal the next refuses 66%, after a computed turn 1%. A
  new form: 27 answers are JSON objects of nulls. 13 of 23 sampled refusals
  were false (8 claim it cannot run code or read data it never tried).
- **Engagement brings cascades.** When it refused it left no state, so later
  turns recomputed from the raw files; now its early mistakes stay in the
  kernel. On turns both runs computed, upstream-clean but shared-broken turns
  fell from 80% to 45%; with both clean the runs are close (79% vs 74%).
- **Floods and unsupported numbers remain:** 9 prints over 100,000 characters
  in 5 tasks (policing task 1 overflowed again, 6 of 36 answered); 25
  no-code answers with numbers never printed.
- **Its own mistakes** (85 read): analysis slips 36%, missed conventions 14%,
  judge or answer-key faults 12%, rounding and percent-vs-fraction 9%,
  script state 14%. Our answer contract played a part in 4.
- **Clean-chain accuracy** is still the gap: 72% for DSGym vs 56% for dataflow
  v4c on the same 429 turns.

What dataflow already addresses: engagement (tool calls, the visible table
index; 92% of turns computed), floods (bounded observations), unsupported
and retyped numbers (answers composed from computed tables, with stated
precision), script-state errors (named, versioned tables read by reference),
and silent data loss (measured conversion failures, unmatched join keys,
missing-value tokens). What it does not: ordinary analysis slips, hidden
conventions, and the cascade itself; nothing in a session restates an earlier
correct result (0.4% of turns), so a wrong root is not signalled.

One correction came out of reading DSGym's traces: the Kaggle surveys' "None"
option is an answer the gold counts (survey-2022 task 2 turn 7: 5,177 vs
3,127 with "None" read as missing), as pandas read it before 2.0. The scan
now uses pandas 1.5's missing-value tokens (cc9dc11c0).

### The pandas-semantics and answer-precision build, one repetition

Changes (8bdf0d5bd, 41eee2551, cc9dc11c0): scan reads pandas' pre-2.0
missing-value tokens as missing and says so, renames repeated headers as
pandas does and names title lines in its error; aggregate drops null keys as
groupby does; tables keep pandas row labels through filter, sort, distinct and
head, and a process function receives them as the index; composed answers
state their precision (`t[:4]`, `t[col:2]`, `:full`), round as Python's
round() does, list several rows in order and refuse an all-null answer.

| Run (68 tasks, 2,225 turns, one-hour cap) | Right | Accuracy | Cost |
| --- | --- | --- | --- |
| Dataflow v4c (2026-09-26) | 693 | 31.2% | $13.27 |
| Dataflow, this build | 638 | 28.7% | $13.91 |
| DSGym, upstream prompt | 688 | 30.9% | $8.76 |
| DSGym, our task text | 723 | 32.5% | $9.18 |

The build does not show a gain in one repetition. Of the -55: -40 on the
1,947 turns both builds reached within the hour, -30 on turns only the old
build reached and +15 on turns only the new one reached. The tasks the
changes target moved as intended (survey-2018 task 1 +16, survey-2020 task 1
+11, PASSNYC task 2 +8, WUR task 3 +6, BI task 1 +4), and single tasks swung
by up to 19 turns on identical data (NFL task 1 21 to 2, WUR task 2 18 to 2:
a different Mahalanobis method at turn 4 cascaded), so the total is inside
one-repetition noise (about +-55 turns over 68 correlated tasks). Mechanisms:
48% of turns ended with a composed answer; 129 turns met a precision refusal
(the model rarely states precision on the first try, costing about one call);
16 turns read missing-value tokens, 6 renamed headers, 13 dropped null keys.

Run conditions differed from the earlier run: the survey tasks were rerun
together after the "None" fix and first ran nine at a time on one engine
(sessions capped with few turns), memory ran out twice (swap full; one
orphaned engine worker from a stopped session held 2 GB), and 20 tasks were
restarted. Next: measure the build against v4c with three repetitions on the
tasks where the mechanisms fire, before any claim; mark continuation lines of
quoted multi-line records in raw previews (survey-2022 task 1 skipped a
respondent after reading a two-line question row as two rows); cut engine
latency on wide and large tables, which decides the survey and CDP caps.

### Three repetitions on the tasks the build targets

The previous build (a663a077c) and this one (ac4509036: pandas semantics,
answer precision, record numbers in raw CSV previews) ran as two agent
services on one engine (819fa79ce), with the same harness and judge, three
trials of the five tasks where the full run moved most. No session reached
the one-hour cap.

| Task (turns) | Previous build | This build | Difference |
| --- | --- | --- | --- |
| Survey-2018 task 1 (30) | 25, 27, 26 (26.0) | 26, 25, 27 (26.0) | 0.0 |
| Survey-2022 task 1 (27) | 3, 3, 11 (5.7) | 3, 4, 5 (4.0) | -1.7 |
| PASSNYC task 2 (30) | 4, 8, 9 (7.0) | 15, 11, 12 (12.7) | +5.7 |
| WUR task 3 (23) | 17, 14, 18 (16.3) | 15, 18, 19 (17.3) | +1.0 |
| BI task 1 (27) | 15, 19, 17 (17.0) | 17, 18, 17 (17.3) | +0.3 |
| Total (137) | 64, 71, 81 (72.0), $0.61 a trial | 76, 76, 80 (77.3), $0.64 a trial | +5.3 |

The gain is PASSNYC task 2, where every trial of this build beats every
trial of the previous one. Its scan of `2016 School Explorer.csv` reads
1,268 cells (`N/A` 1,263, `NA` 5) in 19 columns as missing, as
`pandas.read_csv` does (396 in School Income Estimate, 73 to 86 in each
rating column); the task fills missing values with medians and modes, so
every later distribution follows. Turns 8, 9, 13 and 17 (Economic Need
Index spread, SPI group means) are right in 3 of 3 trials against 0 of 3:
at turn 13 both builds find the same thresholds and group sizes (318 and
318) but the previous build's ELA mean is 2.7344 against 2.7147. At turn 2
the previous build reported the correlation as -0.5446474559 and was
marked wrong only for that; composed answers now state their precision
(-0.5446). The other four tasks are inside their own spread. The full
run's survey-2018 +16 was a low draw of v4c (20), not the build: six new
sessions score 25 to 27 under both builds. Survey-2022 task 1 fails the
same way under both builds: the model does not fold China's
administrative-region labels into China, so from turn 3 the qualifying
countries differ (China missing from the top five, 58 respondents short);
the preview's record numbers fired at turn 1, and the model read the
two-line record correctly, but that was not the failure.

Over the 411 turns of this build: 51 turns met a precision refusal, 6 read
missing-value tokens, 9 dropped null group keys, 1 renamed a repeated
header. The full run's -55 was one-repetition noise; on the tasks it
targets the build is +5.3 turns a trial (+7%) at +5% cost.

### Engine latency on wide tables

A new operator over the cached survey (23,998 rows by 296 columns) took
about a minute: the engine moved the table one row at a time three times,
though Arrow holds it by column at both ends. The worker's reader turned
each stored row into a Tuple, cast it and copied each cell back into Arrow
(19 s); the main loop split each batch into rows again, with an executor
call and two thread switches per row, for a table operator that only
buffers them (about 35 s); and an output left as a Tuple per row, with a
cast and type check per cell, a deep size walk per row for the statistics
and two cell copies (about 18 s of CPU). Now plain-typed tables move as
whole Arrow batches (819fa79ce, 1495f4010); binary columns, rows split
across workers, loop operators and columns the per-row cast bridges keep
the per-row path. Latency probe (`latency-probe.ts`), same calls:

| Step on the survey | Before | Whole input batches | Whole output too |
| --- | --- | --- | --- |
| scan | 33.6 s | 38.8 s | 13.2 s |
| project two columns | 59.7 s | 6.4 s | 2.9 s |
| filter | 61.7 s | 8.7 s | 4.0 s |
| aggregate the narrow table | 6.3 s | 2.3 s | 2.1 s |
| process (a pandas function) | 21.7 s | 2.8 s | 2.5 s |

(The middle column ran beside 20 benchmark sessions.) The observations
are identical across engine versions and equal to pandas on the same
file: 23,998 rows, 4,559 respondents aged 18-21, share of men
0.7611467622301858, the twelve age counts.

## State, cascades and what the graph can add (2026-09-27, later)

The question: on turns that need an earlier state and whose inputs were
right, does the dataflow arm do better than DSGym? LongDS labels every turn
Initial, Update, Counterfactual or Rollback and lists the turns it depends
on, so the comparison can be made on the same turns.

| Paired turns: dependencies right in both arms, both computed | Turns | Ours | DSGym |
| --- | --- | --- | --- |
| v4c vs DSGym upstream | 169 | 67% | 83% |
| Pandas-semantics build vs DSGym with our task text | 291 | 71% | 75% |
| Pandas-semantics build vs DSGym upstream | 209 | 72% | 81% |

The gap is the same whether the needed state is one turn back or five or
more, and our arm reused its stored tables on 74-92% of these turns: the
earlier state is reached; what is done with it in the turn is where the
turns are lost. By label, every arm scores alike (Rollback 13-19%,
Counterfactual 20-23%, Update 21-28%), because 74-80% of all turns sit
downstream of a wrong result, where every arm is near 20%; turns whose
dependencies were all right score 66-69% in every arm. The state tools the
arm carries (bind, supersede, fork, at(name, task=N)) were used on 22 of
2,038 turns.

Three measurements then decided the next work:

1. **Detectability.** Only 4.1% of dependent turns restate a number that an
   earlier turn computed, and none of a sample of the "contradictions" with
   our stored state was real (all were parameters: weights, seeds, grid
   sizes). LongDS turns depend on hidden state and do not restate it, so an
   automatic check against the question text cannot trigger repairs.
2. **Context.** The lean mechanisms over the full session history
   (react-lean2-full) against the task catalog, five tasks x three trials:
   87.0 against 93.0 turns right of 137 a trial, at about twice the cost;
   69% against 77% on clean-input turns that need earlier state. The
   catalog loses nothing the full history would recover.
3. **Reading the losses.** The 67 paired turns only DSGym got right (33 for
   v4c, 34 for the pandas build), read one by one:

| Why ours failed | v4c | pandas build |
| --- | --- | --- |
| Engine semantics (index reset, carriage returns) | 5 | 0 |
| Precision | 7 | 4 |
| Presentation (order, scale) | 2 | 1 |
| Incomplete answer | 4 | 4 |
| Definition in force: a reused table built under another definition, or a re-derivation without the one in force | 4 | 8 |
| Value slips in a mapping (an alias, a missing key, an untrimmed label) | 2 | 5 |
| Other analysis errors | 7 | 10 |
| Judge noise | 1 | 2 |

The pandas build removed the engine and most precision causes. What remains
for the system are the definition-in-force and value-slip rows (13 of 34),
both at a custom step, which the evidence treated as opaque, and three
answer-contract gaps.

### The answer-contract and custom-step evidence build, three repetitions

Built from that reading (196d966e6, 00bdf472f): the stated precision
reaches numbers nested in list and text cells; a precision no request of the
session states is refused (56 of 68 tasks state the rule once, at turn 1); a
projection that keeps only numbers of rows a text column names is refused;
a custom step's rewrites, nulls and dropped rows are measured per kept text
column, rows matched by label; text values that differ only in case or
spacing are named; and each input of a custom step shows its row-changing
steps back to the scans (a lineage card). Against the build before them
(ac4509036), same engine and harness, seven tasks x three trials:

| Task (turns) | Previous build | This build | Difference |
| --- | --- | --- | --- |
| Survey-2021 task 2 (35) | 23, 17, 22 (20.7) | 17, 17, 24 (19.3) | -1.3 |
| acea task 3 (37) | 31, 34, 31 (32.0) | 34, 34, 32 (33.3) | +1.3 |
| LearnPlatform task 1 (25) | 7, 10, 13 (10.0) | 13, 14, 14 (13.7) | +3.7 |
| LearnPlatform task 2 (30) | 15, 14, 16 (15.0) | 22, 18, 18 (19.3) | +4.3 |
| careerVillage task 1 (30) | 24, 24, 25 (24.3) | 22, 21, 21 (21.3) | -3.0 |
| BI task 2 (30) | 19, 29, 26 (24.7) | 26, 28, 28 (27.3) | +2.7 |
| BI task 1, control (27) | 17, 15, 17 (16.3) | 17, 19, 19 (18.3) | +2.0 |
| Total (214) | 136, 143, 150 (143.0), $1.05 a trial | 151, 151, 156 (152.7), $1.08 a trial | +9.7 |

Every trial of this build is above the best trial of the previous one (+4.5
points, +3% cost; the difference of means is about 2.2 standard errors,
suggestive with three trials). The mechanisms fired: lineage cards on 201
turns, value receipts on 17, spelling variants on 14, the unlabeled-rows
refusal on 9, the session-precision refusal on none. The turns they were
built for moved where the mechanism reached them: BI task 2 t8 (rounding
inside a text cell) 1 to 3 of 3 trials, acea task 3 t14 (names kept) 2 to
3, LearnPlatform task 2 t16 (a mean of weekly means) 0 to 3, survey-2021
task 2 t7 (a role map) 0 to 2. Over all 16 targeted turns the count went 21
to 22, so most of the gain is elsewhere in the same tasks. careerVillage
task 1 lost in every trial: at t26 this build's function kept only answered
questions with a non-negative lag in the denominator (Austin 1.0958 against
1.0974), 0 of 3 against 3 of 3; reuse of stored tables does not explain it
(the previous build reused them in two of its trials and was right).

Found in the run and fixed after it: value receipts took a small table
rebuilt sorted for a rewrite (b9762359b); spelling variants skipped
careerVillage's industry column (2,470 distinct values over 28,152 rows,
above a fixed cutoff), now told from free text by repetition (010f47244),
so t4's untrimmed labels were not yet shown; and seven cells failed at
session setup because the web service's connection pool was exhausted by
overlapping workflow saves (each a full rewrite of 0.2-3.3 MB, up to 115 s
under 18 sessions). The failed cells were rerun at low load, and saves now
run one at a time per session (1a0fc378c).

### Full run of the build (one repetition)

The build at 2be719a8f (the pandas semantics and answer precision, record
numbers in previews, both engine latency changes, the answer contract, the
custom-step evidence, and one workflow save at a time), 68 tasks, one
repetition, the one-hour cap as the official score applies it:

| Run (68 tasks, 2,225 turns) | Right | Accuracy | Task mean | Cost |
| --- | --- | --- | --- | --- |
| Dataflow, this build | 732 | 32.9% | 34.6% | $15.61 |
| DSGym, our task text | 723 | 32.5% | 33.9% | $9.18 |
| Dataflow v4c | 693 | 31.1% | 32.4% | $13.27 |
| DSGym, upstream prompt | 688 | 30.9% | 32.6% | $8.76 |

The best single run so far, at 1.7 times the cost of DSGym with our task
text. Every turn was reached within the hour (v4c left 159 unreached; the
engine latency work removed the cap as a cause). Against DSGym with our
task text the build leads on 26 tasks, trails on 32 and ties on 10: the +9
comes from a few large wins (WiDS task 2 +15, survey-2020 task 2 +15, Kiva
task 1 +9, policing task 1 +9) against more and smaller losses (Netflix
task 4, survey-2019 task 3, energy task 2 and water task 1, -9 each). By
domain it leads on community, education, geoscience and social good and
trails on business (13.6% against 20.2%) and sports (3 tasks). One
repetition moves about +-55 turns, so the lead over DSGym is inside noise;
the three-trial comparisons (+5.3 and +9.7 turns a trial on their task
sets) are the firmer evidence for the changes.
