# Section 4 — Which results reach the model

*The agent wrote the parameters; the data wrote the results.* A dataflow agent
never needs to be told what it asked for. It needs to be told what the data
did about it, in the form its next action needs, at the step it needs it. This
section turns that sentence into a problem statement, a family of selection
mechanisms, and an evaluation. All numbers are from the per-operator-tool runs
of 2026-09-11 (36 LATEST runs, 18 tasks × two arms; `OP_GRANULARITY_PILOT.md`
§5–§7), unless marked otherwise.

## 4.1 The example

legal-hard-15: *how many identity-theft reports came from cross-state
metropolitan areas in 2024?* The lake has 52 state files; a metropolitan area
that straddles states appears once per state. The agent builds six operators:

```
scan      identity_theft   660 rows   52 files; title and footer lines read as rows (null=104 areas, null=208 counts)
filter    non_blank        452 rows
compute   reports_num      452 rows   "3,968" → 3968, 0 parse failures
filter    cross_state       94 rows   43 distinct areas, 51 duplicate rows
distinct  cross_unique      43 rows
aggregate total              1 row    243377
```

Every table above sits in the engine with its statistics. The naive context
sends all six in full — schema, per-column statistics, sample rows, table
profile — at every step, because in LATEST mode the whole snapshot is re-sent
each turn. Measured block sizes (medians over 36 runs): scan 1,726 chars,
filter 1,655, compute 1,912, distinct 1,842, aggregate 391. The naive render of
this chain is 9,200 chars per step, about 2,300 tokens, re-sent eight times.

One number in those 9,200 chars decides the task: `distinct=43` against `94
rows` on the table the aggregate consumes. Without a `distinct` the answer is
593,524, off by 2.4×; in the corpus 165 of 336 dataflow-agent runs gave that
answer. The rest of the render is the agent's own choices echoed back: which
files it opened, which rows it dropped, which cast it wrote.

Two more facts make "send everything" the wrong default rather than a harmless
one:

- **The model does not re-read.** Over the 36 runs, 56% of operator blocks
  were never referenced by any later tool call — not as an input, not by a
  column name in a predicate. 70% of all full renders were sent after the
  block's last use. Operator blocks are 91% of every LATEST context; the
  question itself is 8%.
- **Visible is not attended.** biomedical-easy-2 (*average age of patients
  with serous tumors analyzed in the study*): the sheet has 179 columns, the
  render shows 50 of them, and the decisive column was among the 50 —
  `"Case_excluded" (str): null=0, distinct=2, top_5={"No"=144, "Yes"=9}` was
  in the context at five consecutive steps. The model averaged all 14 serous
  patients (68.1) instead of the 12 analyzed (68.5). More context did not make
  the fact louder; it made it one line in 12,000 characters.

So the question of this section: for each table the engine holds, **what
about it is worth sending, and when.**

## 4.2 The problem

Given a dataflow `D` (typed operators with parameters, links), the engine's
table `T_v` and statistics `S_v` for every operator `v` (rows, per-column null
/ distinct / min / max / top values, duplicate rows, width), the question `q`,
and the trajectory so far (which tables the agent has acted on), choose for
every `v` a rendering `r_v` — full, count line, header, one derived fact,
nothing — and, inside a full rendering, which columns, rows and statistics to
include, so that the tokens sent are minimal while the agent's next action
still has what it needs.

Two kinds of signal are available without asking the model:

- **Data properties** (`S_v`): what the table is. Row count, nulls, distinct
  counts, value distributions, duplicate rows, width.
- **Flow properties** (`D`): what the table is for. The operator type says
  what the operator *can* change (Filter drops rows, Compute touches columns
  only, Aggregate collapses); the consumers say what the table's *grain* must
  satisfy (an Aggregate or Join downstream depends on it, a Filter does not);
  the frontier says what the agent acts on next; the trajectory says what it
  has already acted on.

Lineage is what makes these composable: `T_v` has a known parent and a known
operator, so "what the data decided" is the difference between `S_v` and its
parent's `S_u` under the operator's declared effect.

## 4.3 Mechanisms

A family, ordered by how much of the signal each uses. S1 and S2 are
implemented and measured; S3–S7 are proposed and sized from the same traces.

| | uses | what it sends | measured / expected |
|---|---|---|---|
| S0 naive | — | every table in full | baseline: 9,200 chars per step on the example |
| S1 type–flow rule | type, consumers, frontier | full for Scan / Aggregate / Join / UDF, for the input of any grain-sensitive consumer, and for the frontier; a count line for row-droppers; header for column-only operators whose stats did not move | 4,700 chars per step on the example (−49%); in the traces it turned 16% of blocks into count / header lines, accuracy unchanged (5/10 vs 4/10, 6/8 vs 6/8) |
| S2 probe retirement | type (`preview`), consumers, coverage by a real Scan | one line: `(preview superseded by scan x)`; errored probes keep one error line | previews were 28% of all characters sent; the model deleted 1 of 115. Verified: environment-hard-8 143.6k → 54.6k input tokens with the file-list prompt, legal-easy-4 previews retire at step 3 |
| S3 lineage diff | type, parent stats, own stats | a row-preserving operator renders as its delta: columns added / replaced with their null and distinct counts, rows unchanged; a row-dropper as its count and the columns whose distributions moved | compute blocks are 15–23% of characters (median 1,912); the header + moved-facts form is 294 |
| S4 use decay | trajectory | a table stays full while it is the frontier or was referenced by a tool call in the last *k* steps; afterwards header + count | 70% of full renders were past last use; on the example the scan and the 94-row table drop to two lines once the aggregate exists (−85% per step) |
| S5 budgeted columns | width, `q`, downstream references | under a per-step budget, wide tables show the columns the question names or whose values it quotes ("serous" → `Histologic_type`), then the columns downstream operators reference, then the rest | biomedical: 3 of 179 columns carry the task; the render showed 50 by position |
| S6 prepared facts | parent stats, own stats, consumer type | one derived line at the point of use instead of the statistics it is derived from: before an Aggregate or Join, `grain: 43 distinct metropolitan_area over 94 rows (2.2 per key)`; after a Compute, `reports: 208 of 452 did not parse`; after a Join, `matched 41 of 43 left rows`; on any flag-like column with a rare value, `Case_excluded = Yes: 9 rows` | the same numbers as today's statistics, one line each; this is the accuracy lever — 165 of 336 corpus runs missed the grain fact that was present in the stats |
| S7 model in the loop | everything above + the model | (a) *pull*: minimal render by default, an `inspectResult(id, columns, rows)` tool to expand (exists as an arm, unmeasured); (b) *side notes*: a small model reads the full statistics and the question and writes 1–3 lines per new table; the main model sees notes + frontier; (c) *learned policy*: the 56% / 70% labels above are training data for "will this block be referenced again" | (b) costs ≈ 700 input tokens per new table on a small model, ~$0.002 per task against $0.05 for the main model; (a) costs steps, which cost engine time (130–215 s per step on the 320k-row data) |

What the rows have in common: none of them looks at the table's content
beyond its statistics, and none is a summary the model writes about itself.
S1–S6 are decidable from `D`, `S`, `q` and the trajectory; S7b is the one
place a model reads statistics the main model will not see.

## 4.4 What the traces say about each

- **S1 saves less than it should.** 83% of blocks stayed full under the rule:
  38% of operators are Scans (always full), 26% were previews (frontier,
  hence full — the reason S2 exists), 20% are dead-end checks the model made
  and never revisited (frontier, hence full), and aggregates plus their inputs
  are full by design. The rule is right about *which* tables carry
  information and blind to *when* the information was consumed.
- **S4 is the largest lever left.** The model works at the frontier: it reads
  a table when it acts on it and rarely again (28 references to an older
  block by id in 254 calls). Decay after use is what turns a snapshot render
  into a working-set render while keeping the operator list, which is what the
  model navigates by.
- **S5 is a capacity argument, not a token argument.** A 179-column table
  costs the same 2,000-character cap as a 5-column one; what it loses is the
  126 columns not shown. Selection across tables pays for selection inside
  them.
- **S6 is where accuracy can move.** In every arm the failures are conventions
  the data could have flagged: duplicates across files (grain), excluded
  cases (a flag column), thousands separators (parse failures). The statistics
  contain these facts; a derived line at the operator that depends on them is
  the difference between "in the context" and "in front of the model".
- **S7a and S7b are the controls.** If a model asked to pull opens exactly
  what S4 hides, S4 is wrong; if side notes written by a small model beat S6's
  derived lines, the rules are missing a kind of fact. Both are cheap to run
  as arms.

## 4.5 Evaluation

Same 18 tasks (10 representative + 8 unusual-file-type), three repetitions,
gpt-5.6-luna, LATEST and DELTA; S0 and S1+S2 as baselines, then S4, S6, S5 and
S7b as arms. Per arm: pass, input tokens per step, cached share, cost, engine
time; and two safety measures — *needed-but-hidden* (pulls or re-scans of a
table that a mechanism had reduced) and *stale-full* (full renders past last
use, the 70% today). The claim to test is not that fewer tokens win; it is that
the same accuracy holds at a fraction of the context, and that prepared facts
move accuracy where more statistics did not.

## 4.6 Position

Implement in this order: S4 use decay (largest saving, one rule), S6 prepared
facts (the accuracy lever, four derived lines), S5 budgeted columns (wide
tables), then S7b side notes as the LLM control and S7a pull as the safety
check. S3 is the cleanest formulation of "what the data decided" but overlaps
S1 and S6; keep it as the framing, not as a seventh code path.
