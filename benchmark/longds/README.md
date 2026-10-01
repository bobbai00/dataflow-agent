# LongDS-Bench connector

Runs [LongDS-Bench](https://arxiv.org/abs/2605.30434) (`zjunlp/DataMind`, `longds/`)
against the dataflow agent. LongDS is 68 tasks / 2,225 turns of long-horizon data
analysis where turn N+1 depends on analytical state built in turns 1..N; the best
published model reaches 48.45 and its dominant failure class is Cascade Error — a
locally-correct turn poisoned by an earlier wrong state.

Each task runs as **one agent + one workflow**, every turn another
`{type:"message"}` on it. Nothing is reset between turns: the operators, their
code, their materialized results and the DELTA event log are the carried state.
`DataflowSystem.serve_query` is deliberately bypassed — it recreates the agent per
query (`dataflow_system.py:561-577`), which destroys exactly what is measured here.

## Layout

| file | role |
|---|---|
| `numeric_gate.py` | runs upstream's gold Python in our venv and diffs every published answer. Run this for any new task before trusting a score. |
| `prepare.py` | splits the dataset into a manifest (`turn_id`, `context`, `question`) and a gold file the runner never reads |
| `arms.py` | arms as `DataflowSystem` subclasses, unregistered so KramaBench's harness cannot pick them up |
| `run_longds.py` | the turn loop, per-turn checkpointing, dual artifact emission |
| `judge_longds.py` | upstream's `JUDGE_PROMPT` loaded by path, scored via litellm; reports both aggregations and the state-pattern / dependency-breadth / progress breakdowns |
| `analyze_run.py` | per-turn cost, steps, and context growth |

## Setup

This harness lives in the dataflow-agent repo at `benchmark/longds`, parallel to
the KramaBench submodule (`benchmark/Kramabench`) whose venv and `systems.*`
machinery it borrows — see `_paths.py` for the full layout. One-time setup
(DataMind clone, HF task download, symlinks, venv) is handled by:

```bash
bin/bench.sh setup
```

Data is **not** in the repo. `bin/bench.sh longds download --task <domain/dataset/task>`
fetches one more task from HF `zjunlp/LongDS` into `benchmark/longds/DataMind/longds/dataset`;
the full dataset is 19.5 GB, a single task is usually well under 200 MB.

## Running

```bash
bin/bench.sh longds gate                                                   # go/no-go, see below
bin/bench.sh longds prepare --task sports/nfl_big_data_bowl_2023/task1
bin/bench.sh longds run --task sports__nfl_big_data_bowl_2023__task1 --arm haiku-delta-1k
bin/bench.sh longds judge --sut LongDS_LongDSHaikuDelta1k --judge-model gpt-5.2
bin/bench.sh longds analyze --sut LongDS_LongDSHaikuDelta1k --task sports__nfl_big_data_bowl_2023__task1
```


## Deviations from the official protocol — state these with any number

1. **Judge model — resolved.** The paper's judge, `deepseek-v4-pro`, is reachable
   through OpenRouter, so scores can be made directly comparable:

   ```bash
   set -a && . ./.env && set +a
   JUDGE_BASE_URL=https://openrouter.ai/api/v1 JUDGE_API_KEY=$OPENROUTER_API_KEY \
     .venv/bin/python longds/judge_longds.py --sut <SUT> \
       --judge-model deepseek/deepseek-v4-pro --overwrite
   ```

   The litellm default (`gpt-5.2`) stays the cheap local option. On the pilot's 41
   judgeable turns the two judges **agree on 38 (92.7%)** — about the paper's own
   93.11% human-vs-LLM agreement — disagreeing only on turns 12, 13 and 22. So
   gpt-5.2 is a sound stand-in for arm-vs-arm work, and deepseek-v4-pro is what to
   use for any number quoted against the paper. Note OpenRouter authorizes each
   request against the remaining account credit, so `--max-tokens` is explicit
   (default 4000) — the model's own 65k default 402s on a zero-credit account.
2. **Runtime.** Not DSGym's pinned Docker Jupyter executor and not their fixed
   40-step `<python>` ReAct loop — the agent builds a workflow with its own tools.
   That is the point of the exercise, but it means this is not a leaderboard score.
3. **Answer contract.** The prompt asks for a single-line JSON object on a
   `**Final Answer:**` line. Upstream's DSGym runner uses `<answer>` tags; their
   Codex/Claude runners use a JSON schema. All three differ; ours matches theirs in
   substance (judge sees a JSON string) but not in syntax.
4. **Numerics gate.** Gold answers were computed on a frozen 181-package stack and
   the judge demands exact equality with no rounding, so version drift can fail
   correct work. Measured on the pilot task: **42/42 answers reproduce exactly** in
   our venv (pandas 2.2.3 / numpy 2.1.0). Re-run `numeric_gate.py` for new tasks.

## Resume granularity is the TASK

Agents live only in agent-service's process memory (`server.ts:281` — no session
table). A crash, a Bun restart, or an engine recycle loses the trajectory even
though the workflow row survives in Postgres, so a half-finished task is re-run
from turn 1. `--skip-done` skips only fully-completed tasks. Corollary for pools:
recycle at task boundaries, never mid-task.

## Historical-state pilot

`agent-service/benchmark/multiturn/run-state-history.ts` runs one continuous
session with either `baseline` or `history` actions. Set
`TEXERA_AGENT_MODEL=gpt-5.6-luna` or `gpt-5.6-terra`, point
`TEXERA_AGENT_SERVICE_ENDPOINT` at the experiment service, and enable the same
`TEXERA_LLM_TRACE_DIR` on the service and runner. Arguments are the prepared
directory, a new output directory, the arm, and an optional declared turn limit.

Both arms use native ReAct, DELTA history, the same predefined-operator guidance,
40 calls per turn and 2,000 characters per result. Only the history setting,
its action schema and its system-prompt instructions differ. The service's
`MODEL_MAX_OUTPUT_TOKENS`, `MODEL_SDK_RETRIES` and `MODEL_RETRIES_PER_TURN`
environment variables bound model output and retries independently of engine
timeouts. Record these values in the experiment protocol.

The runner saves user prompts, answers, full action receipts, per-step snapshots,
effective settings and provider usage. Diagnostics flag repeated actions, cycles,
repeated reads, missing answers, changed request prefixes and provider failures.
These flags need trace review; they do not establish a cause or automatically
change the agent's actions. Cached-token counts come from provider usage;
character-prefix overlap is a separate measurement. Missing usage fields remain
unknown in the wire audit. Cost estimates must retain their model-specific
pricing source, including separate cache-read and cache-write rates.

Use the pinned upstream correctness prompt with `deepseek/deepseek-v4-pro`.
`annotate_errors.py prepare --native-campaign ...` adapts saved native traces
for the paper's original Appendix E.3 prompt and Codex `gpt-5.5` at `xhigh`.
Annotation accepts a complete session or a predeclared prefix, validates every
incorrect turn's label, and preserves original scores. Reference files remain
unmodified. Inspect disagreements and distinguish a root state error from its
later cascades before interpreting accuracy differences.

## First result — baseline, 2026-08-03

Arm `luna-delta-1k`: gpt-5.6-luna, DELTA, 1k result chars, no stats, no
code-in-snapshot, `max_steps=40`/turn, **append-only history** (`contextWindowTokens=0`,
nothing trimmed). Task `sports/nfl_big_data_bowl_2023/task1` — 42 turns, the longest
in the benchmark, and it exercises all four state-evolution patterns.

**24.39%** under the paper's own judge, `deepseek-v4-pro` (10 of 41 judgeable turns;
one turn's judge reply was unparsable and is excluded). Under `gpt-5.2`: 23.81%
(10/42). $9.99, 70 min, 7.8 steps/turn mean.

| cut (deepseek-v4-pro judge) | result |
|---|---|
| by pattern | Update 27.3 · Counterfactual 25.0 · Initial 15.4 · **Rollback 15.4** |
| by task progress | 0-25% 30.0 · 25-50% 50.0 · 50-75% 18.2 · **75-100% 0.0** |
| by dependency breadth | 2-3: 23.1 · 4+: 23.1 |
| context growth | 20.6 kB → 920 kB (21.9 kB/turn), ending at ~230k tokens ≈ 85% of the window |
| cost shape | $0.0095 on turn 1 → $0.90 on turn 36 |

Read against the paper: sports is its hardest domain — GPT-5.4 10.52,
DeepSeek-V4-Pro 15.82, Claude-4.6-Sonnet 19.76, Gemini-3.1-Pro 31.85, Kimi-K2.6
32.85. At 24.39 on its longest sports task, an untuned first run sits above Claude
and DeepSeek and below Gemini and Kimi. Treat that as indicative only: this is one
task, the domain has three, and the agent builds a workflow rather than running
DSGym's fixed ReAct loop.

The *shape* replicates their headline finding, and more sharply: accuracy decays to
**zero** in the final quarter of the task, and Rollback is the worst pattern under
both judges.

## Second experiment — turn-boundary state recall, 2026-08-04

The paper's failures are state failures, and a dataflow's state is addressable, so:
replace the ever-growing event log at each turn boundary with a `# Prior Turns`
catalogue (request / operators touched / answer) plus a read-only `recallState`
tool the model calls to pull what it actually needs — a past turn in full, an
operator's code as of a past turn, an operator's revision history, a result sample.
Turn-aligned on purpose: the prompt prefix has to change when a new request
arrives, so the reorganization is free there and the prefix stays cacheable within
the turn. Knobs (all default-off): `userTaskPlacement`, `turnHistory`,
`enableRecallTool`.

**Verdict so far: not a win.** gpt-5.6-luna, judged by deepseek-v4-pro:

| arm | water-potability/task3 (36 turns) | nfl/task1 (42 turns) |
|---|---|---|
| baseline (request on top, full history) | **33.3%** / $2.16 | **24.4%** / $9.99 |
| recall v1 — catalogue only | 11.1% / $1.56 | 2.4% / $2.77 |
| recall v2 — + current snapshot | 17.1% / $3.04 | 11.9% / $5.51 |
| recall v4 — + code, + recalled-state | 28.6% / $2.85 | rerun in flight |

Within ~5 points of baseline at ~30% more cost, but faster in wall-clock (32.8 vs
41.9 min) and better on the early turns (first quarter 77.8 vs 66.7). Rollback got
*worse* (25.0 → 12.5), which is the opposite of the design intent and is the next
thing to read traces for.

Four bugs, every one found by running it rather than by reading the code:

1. **Off-by-one turn numbering** — the tool counted the synthetic `initialize`
   group that the renderer drops, so the catalogue's "Turn 1" and the tool's
   `turn: 1` disagreed. 44 recall calls in one turn, no answer.
2. **Snapshot starvation** — legacy DELTA sets `currentSnapshot: false` because
   every schema and result lives inline in the events. Cataloguing them deleted the
   state: a 13 KB turn-20 prompt with zero `Output Table`.
3. **Code starvation** — same class. A baseline prompt carried 79 `def process/load`
   blocks; the catalogued one carried zero, leaving the agent blind to its own code.
4. **Tool output does not persist** — the big one. The re-rendered context keeps a
   tool CALL but not its OUTPUT, so recalled state evaporated on the next step and
   the model re-asked forever (98 calls in one turn). `inspectResult` already had
   `# Inspections` for exactly this; `recallState` needed `# Recalled State`. Note a
   per-turn call budget did **not** contain the loop — refusing a call still costs a
   step, so 88 steps went to rejections.

### v5 — the snapshot as an index (2026-08-04)

v4's own snapshot render turned out to be the cost bug: every operator's code and
result table re-sent every step (323 operators = 438 KB of a 463 KB NFL prompt).
v5 renders every operator as summary + `Schema:` line only; code and sample rows
appear only for operators touched by the turn in progress; everything else is one
`recallState` call away and recalled output persists for the turn.

| task | baseline | recall v5 |
|---|---|---|
| water-potability (36 turns) | 33.3% / $2.16 | **36.1% / $1.40** |
| nfl (42 turns) | 24.4% / $9.99 | 9.8% / $9.92 |

WP wins on both axes under BOTH judges (gpt-5.2: 33.3 vs 25.0), with Update turns
18.2 → 54.5 and recall usage up 6× — a lean push is what makes the model pull.
NFL fails from turn 2, its heavy-formula turn: shape-only rendering hides the
VALUES of the tables the formulas consume, and the baseline still had turn 1's
sample rows in view. The next lever is a value channel for operators the current
work reads from (lineage/recency-graded sampling, not the binary
touched-this-turn rule), plus operator retirement — NFL reaches 300+ operators
and the index itself grows O(ops).

Judge-noise finding from the same traces: on the recall arm the two judges agree
100% (35/35); on the baseline they disagree on 5 turns where deepseek-v4-pro
forgave wrong numbers on yes/no questions. The baseline's WP score is partly
judge leniency; gpt-5.2 follows the benchmark's exact-numerics rule more strictly.

The transferable lesson: **in DELTA the event log is not history, it is the working
state.** Any compaction of it has to re-provide results *and* code by another route,
and any read-only pull tool needs its output rendered back into context. Both are
checkable by diffing prompt contents between arms — do that before trusting an arm's
accuracy number.

## Three things the first pilot establishes

- **Cascade is the mechanism, and the DAG only fixes half of it.** Turn 3 computes
  one percentile wrong (`first_score` 1.0685 vs gold 0.9755) and turns 5, 7, 8, 9,
  10 then fail on small numeric drift inherited from it. The workflow reliably
  prevents "forgot to recompute a dependent"; it does nothing about "recomputed
  faithfully from a wrong formula". Exact-match grading turns the second into a
  long tail of zeros.
- **Late turns stop answering the question.** Turn 42 returns "unrelated
  shortcut/player/team score lists" instead of the requested distances; turns 29,
  32 and 42 answered in ~1 step, twice by restating an earlier turn's answer. With
  `# User Task` at the top and ~900 kB of appended events after it, the live
  request is buried. This is the concrete case for turn-boundary compaction.
- **Append-only cost is quadratic, and prompt caching does not save it.** Cached
  input is a roughly fixed ~6k tokens per model step regardless of prompt size
  (measured here and in the KramaBench luna/terra arms, where the same fixed amount
  merely *looks* like 70% because prompts are small). Every step re-sends the full
  appended log at full price. At $9.99 for one task, the full 68-task benchmark
  would cost ~$680 on this arm — so compaction is a prerequisite for scale, not an
  optimization.

## v6 — turn addressing, and the retirement rule that was doing the damage (2026-08-06)

Three changes to the context, then a much larger finding underneath them.

**What changed.** (agent-service `f6cc01f39`)

1. **No `# Session Brief`.** Turn 1 had its own verbatim section while every later
   turn was clipped to a 260-character gist, which taught the model that only turn
   1's conventions bind. A session is one conversation; turn 1 is catalogue entry
   1. Requests are now verbatim for every turn — they average 624 characters, so
   the whole 42-turn NFL catalogue is ~30 kB against a 400 kB+ prompt, and it sits
   in the append-only prefix. The same clip was also truncating **73% of answers**
   (mean payload 752 chars), so the catalogue had been misreporting the agent's own
   prior results on three turns in four.
2. **`recallState` is addressed by TURN.** The five-way `what` selector is gone;
   one call returns a turn's request, answer and operator delta, with the verb from
   a snapshot diff and code/results read from *that turn's* snapshot rather than
   HEAD. Verbosity is the caller's (`includeCode`, `includeResults`,
   `includeStats`, `maxResultChars`), clamped service-side because a recalled block
   is re-rendered on every remaining step of the turn.
3. **No cap on the turn's own code.** `indexRichCode` (default 6) meant the model
   could not tell whether a definition was absent or merely not rendered, so it
   rebuilt what it already had.

The tool behaves: 28 calls over 36 turns on water-potability, **zero** duplicate
fetches within a turn (the old version once made 98 in one turn), and the model
picks 2000–3000 char budgets, never near the clamp.

### The methodology error, first

Every arm-vs-arm number before this was **cross-vintage**: baseline 08-03, recall
arm 08-04 (four agent-service commits back), new arm 08-06, across a full JVM
restart. Re-running the baseline today:

| task | 08-03 | same-era | Δ |
|---|---|---|---|
| water-potability | 27.8% | 41.7% | **+13.9** |
| nfl | 24.4% | 31.0% | +6.6 |
| github | 93.3% | 86.7% | −6.6 |
| netflix | 8.8% | 8.8% | 0.0 |

Large, task-specific and **bidirectional** — so there is no global correction
factor, and several hours went into explaining a 31→7 NFL "regression" that was
partly an artifact. HANDOFF §4.6 already says this. Only same-era controls count.

### The finding: retirement was a turn count, and a turn count is the wrong variable

With the index as the primary state channel, `indexRecentTurns` (default 3) became
load-bearing — and it retires on recency-of-touch alone. On passnyc, from turn 5
the model saw **4 result tables out of ~23 live operators**, jumping back to 27 at
turn 8 when that turn happened to touch many. Visible state was a function of what
the current turn touched, not what it needed. The signature is progressive decay
*within* a run (so it survives the vintage problem): passnyc Q1 71.4% — better than
baseline's 57.1% — then 37.5% / 14.3% / 37.5% against baseline's 87.5% by Q4.

Same-era, deepseek-v4-pro judge:

| task | ops | baseline | K=3 | K=12 | K=24 | count cap 40 |
|---|---|---|---|---|---|---|
| passnyc | 31 | 63.3% | 40.0% | 76.7% | 73.3% | **83.3%** |
| water-potability | 73 | 41.7% | 33.3% | 47.2% | — | — |
| sustainable-energy | 160 | 16.7% | 11.1% | 25.0% | — | — |
| netflix | 194 | 8.8% | 14.7% | 5.9% | — | — |
| nfl | 277 | 31.0% | 7.1% | FLOOD | — | **21.4%** |
| uber | 381 | — | 13.9% | FLOOD | — | — |

On the two tasks that exposed OPPOSITE failure modes — passnyc starved at K=3,
NFL flooded at K=12 — the count cap beats the baseline on both axes at once
(72 turns, turn-weighted): **47.2% at $6.44 against 44.4% at $10.27**, with cost
per correct answer $0.189 against $0.321. The shipped K=3 arm scored 20.8%.

NFL is improved rather than solved: 7.1% -> 21.4% is a 3x recovery and it costs
34% less than the baseline, but it still trails baseline's 31.0% by 9.6 points.
It has 277 operators and the heaviest formula turns in the set, and it is the one
task where no configuration tried has beaten append-only history. The remaining
eight tasks were not re-run under the new default (time and budget), so the
count cap is validated on two tasks, not ten.

The same constant fails in **both directions at once**. At K=3 it starves a small
DAG. At K=12 it floods a large one: NFL and uber reached 360–600 kB of context and
spent turn after turn burning the entire 40-step budget to return an empty answer
(both abandoned). K=24 is *worse* than K=12 on passnyc, so retirement is worth
keeping — the index is what buys the cost reduction — and 3 was simply far too
aggressive.

Twelve turns of a 31-operator task and twelve turns of a 381-operator task are not
the same amount of context. So retirement now bounds the **count** of detailed
operators (`indexDetailedOperators`, default 40), most-recently-touched first, with
the turn's own work and its direct inputs exempt (agent-service `d968a2434`). Small
DAGs keep everything; large ones keep a bounded, relevant slice.

Two things that are NOT the mechanism, ruled out with measurement rather than
argument: it is not monotonic in DAG size (netflix, 194 operators, beat its
baseline at K=3), and it is not the value channel running out of width (max
operator fan-in is 4–6 on every task, against a cap of 12, so it almost never
binds).

### Operational notes

- **kiva is excluded**, for a measured reason: `kiva_loans.csv` is 195 MB, every
  operator edit re-executes it at ~190 s/step, and turn 1 blew even a 3600 s budget
  identically on both arms. That is an engine data-scale limit, not an arm
  property. `run_all.sh` gained `TURN_TIMEOUT` and the measurement is in its
  comment.
- `numeric_gate.py` now takes `--task` and handles what actually varies between
  tasks (path style, imports missing from upstream's unexported notebook cell,
  dict-vs-print answer publishing, and `dumps4`, the 4-decimal rounding step
  task.json was built through). **145/145 answers reproduce exactly** on the four
  tasks gated.
- Judge nondeterminism is ~1 turn (2.8 points on a 36-turn task): the same
  energy-baseline data judged 13.89% and 16.7% on two runs. Do not read small gaps.

## v7 — answer grounding, restore-via-recall, and what n=1 actually measures (2026-08-07)

Two general mechanisms, both keyed to dataflow properties, tested on five tasks
against same-era baselines (agent-service `ff26a2ef6`):

1. **Answer grounding** (`enableAnswerGrounding`): a final answer's substantive
   numbers must trace to a materialized operator result or to state recalled
   this turn; on total failure, one feedback round. The property is only
   checkable because results are addressable tables.
2. **Restore-via-recall + conventions** (prompt): rebuild earlier versions by
   copying recalled code verbatim, never from memory; rules stated in any turn
   bind until restated.

**Both were behaviorally inert.** Grounding fired 0 times in ~180 turns — under
index arms the model's answers *are* computed from tables (the restatement
failure it targets was observed on the append-only baseline, whose late-turn
burial the index already fixed). Rollback-turn recall usage was unchanged
(4/8 vs 5/8 turns), so the restore rule didn't move behavior either.

**The scores moved anyway, and that is the finding.** passnyc, all same-era,
all identical configs within each pair:

| run | score |
|---|---|
| cap40 #1 | 83.3% |
| cap40 #2 | 83.3% |
| grounded #1 | **43.3%** |
| grounded #2 | **80.0%** |

Two identical grounded runs differ by **37 points**. The mechanism is visible
at single-turn resolution: run #1's turn 12 counted **462** complete schools
where run #2 (and both cap40 runs, and gold) counted **472** — one join
micro-choice — and turns 13–30 all build on that clustering table. Quarter
accuracies: run #1 86/43/14/29, run #2 57/86/100/71. One number, thirteen turns.
Water-potability shows the same shape (turn 7 leader-comparison flip, five
downstream regressions, 25.0% vs K=12's 47.2%).

So: **on state-chained tasks, a single run does not measure the config — it
measures the config times one cascade lottery draw.** Deltas under ~20 points
at n=1 are unattributable. This retroactively widens the error bars on every
single-run comparison in this file; the cap40-vs-K3 passnyc gap (83.3 stable
twice vs 40.0) and the resume-v2 collapse (23.3, mechanistically explained)
survive it; single-run differences like grounded-vs-K12 on energy (11.1 vs
25.0) do not.

Remaining results: github grounded 86.7% (= baseline), energy 11.1% (n=1,
see above). NFL grounded was abandoned at 26/42: its seed failed turn 4 (both
arms' seeds did) and never recovered — 20 empty 40-step turns, $14.28. The
turn-4 trace refutes a render bug: of 27 operators the turn wrote, the model
itself deleted 14, and 13 of the 14 alive rendered rich. The thrash is
task-content difficulty, not starvation.

Operational: the catalogue's revision marker now names `recallState`, not
`resumeFrom` — an arm was being pointed at a tool it lacks, the same trap as
the resumeFrom turn-1 error loop (35 identical failing calls before the fix).

The forward directive this implies: **stop buying single runs.** For any
arm-vs-arm claim on LongDS, either replicate (2-3 seeds on cheap tasks) or
pick turn-level paired designs (same seed, flip one thing mid-run) — and treat
the cascade lottery itself as the phenomenon to attack: the highest-value
mechanism is whatever makes turn-12-class micro-choices deterministic
(verification at state-creation), not whatever moves the mean by 5 points.

## v8 — execution telemetry, replicated (2026-08-07)

Two render channels over facts the engine already computes (agent-service
`a8eba09a3`), tested at **two replicates per cell** — the v7 lesson applied:

* `Lineage: N rows in → M rows out (P%)` on every consuming operator, from the
  engine's execution counts. A fact, no thresholds.
* Coercion dataloss alarms (count + sample of values silently nulled by
  `errors="coerce"`), worker-computed unconditionally, render-gated. Verified
  general on synthetic dirt before running anything.
* Both ride along on `recallState` results, so a recalled version carries the
  defects recorded when it ran.

Three arms, one variable each: control (cap40), telemetry (cap40 + both lines),
stats (cap40 + `data_level=2`). Scores as run1/run2, deepseek-v4-pro judge:

| arm | passnyc | water-potability | github |
|---|---|---|---|
| control | 83 / 83 | 36 / 56 | 100 / 87 |
| telemetry | 73 / 80 | 36 / 33 | 87 / 87 |
| stats | **17 / 37** | 33 / 50 | 93 / 93 |

**The t12 lottery, now with 15 observations.** Every passnyc run's fate is set
by one number at turn 12 (complete-school count, gold 472): the four runs that
computed 462 score 17–43%; the ten that computed 472 score 63–83% (the one
exception, resume-v2 at 23%, failed for its own known reason). The telemetry
arm rendered the designed line — `Lineage: 477 rows in → 472 rows out (99.0%)`
— and took the correct branch in both replicates.

**Verdicts at n=2, stated with n=2 humility:**

* **Telemetry is accuracy-neutral and near-free** (≤1 line per operator, cost
  within noise). It did not demonstrably *prevent* the trap — control avoided
  the trap 3/3 without it — but it makes row loss legible, costs nothing, and
  is the only channel that records the defect on the version `recallState`
  returns. Keep it on.
* **Stats hurt passnyc, both replicates in the trap (462 twice), 17/37 vs
  control's 83/83.** The traces suggest a mechanism rather than pure luck:
  with every column's stats visible in one block, both stats runs folded the
  five-source join into ONE merge operator with less per-source dedup
  (`drop_duplicates('DBN')` per source is what the correct runs did), and
  duplicate keys survived. Stats describe the data well and seem to invite a
  flatter decomposition. n=2 — a hypothesis to test, not a conclusion.
* **Control variance remains the loudest signal**: 36 vs 56 on
  water-potability, same config. Nothing under ~20 points is real at n=1;
  ~10 points needs n≥3.

Costs (per task set, mean of reps): control $2.16, telemetry $1.72, stats
$2.12 — telemetry is the cheapest arm, stats the most expensive on the tasks
where it is also least accurate.

## v9 — the versioned catalog: one immutable DAG, strict (op, turn) refs (2026-08-07)

The design discussion's fixed point, built and tested (agent-service
`1d540a489`): the whole context is ONE `# Catalog` over an immutable version
DAG. Finished turns are structured entries (`### Task` verbatim /
`### Dataflow delta` with word verbs, per-operator Summary, Upstream *with
version provenance*, Result shape+schema / `### Answer`); "current" exists only
as a `### Current operators` pointer table; the turn in progress is the last
entry; recall output persists inline as an ordinary observation ("every
action's observation stays" — one rule replaces the `# Recalled State` tail).
No `# Dataflow` section at all: state renders once, at creation, so the prompt
is append-only end to end — the cache-optimal shape by structure instead of by
a cap.

On the write path, **every reference names its version**: `upstreams` maps each
def-arg to the turn whose version it builds on, revisions carry `fromTurn`,
and every rejection lists the valid turns (the resumeFrom lesson). Building on
the wrong version — the paper's Update/Rollback/Composition error class —
becomes a mistake that must be written down where the catalog contradicts it.

**The mechanics work.** Live traces: 29/35 (github) and 70/89 (passnyc)
process-writes carried `(op, turn)` refs, including cross-turn references in a
single call (`{"top10_issue_languages": 1, "top10_pr_languages": 6}`); one
version error across both, corrected on the teaching message; `fromTurn` used
on revisions.

**Results** (gpt-5.2 judge on BOTH arms — OpenRouter credits ran out mid-
campaign, so the deepseek evals are preserved as `results_eval.deepseek.json`
and this comparison is same-judge by construction):

| arm | passnyc | water-pot | github |
|---|---|---|---|
| control (cap40) | 80 / 73 · $0.50 | 31 / 42 · $1.53 | 100 / 73 · $0.13 |
| versioned | **33 / 37** · $0.66 | 28 / 36 · $1.12 | 100 · $0.18 |

github ties the control's best; water-potability sits inside the control's own
replicate spread at 27% lower cost; **passnyc fails, and both replicates fail
the same way: t12 = 462.** The trap count now reads — control 0/3 in the trap,
versioned 2/2, stats 2/2, telemetry 0/2. At these n's that is suggestive, not
proven, but versioned mode plausibly raises the odds of the bad t12 path
(less schema detail in view at the join-building moment than the cap40 index
provided). One hypothesis died en route: R2's trace deduped four of five
sources per-source and still landed 462, so the earlier "one big merge, no
per-source dedup" story is not the mechanism.

**Verdict: keep cap40 as the shipping config; keep versioned mode as the
research branch.** Its properties (append-only prompt, auditable version refs,
cheapest structure on big tasks) are the right shape, and its failure is the
same single unsolved failure everything else has: turn-12-class silent
derivation divergence. That is now unambiguously the bottleneck — no render
design tried so far moves it, which is the strongest argument yet for
verification at state creation (dual derivation of foundational quantities)
as the next mechanism.

---

## v10 — 2026-08-08: the rich versioned arm, three replicates, deepseek judge

**Configuration under test.** Versioned catalog (v9) plus a *rich observation
channel* inside the turn: DELTA, gpt-5.6-luna, `max_operator_result_char_limit`
2000 (was 1000), `data_level=2` + `column_stats` (schema, structural profile,
per-column numeric/string/date statistics), `row_lineage`, `coercion_facts`,
`recallState`, 40 steps. Arms `luna-versioned-rich{,-r2,-r3}`.

The bet came out of the v9 post-mortem: versioned mode kept landing on the bad
t12 path, and the most plausible reason was that dropping the state dump also
dropped **value evidence** at the moment join/derivation decisions are made.
This arm restores value evidence through the observation channel — general,
dataflow-native, no task-specific tuning.

**Protocol** (this is the first LongDS campaign that meets the bar set in
§4.6/§4.9): all four runs in ONE era, ten tasks each, every turn present
(309 turns per run, gate in `progress.log`), **three replicates** of the
experimental arm, and a fresh baseline `luna-delta-1k-e0808` rather than a
cross-era one. Judge is the paper's own **deepseek-v4-pro** via OpenRouter on
both arms.

| run | turn-weighted | task-macro | cost | empties | exec errors | 40-step turns |
|---|---|---|---|---|---|---|
| baseline delta-1k | 28.85 | 33.54 | **$32.78** | 3 | 1 | 1 |
| rich r1 | 31.43 | 38.43 | $15.95 | 1 | 0 | 0 |
| rich r2 | 25.63 | 30.66 | $16.20 | 1 | 0 | 1 |
| rich r3 | 27.96 | 32.54 | $14.08 | 2 | 0 | 1 |
| **rich mean** | **28.34** (sd 2.92) | **33.87** (sd 4.05) | **$15.41** | | | |

**Verdict: accuracy is a tie; cost is a 2.1x win.** 28.34 vs 28.85
turn-weighted and 33.87 vs 33.54 task-macro are both well inside a replicate
spread of ~3-4 points. The baseline's single run sits inside the rich arm's own
band, so nothing here separates the two on accuracy — and that is the honest
reading, not a defeat: the rich arm buys **2.1x lower cost** ($15.41 vs $32.78)
and a **2.2x smaller peak context** (517 kB vs 1130 kB on uber) while carrying
strictly MORE information per observation. On the big DAGs the gap is the whole
story: uber $11.67 -> $3.64, nfl $7.17 -> $3.99, energy $4.69 -> $1.29.

Per task (baseline / rich mean of 3):

| task | turns | base | rich | delta | $base | $rich |
|---|---|---|---|---|---|---|
| github | 15 | 93.3 | 93.3 | +0.0 | 0.24 | 0.17 |
| bi | 27 | 81.5 | 74.1 | -7.4 | 0.84 | 0.36 |
| passnyc | 30 | 36.7 | 40.0 | +3.3 | 1.10 | 0.84 |
| water-pot | 36 | 36.1 | 38.9 | +2.8 | 0.96 | 1.43 |
| rankings | 21 | 14.3 | 38.1 | +23.8 | 0.49 | 0.35 |
| nycrest | 32 | 25.0 | 18.8 | -6.2 | 1.90 | 0.86 |
| nfl | 42 | 14.3 | 14.6 | +0.3 | 7.17 | 3.99 |
| uber | 36 | 14.3 | 5.8 | -8.5 | 11.67 | 3.64 |
| energy | 36 | 11.1 | 9.3 | -1.8 | 4.69 | 1.29 |
| netflix | 34 | 8.8 | 5.9 | -2.9 | 3.71 | 2.49 |

### What the traces say

**The variance is one number, not many.** rankings swings 14.3 / 85.7 / 14.3
across three identical configs — a 71-point spread that is entirely one
derivation at turn 4. r1 computed the covariance matrix as `df[cols].cov()` on
complete rows (Mahalanobis 278.6702, matching gold); r2 used pairwise
`pair[a].cov(pair[b])` on per-pair dropna (281.8271); the baseline did the same
(281.8274). Turn 5 removes outliers by that distance: r1 keeps 721 universities
(gold 721), r2 keeps 718, the baseline keeps 8. From there r1 scores 1 on 15 of
the next 17 turns and the others score 0 on nearly all of them. **One estimator
choice at turn 4 decided 18 turns.** Same shape on uber: the arms disagree from
turn 7 on a compactness share (0.815 vs 0.889) and never reconverge.

This is the identical mechanism as passnyc t12, now observed twice more, and it
is the reason per-task deltas of +-20 points in this benchmark carry almost no
information at n=1. It is also why the summary line here is a tie rather than a
win or a loss: at n=3 the arm difference is smaller than the derivation lottery.

**t12 became deterministic.** All four runs this era answered 462 (gold 472) —
including the baseline, which never trapped in the previous era. The v9 table
("control 0/3, versioned 3/3", Fisher ~0.05) was therefore **era-confounded**;
that inference is retracted. Whatever selects the 462 path is a property of the
era (engine + service + model snapshot), not of the render.

**The rich channel does help where value evidence is what's missing.** By state
pattern, rich vs baseline: Counterfactual +7.1 (9.0 -> 16.0), unlabelled turns
+18.8 (34.8 -> 53.6), Initial ~flat (35.0 -> 35.0), Update -5.4, Rollback -4.3.
Counterfactual turns are exactly the ones that reason about alternative values
of an existing table, so a value channel plausibly helps there; Update and
Rollback are the version-selection patterns, where the extra per-column detail
buys nothing and the longer observations may crowd the decision.

**Two anomaly classes, both benign, both logged.**
*Reasoning-only empty answers* (7 across 1236 turns, both arms, mostly
water-potability): the model spends output tokens on reasoning and emits no
visible text; the turn scores 0. *Silent rework loops* (nfl r2 t28, r3 t26):
one operator modified 35-38 times with **zero tool errors** — each write
succeeds, the result dissatisfies, the model retries until the 40-step budget
ends the turn. Both NFL cases are "reopen the earlier pool" rollback turns.
The teaching-error contract is not implicated (no rejections involved). The
general lever, if this recurs: a per-turn same-operator modify budget, which
would convert a silent loop into a decision the model has to make explicitly.

### Where this leaves the thesis

The render is done arguing. Three campaigns (telemetry, stats, versioned+rich)
have now moved cost substantially and accuracy not at all, and every per-task
swing traced to a single early derivation choosing between two defensible
formulas. **The bottleneck is not what the model can see; it is that nothing
checks a foundational quantity at the moment it is created.** Verification at
state creation (dual derivation of quantities that many turns depend on, with
disagreement surfaced as a decision) is the only remaining lever aimed at that,
and this campaign is the strongest evidence yet that it is the right one.
