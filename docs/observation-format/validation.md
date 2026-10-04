<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Observation format: fixes and validation (2026-10-03)

This round fixes the defects listed in [review-2026-10-03.md](review-2026-10-03.md)
and those found by generating receipts from the live engine, restructures the
system prompt as agreed (see [system-prompt.md](system-prompt.md)), and tests
the result with GPT Luna across the settings that change what the model sees.
The first implementation's validation is superseded by this document.

## What changed

**Blockers from the review.** Every prompt configuration now builds whole: a
test assembles 400 combinations of context mode, retrieval views, flow
statistics, multi-task features, table format, record layout and checks, and
checks that every code fence closes, no template marker remains, every example
call validates, and every example receipt carries exactly the enabled
statistics and table syntax. Execute no longer fails when flow statistics are
on and `sample` is not an offered view. Complete tables keep their order, and
partial ones mark omitted rows with `…`.

**Receipts.** Integer statistics are exact. Tasks are numbered the same way in
every receipt, after any loaded tasks. The multi-task part of the prompt is
fixed when the session starts. Loading state after the first request is
refused. Live receipts exposed further defects, all fixed:

| defect | now |
|---|---|
| semi and anti joins described as inner joins (`62 left rows found no match`) and their flow counters rejected | `semi join kept 8 of 19 left rows, those with a match among 3 right rows`; flow lines for both |
| an operator updated in this task showed `origin: loaded` | no origin until an answered task saves it; `loaded` only for unchanged loaded state |
| an updated or invalidated operator showed `result: not run` | `result: stale (execute to recompute)` |
| the catalog called invalidated tables `recomputed` | `stale` |
| a copy of a saved version showed `result: not run`, and retrieving it listed the original's inputs | `result: 8 rows × 2 columns (saved by task 3)`, its own inputs, and flow lines named after the copies |
| an in-place restore counted as two changes | one |
| the versions list showed an "update" for a cache hit, and could not show a restore | ranges (`1-2`), `updated`, `inputs changed`, `recomputed`, `restored from task N` |
| retrieving the consumer of a failed operator said `RESULT_FAILED` | `RESULT_NOT_RUN: … did not run because upstream … failed` |
| `at:` lines printed JSON-escaped code | `at: apply line 2: \`return …\`` |
| a rejected edit said twice that nothing was applied | once |
| the graph index printed `1 row × 3` | `1 × 3` |
| all rows shown with requested columns were captioned as a sample | `(all rows; columns requested)` |
| a preview caption repeated itself; an empty denominator printed `(undefined)` | `(complete; source preview only)`; `0/0 (no rows)` |

**System prompt.** Reordered into the agreed three parts, keeping the earlier
wording where it was right and correcting what did not match the renderer.
Every example receipt was produced by the live engine. Details and sizes are
in [system-prompt.md](system-prompt.md).

## Checks

| check | result |
|---|---|
| agent-service Bun suite | 1,294 passed, 0 failed |
| TypeScript typecheck | passed |
| Python runtime and LongDS tests | 272 passed |
| LongDS transport tests (KramaBench environment) | 5 passed |
| generated references in `native-mode/` | in sync |
| prompt settings matrix | 400 combinations pass |

New tests cover semi and anti notes, loaded-state numbering and origin, the
prompt staying the same at the second request, refused late seeding, version
labels, restore counts, index shapes, the single "nothing applied" line and
consumers of failed operators.

## Luna runs

All runs use `gpt-5.6-luna`, native mode, DELTA context, on this worktree's
engine. Settings are saved beside each run.

### Single task (KramaBench, 8 tasks in 6 domains)

| variant | settings | score | cost | calls |
|---|---|---|---|---|
| Default | `sample_stats`, `full` | 5.38 / 8 | $0.032 | 40 |
| DefaultFlow | + flow statistics | 7 / 8 | $0.021 | 31 |
| NoStats | `sample`, `full` | 7 / 8 | $0.018 | 31 |
| AllTsv | all views, flow, TSV tables | 7 / 8 | $0.022 | 31 |
| KvChecks | `keyValueColumns: 0`, checks | 7 / 8 | $0.024 | 36 |

`biomedical-easy-2` fails in every variant (68.1 against 68.5). Default's two
extra misses are slips in reading forecast files and choosing years; no error
in any run traces back to a receipt or the prompt. 86–91% of input tokens were
read from the prompt cache.

### Several tasks (LongDS)

GitHub languages task 1 (15 turns) and NYC restaurants task 2 (first 12
turns), judged by the paper's judge (`deepseek-v4-pro`).

| variant | settings | GitHub | restaurants | cost |
|---|---|---|---|---|
| Plain | multi-task only | 15 / 15 | 3 / 12 | $0.088 |
| History | + historical state | 15 / 15 | 4 / 12 | $0.094 |
| Ledger | + historical state, task catalog | 15 / 15 | 9 / 12 | $0.102 |
| AllTsv | all views, flow, catalog records, TSV tables | 15 / 15 | 2 / 12 | $0.100 |

The restaurants session cascades: Plain and AllTsv both built a 19-unit
decision pool at turn 3 where the reference has 30, and every later turn
inherits it. With one run per variant, and AllTsv also using the catalog, the
spread is not evidence for or against any setting. 95–96% of input tokens were
read from the cache. No variant used `inspect state`, the versions list or
the rollback command (since replaced; see below), including on the turns
LongDS labels Rollback.

### Confirmation on the final code

The runs above used the code before the last few fixes (the execute-block
sentence in the prompt, the example receipts without flow, the `all rows`
caption and the `(no rows)` marker). The services were restarted on the final
code and a confirmation set was run:

| run | result | cost |
|---|---|---|
| KramaBench, default settings | 7 / 8 | $0.022 |
| KramaBench, with flow statistics | 7 / 8 | $0.028 |
| LongDS GitHub task 1, historical state and catalog | 14 / 15 | $0.045 |
| LongDS restaurants task 2, historical state and catalog | 2 / 12 (turn-3 pool error again) | $0.066 |
| gold-prefix restaurants turns 2–5 from loaded state, baseline / history / ledger | 4 / 4 each | $0.030–0.032 per arm |

The restaurants rerun under the same settings as the earlier 9 / 12 failed
from turn 3, which confirms that the spread between variants was run-to-run
variation. The gold-prefix turns load the reference state before the first
request; their receipts mark loaded tables `origin: loaded` and number the
catalog entry `#### Task 2`. No receipt in any run contained a renderer
artifact (`undefined`, `NaN`, `[object Object]`, an unclosed fence or a
template marker).

## Environment problems found

- **Codex's validation ran on another checkout's engine.** The KramaBench
  harness takes the first computing unit and defaults to the main stack's web
  server, so its runs used the `dataflow-actions` engine and database. The
  smoke arm now takes `OBS_CUID`, and the matrix scripts point the harness at
  this stack.
- **This worktree had no `amber/data` link.** The engine's Python worker runs
  in `amber/`, so every relative data path failed with `SCAN_NOT_FOUND`, and
  Luna searched `/home/bob/**` until it found the file by absolute path. The
  link is added (it is gitignored, like the other checkouts').
- **The local judge gateway rejects the default key,** and `judge_longds.py`
  then reports `judged 0/27 turns` with exit status 0.
- The KramaBench submodule pointer still differs from the pinned commit,
  which is unavailable; it is left unstaged.

## Reproduce

```bash
cd agent-service && bun test && bun run typecheck && bun run render:native-reference
# Luna matrices (stack profile, computing unit bound to this engine):
logs/obsfmt/kb-matrix.sh http://localhost:3037 Default NoStats KvChecks
logs/obsfmt/longds-matrix.sh http://localhost:3037 15 community__github_programming_languages_data__task1 Plain History
JUDGE_BASE_URL=https://openrouter.ai/api/v1 JUDGE_API_KEY=$OPENROUTER_API_KEY \
  benchmark/Kramabench/.venv/bin/python benchmark/longds/judge_longds.py \
  --sut LongDS_LongDSObservationFormatLunaLedger --judge-model deepseek/deepseek-v4-pro
```

## Follow-up changes (2026-10-03)

- **`values` removed.** Across 338 traces the model used it in 4 tasks, 3 of
  them to type in numbers it had read from raw file lines instead of parsing
  them; the problem it was built for, retyping an earlier selection, never
  occurred, and reuse went through semi and anti joins. Constants the request
  supplies stay in the definition that uses them. The gold-prefix protocol now
  seeds the reference solutions' kept lists as one-column parquet scans
  (`prefix/collections/`); the five sessions' prefixes were rebuilt (the
  previous ones are kept as `prefix.values-20261003`).
- **Every listed data path resolves.** Five KramaBench tasks listed files that
  do not exist in the data lake: four astronomy tasks name files wrongly
  (`omni2.txt` for `omni2.text`, a glob with too few `?`, STORM-AI windows with
  the wrong dates), corrected in `benchmark/kramabench_source_corrections.json`;
  `wildfire-hard-19`'s 1 GB file was missing from this checkout and is linked
  from the main one. The KramaBench arm, the LongDS runner and the gold-prefix
  runner now check before any model call that every listed path resolves, also
  from the engine's working directory; a KramaBench task that fails the check
  answers with a harness error instead of letting the agent search.
- Empty results are always reported (`note: empty table.`), and fractions are
  shown with 15 significant digits.

## Fork and restore (2026-10-03)

### What changed

`rollback` is gone. Two edit commands take its place:

- `update operator <id> from task <N>` puts back the definition task N saved,
  in place. Its inputs are today's; the note names any input that changed
  since task N.
- `fork operator <id> from task <N> as <new_id>` copies the saved version,
  with the inputs it had at task N, next to the current one under new names.
  The copy carries its saved result, so it can be retrieved without running.

A restore is an ordinary change. When its task is answered it is saved like
any other, so a session that goes back to task 3 at task 6 can still return to
task 6 later; a test replays this and checks that no version disappears.
Receipts and the versions list say `restored from task N` and
`forked from task N`.

The prompt's "Earlier tasks" passage now says to change an earlier operator in
place when a request revises a rule and nothing later needs the old result, to
fork when the old and new versions must be computed side by side, and to
restore when a request returns to an earlier rule for what follows. The
examples show an in-place update (task 3), a fork used for a comparison
(task 4) and a restore (task 5).

### Setup

One rep with Luna on the five LongDS sessions whose requests most often revise
a rule that nothing later needs in its old form (classes A and A′ of the state
study): Kaggle survey 2022 task 3 (first 37 turns), ACEA water task 3 (33),
NYC restaurants task 3 (30), Los Angeles jobs task 1 (33) and water potability
task 1 (31), 164 turns in all. The dataflow arm has historical state, the task
catalog and the ledger. DSGym ran the same day with our task text. Both are
judged by `deepseek-v4-pro`, and the earlier dataflow v4c run and two DSGym
runs are scored on the same turns. "From the first update" counts each
session's turns from its first in-place update on (128 turns).

### Results

| turns | dataflow, fork and restore | DSGym, same day | dataflow v4c (09-26) | DSGym (09-27) | DSGym, upstream prompt (09-26) |
|---|---|---|---|---|---|
| all (164) | 78 | 88 | 72 | 82 | 49 |
| from the first update (128) | 54 | 62 | 53 | 57 | 30 |
| updates that need no old version, A and A′ (30) | 10 | 10 | 6 | 14 | 7 |
| updates that keep both versions, B (16) | 6 | 5 | 7 | 6 | 3 |
| later turns that depend on an A or A′ update (46) | 9 | 19 | 9 | 16 | 8 |
| rollbacks after an A or A′ update (22) | 5 | 11 | 5 | 7 | 4 |
| cost | $1.09 | $0.55 | $0.87 | $0.60 | $0.48 |

Per session, dataflow against DSGym of the same day: Kaggle 29 and 28 of 37,
ACEA 32 and 33 of 33, restaurants 8 and 9 of 30, Los Angeles 3 and 8 of 33,
water 6 and 10 of 31.

**No accuracy gain.** The new arm is 10 turns behind DSGym. The two DSGym runs
differ from each other by 6 turns, so one rep cannot show that the dataflow
arm is worse, but it is not better. On the update turns themselves the arms
tie (10 and 10, 6 and 5); the gap is in the later turns that depend on an
update and in the rollbacks. Most of those 49 turns have at least one wrong
dependency in both arms (35 for dataflow, 36 for DSGym). DSGym still answered
12 of its 36 correctly, dataflow 4 of its 35; with every dependency right the
two are close (8 of 14 against 10 of 13).

The traces show both agents building on earlier state; DSGym re-read the raw
files on only 3 of the 49 turns. What differs is what happens after a wrong
answer. Of the dataflow arm's 35 turns with a wrong dependency:

| what the turn read | turns | right |
|---|---|---|
| a table made by a turn it had answered wrongly | 21 | 1 |
| only the base tables, rebuilding every rule since in a new `process` operator (19 to 114 lines of Python) | 10 | 1 |
| other earlier tables, from turns the request does not depend on | 4 | 2 |

DSGym read a variable from a turn it had answered wrongly on 19 of its 36 and
was still right on 6. In each of those the earlier mistake was in something
the next turn did not use: extra rows in the answer (restaurants turn 6 listed
nine carried-over rows where five were asked, while its order table with the
turn-6 cost rule and its restaurant counts were right, so turns 7 and 8 came
out right), one field's values (Los Angeles turns 7 and 19), rounding and a
sub-list (Los Angeles turn 14), or source IDs the judge rejected at water
turn 5 and accepted at turn 6. The rebuilds fail in their own way: on
restaurants turn 8 the dataflow arm did not read its turn-6 operators, rebuilt
the scoring from the turn-1 cleaned table, dropped the rule that a restaurant
needs at least ten orders, and listed four rows where the reference has two;
DSGym reused its `restaurant_counts` and listed the two.

Of the 10 such turns that only DSGym answered correctly, 2 are judge
inconsistencies. On water turn 6 both arms name the same five sources, off by
one from the reference IDs, with the same counts; the judge accepts
`source_row_position 81` and rejects `SRC00081`. On water turn 28 both answer
yes; the judge reads the question as yes or no for DSGym, whose severity values
match none of the reference's, and as a list for the dataflow arm, whose first
three values match exactly. One is an own slip with every dependency right
(ACEA turn 23, Auser's wettest year), and the other 7 depend on a turn the
dataflow arm had answered wrongly (DSGym had a wrong dependency on 6 of them as
well).

**The new commands were not used.** On the 30 in-place update turns the model
changed an earlier operator in place 5 times (v4c: 2), never forked or
restored, and inspected a saved version on 3 other turns. On the three Kaggle
turns whose context says a rule changes "from this point on" (9, 17 and 31),
it built new operators next to the old ones (v4c did the same on turn 17 and
made no edit on turn 9). Each of those requests also asks how the result
changed against the previous definition, and so do most turns that allow an
in-place change; the model answers them by keeping both versions.

**Cost doubled, and output is not the reason.** At Luna's prices (fitted from
the five runs: $0.26 per million uncached input tokens, $0.018 cached, $1.30
output) the dataflow arm spends $0.54 on cached input, $0.38 on output and
$0.17 on uncached input; DSGym $0.19, $0.29 and $0.07. Output per call is about
the same (657 tokens against 593), and the arm makes 2.7 calls per turn against
2.3. The difference is the prompt each call carries: 71k tokens on average
against 29k, growing from 25k in the first five turns of a session to 122k in
the last five (DSGym: 6k to 51k). Against v4c the arm reads twice the input
(31.2M against 16.4M tokens) for 18% more output. Receipts average 6.8k
characters per turn (edit 39%, retrieve 28%, answer and catalog 19%), the
calls themselves 4.7k, and 55% of what the model writes is Python inside
`process` operators.

### Fixed during the run

- The Los Angeles session has 839 data files, and the first request listed
  every one. It now lists files one by one only up to 12, and otherwise the
  folders with their file counts and a note on how to list them. The session
  was rerun with the fix.
- The judge returned empty verdicts in the DSGym water session when its
  reasoning used up the token budget. It now exits with an error while any
  turn is unjudged; that session was judged again with a larger budget.

### Next

[findings-and-plan-2026-10-03.md](findings-and-plan-2026-10-03.md) records
what the traces show about the gap and the changes planned next.


## Reusable working-state iteration (2026-10-03)

This iteration keeps the existing ReAct loop, native action schema, historical
inspection/fork/restore implementation, DELTA assembly and prefix-cache layout.
It changes the common verification guidance and replaces the multi-task
examples with a continuous analysis that retains full working scores and
puts top-k answers downstream. There are no column commands or context cuts.
The original column-command plan is superseded in
[findings-and-plan-2026-10-03.md](findings-and-plan-2026-10-03.md#accepted-iteration-after-review).

### Functional verification

- `bun test --timeout 30000`: **1,297 passed, 0 failed**, including prompt
  capability/layout combinations, strict action validation, saved versions,
  frozen receipts and stable-prefix tests.
- `bun run typecheck`, formatting of changed tests and `git diff --check`:
  passed. Native prompt and tool references regenerated from the sources.
  The final focused prompt/reference run passed **88 tests** after regeneration.
- The new regression executes the actual multi-task example's graph commands
  and generated Python. It independently checks all eight unit scores,
  coverage counted on the 24-row source, a five-row report, propagation after
  a rule revision, a comparison against historical input versions, restoration,
  a two-row eligible population and an empty population.
- Live `observation-format-run.ts`: **10 checks passed** against the real
  engine. It runs the prompt's programs, verifies that inspection and forked
  result retrieval create no backend execution, then changes the source and
  restores the old rule. The current score becomes 144 while the historical
  fork stays 44, proving that the two input semantics remain distinct.
  All views/layouts, typed values, partial records, atomic invalid settings,
  failed execution and skipped actions are also checked. Test resources were
  deleted after terminal execution states were verified.

The live runner had stale assertions for the previous prompt/catalog/rollback
format, and encoded debug input as JSON instead of the debug endpoint's Python
literal format. It now uses the existing `nativeDebugInput` encoder and checks
only new trace steps, so a parse failure cannot masquerade as the previous
successful tool result. This is a test-harness correction; it does not change
the agent's production tool parser.

Live artifacts: `/tmp/observation-format-live-jIXQln/` (`summary.json`, receipts,
`react-steps.json`, system prompt and `cleanup.json`).

### Luna benchmark pilot

KramaBench `legal-easy-3`: **100%**, one task-metric, $0.004622. Multi-task
history is disabled in this smoke. Artifacts are under
`benchmark/Kramabench/system_scratch/DataflowObservationFormatLunaReuseStatePilot/`.

The multi-task pilot runs **only turns 1–8** of each of the two selected
LongDS sessions, one Luna repetition. It uses the prior ForkLedger arm's
settings: native DELTA, `sample_stats`/`full`, flow evidence off, history and
ledger on, 2k sample and 5k full budgets, no context reduction. A fresh service
on :3039 serves this checkout. The actual prompt was checked and saved as
`system_prompt.txt` with `prompt_sha256.txt` in each run directory. Correctness
uses the pinned LongDS judge prompt and `deepseek/deepseek-v4-pro` via
OpenRouter, with an 8k reply cap. Baseline numbers below are the corresponding
first eight turns of the existing ForkLedger run, not its full-session totals.

| First eight turns | Before | Revised prompt | Before cost | Revised cost |
|---|---:|---:|---:|---:|
| NYC restaurants task 3 | 3/8 | 4/8 | $0.04447 | $0.03647 |
| Los Angeles jobs task 1 | 2/8 | 3/8 | $0.05250 | $0.05631 |
| Combined | 5/16 | 7/16 | $0.09697 | $0.09278 |

**Observed restaurant mechanism.** Turn 6 retains `cuisine_strict`, the full
current eligible pressure table. Turn 8 connects that table to cuisine
volumes measured on the cleaned source, filters low-volume cuisines, and puts
ranking/limit downstream. It returns exactly R012 and R073 and explicitly
preserves coverage despite the request for five. The earlier run dropped
coverage and returned four rows. Across these eight turns, edit text fell
from 33,761 to 18,997 characters and model calls from 27 to 19. No `.head()`
occurs in the submitted custom functions, compared with 17 occurrences before.
These are literal trace counts, not a semantic classifier. The trace also
contains more operator-create commands (41 versus 14), so the shorter code
is not proof of lower cost on a long session.

**Remaining failures.** Restaurant turn 6 still partitions the current top-ten
answer instead of the full eligible pool, so it supplies only one newly
surfaced row where five are required. Turn 3 chooses a wrong comparison cutoff,
turn 5 omits requested component fields, and turn 7 uses the wrong comparison
population. Los Angeles still has class-code audit and score/calculation
errors and largely retains its custom-script pattern. Its code volume and
cost did not improve materially. Neither free-running pilot uses fork or
restore; the live suite verifies those operations mechanically, not that the
model reliably chooses them.

This is a small mechanism probe with a prior-run baseline, not a same-time,
multiple-repetition accuracy claim. It supports retaining the smaller design
and investigating population selection and reusable calculations further;
it does not establish that multi-task analysis is solved. Context reduction
has not been mixed into this experiment.

Run artifacts:
`benchmark/longds/system_scratch/LongDS_LongDSObservationFormatLunaReuseStatePilot/`
with per-turn prompts, traces, workflows, statistics, answers and judged results.
Logs: `logs/obsfmt/reuse-state/`. Two preliminary runs were stopped and excluded
when prompt inspection showed that the old services had not loaded the revision;
their partial artifacts are under
`_LongDS_LongDSObservationFormatLunaReuseStatePilotPreReload/`. An initial judge
request used a model name absent from the local proxy and produced no scores;
the completed evaluation uses OpenRouter.

## Matched comparison campaign (2026-10-03)

Artifact root: `/var/tmp/dataflow-state-comparison-20261003`.
The fresh service on port 3040 runs this checkout. The comparison harness
freezes source copies and hashes, user messages, input-data fingerprints,
settings and independent repetitions. All arms share Luna, the same gateway,
40 calls per turn and an 8k output cap. The native baseline and history arms
differ only in `stateHistory`; ledger, flow evidence and context compaction
are off. A judge cache shares verdicts only for identical question/context,
reference and submitted-answer triples under the pinned judge prompt.

### Completed retrieval ablation

Two predeclared first-eight-turn prefixes (restaurants and Los Angeles),
three independent repetitions each. Profiling collection and row budgets
are identical; only available retrieval views differ. Each policy has 48
expected, observed and judged turns, with no solver retries or missing usage.

| Policy | Correct | Estimated model cost | Model calls |
|---|---:|---:|---:|
| `sample` / `full` | 17/48 | $0.358600 | 163 |
| `sample_stats` / `full` | 18/48 | $0.302147 | 143 |

The statistics policy costs 15.7% less in this development probe. The
one-answer difference does not establish an accuracy gain. Statistics
were actually displayed in 11 retrievals; most result requests used `full`.
Keep statistics available for the larger comparison, with separate budgets
so facts do not displace samples. No claim about flow statistics follows
from this ablation.

### Completed version-history diagnostic

One synthetic eight-turn session, three repetitions per arm, 72 judged
turns in total. Unlike a flattened gold-prefix setup, this session builds
real historical operator definitions and result versions through ordinary
requests. It distinguishes original rules on original inputs, restored
rules on updated inputs, and a temporary scenario that leaves the default
analysis intact.

| Arm | Correct | Estimated model cost | Model calls |
|---|---:|---:|---:|
| Native baseline | 24/24 | $0.036207 | 58 |
| Native history | 24/24 | $0.031845 | 54 |
| DSGym | 19/24 | $0.028143 | 49 |

The history agent successfully forks task-1 `scores` in all three
repetitions at task 3. Its edit text totals 7,071 characters versus 13,730
for the baseline. Within-task prefixes remain stable on 64 checked
transitions; prefixes across tasks remain stable on 42 checked transitions.
All three repetitions also restore the earlier eligibility definition with
`update operator eligible from task 1`. The audit recognizes that spelling
as restoration; counting only a literal `restore operator` command missed it.
This shows actual fork/restoration use and about 12% lower native cost, with equal native accuracy on one
small case. It does not establish a general history-tool accuracy benefit.

The five DSGym misses occur in early turns answered without trying code,
despite a working kernel. They are protocol/behavior failures, not evidence
that historical state retrieval outperforms scripts. On the 19 questions
both arms answer correctly, DSGym remains cheaper than native history.
Uniform fresh-input accounting gives DSGym $0.027443 instead of $0.028143;
the difference is the reported cache-write premium. All figures use the
new campaign's frozen fallback rates, not provider invoices or the earlier
pilot's accounting table.

### Larger comparison

Twelve new sessions were selected from metadata before inspecting their
solver outcomes: two per domain, including a low-change control. All 398
published reference answers reproduce in the shared Python environment
(Python 3.12, pandas 2.2.3, NumPy 2.1.0). Reference preflight uncovered
missing notebook setup cells and helper imports in the gate; regression
tests now cover those cases, original publishing precision and missing
exports. Reference code never enters a solver prompt or raw-data mount.

The frozen `holdout/manifest.json` contains **108 independent jobs / 3,582
solver turns**: twelve full sessions, three repetitions, three arms. The
queue is running. Active solver attempts were preserved when the controller
was replaced to increase bounded concurrency to six native and four script
jobs; this scheduling change does not alter the frozen solver protocol or
retry any session. `progress-before-concurrency-change.json` and controller
records retain the change. Final accuracy is withheld until the full
denominator is available. `comparison_report.py` produces state/dependency
breakdowns, paired costs, whole-session uncertainty and successful history
action counts. Bounded-context and ledger phases remain separately labeled.

Verification so far: Python harness regression tests, full existing LongDS
test suite under the benchmark environment, native runner typecheck, actual
retrieval/diagnostic executions and per-session effective-setting checks.
The production ReAct loop and history primitives remain unchanged in this
comparison iteration.

### Completed diagnostic beyond displayed previews

A second independent synthetic case has 6,000 working rows and three
repetitions per arm, with the same settings as the first diagnostic. Its
first two answers report only five leading units; task 3 asks for six
unreported units, followed by source/rule revisions and a temporary scenario.
All 72 expected turns are observed and judged.

| Arm | Correct | Estimated model cost | Model calls |
|---|---:|---:|---:|
| Native baseline | 24/24 | $0.037453 | 55 |
| Native history | 24/24 | $0.041547 | 57 |
| DSGym | 10/24 | $0.023219 | 46 |

Every history repetition uses fork and definition restoration. In repetition
3, the initial score view shows 304 of 6,000 rows; the historical graph then
produces all 6,000 rows and the requested comparison returns six correct rows
outside that preview. The first execution of the copied historical operators
is recorded as `executed`, not `cached`: this verifies recomputation using
the historical definitions and original input file, not reuse of a full
historical materialization. Later reads/executions use that branch's cache.
Both original and updated input files remain available in this diagnostic.

History costs 10.9% more here. Across the two diagnostics its total model
cost is almost equal to baseline, with equal accuracy; the earlier 12%
saving is not a consistent cost advantage. Most DSGym misses again answer
without a code attempt, so that accuracy gap cannot establish a historical
state advantage. The case does establish that small displayed samples do
not force the forked graph to operate on those samples.

Artifacts: `hidden-history/`, including its separate frozen protocol,
per-turn compressed traces, workflow captures, judgments, report and
`manual-audit.json`. Main LongDS scores remain separate from synthetic checks.

### Cost sensitivity excluding early nonanswers

The solver in every comparison arm is `gpt-5.6-luna`; DeepSeek-v4-pro judges
the answers. The observed access-error responses are solver behavior through
the DSGym interface, not DeepSeek giving up on solving.

`comparison_cost.py` adds matched cost cuts without changing solver attempts,
judgments, official denominators or overall spending. Its conservative
nonanswer category requires score 0, no Python block or execution observation,
and an explicit JSON error or empty answer. Correct answers that reuse earlier
state without new code remain successes. Missing traces remain unknown, and
"No python code found" protocol feedback is not an execution observation.

All five DSGym misses in the small diagnostic and all fourteen in the
6,000-row diagnostic fall into that explicit nonanswer category. Excluding
the same questions from both arms gives:

| Diagnostic | Questions both correct | DSGym model cost | Native history model cost |
|---|---:|---:|---:|
| Eight working rows | 19 | $0.022707 | $0.024577 |
| 6,000 working rows | 10 | $0.011314 | $0.016938 |

These use uniform fresh-input accounting. DSGym remains cheaper on those
selected correct answers, so early nonanswers do not explain the entire cost
gap. This conditional comparison still admits cheaper later context following
earlier skipped work. The report therefore also includes consecutive jointly
correct prefixes from turn 1; only eight turns qualify in the small diagnostic
and none in the larger diagnostic. On the eight qualifying turns, DSGym costs
$0.008768 versus native history $0.012049. The sample is too small for a general
efficiency claim.

Cost per correct answer also retains all failed-attempt spending. Across the
two diagnostics it is approximately $0.001730 for DSGym (29 correct) and
$0.001529 for native history (48 correct). This is a descriptive quality/cost
ratio, not the cost of retrying until success. It is withheld for any selected
group with unjudged answers or unknown costs.

Artifacts: `controlled/cost-analysis.json`, `hidden-history/cost-analysis.json`
and `holdout/cost-analysis.json`. This read-only analysis does not alter the
running frozen comparison protocol.

### Further verification and isolated compatibility candidate

The ongoing comparison is unchanged. A read-only audit of 55 completed jobs
finds action errors in 77 of 366 completed history turns and 87 of 419 baseline
turns. These counts include errors successfully repaired within a turn; they
are not counts of final failures. Examples include missing input edges, rejected
atomic edits, failed callbacks, and retrieval after an unsuccessful execution.
Artifacts: `holdout/action-error-audit.json` and `holdout/wire-context-audit.json`.

Six fully completed session/repetition groups shared by all three arms show
substantial context growth. Native history averages 23,837 provider input tokens
per call in the first five turns and 102,820 in the last five; DSGym averages
11,411 and 59,874. Native baseline reaches 101,884 in the last five. These
mechanical measurements include incorrect/nonanswer calls. No cost or accuracy
claim is inferred from this subset. Full wire requests show that the native
system/tool overhead must be included in any future matched context budget.

Two goodbooks execution receipts reproduce a specific compatibility issue:
pandas 2.2.3 raises `KeyError: dtype('float64')` when pivot/unstack fills a
complete nullable-integer rating array with `0.0`. Ordinary NumPy integer
columns run the same calculation successfully. A separate worktree at
`/var/tmp/dataflow-native-integer-compat-20261003` adds a precision-preserving
process-input conversion for complete `Int64` columns. Nullable integers with
missing values remain nullable; no integer column is converted through floats.

Regression evidence:

- Before the correction: four failures and two passes across six new checks.
- After: all six pass, including generated process code fed through the engine's
  actual Arrow/table adapter, pivot/unstack, empty/all-null tables, signed int64
  bounds, identifiers above 2**53, unchanged input frames, and float/bool/string/
  UTC timestamp behavior.
- The broader generated-runtime, input-contract, transport, evidence, profile,
  result-version and diagnostic suites pass: **108 tests**, plus typechecking.
- The current checkout's history, ledger, evidence compaction and native frame
  suites pass: **48 tests**. Frozen primary solver source hashes still match.

A further corner-case check defines the correction's boundary. A nullable
integer column containing a missing value retains its mask at process entry.
Dropping that row inside the callback keeps pandas' `Int64` dtype, so a later
`pivot_table(..., fill_value=0.0)` can still raise the same pandas 2.2.3 error.
An explicit integer cast after removing missing values succeeds without a
floating-point conversion. The candidate fixes complete integer inputs at the
boundary; it does not rewrite dtype choices later inside user code. The
reproduction is `integer-compatibility-limits.json` under the campaign root.

The fresh candidate worktree required its generated Python protos before the
transport suite could run; those were generated locally and remain ignored.
Logs are `integer-compat-before.log`, `integer-compat-after.log` and
`integer-compat-regression.log` under the campaign root. This candidate has not
been applied to the ongoing campaign. The live JVM verification below now
confirms it. It addresses a reproduced callback failure, not the overall
benchmark accuracy gap. Next interventions and their controls are recorded in
[findings and plan](findings-and-plan-2026-10-03.md#next-verification-iteration).

### Verified next-iteration candidate

The isolated candidate reproduces the original nullable-integer failure through
the live engine, then passes five checks with the correction: pivot, unstack,
exact large/signed integer values, missing masks and an empty result. The engine
fixtures make no model calls and clean up their owned resources after checking
terminal execution state. Artifacts: `integer-live-before/`,
`integer-live-after-attempt2/`, and `integer-compatibility.json` under the primary
campaign root.

The candidate also adds an experimental, disabled-by-default full-input budget.
It preserves existing frames while they fit, subtracts fixed system/tool
overhead before using the existing DELTA compactor, and remeasures the complete
serialized input. A transport guard independently refuses an oversized
estimated request before sending it. It never clips a tool-call/result pair.
A separate call guard includes protocol corrections and summary requests in
the 40-call allowance. The input limit excludes the separate 8,192-token reply
cap. These are estimates, not the provider's exact tokenizer.

The common estimate counts compact JSON for messages and tools in UTF-16 units,
divided by 3.3. A fixed pooled scale of **0.9191098451130497** comes from 270
completed development requests plus a 5% margin over their largest actual-to-
estimated ratio. Calibration does not use answer scores. Native and script
interfaces use that same estimate and frozen scale; actual provider input usage,
unknown calls and budget violations are reported separately. Controller
preflight rejects environment-policy drift; the native driver also verifies
the remote service policy before paid turns.

Verification: the full candidate agent-service suite passed **1,312 tests**;
the additional SDK serialization regression and focused budget suite pass
**10 tests**, with typechecking. Script budget tests exercise summaries,
system/tool overhead and the call allowance without provider access. Protocol
tests check identical source/data/prompt hashes across conditions, inclusion
of the Python runtime, preservation of failed reference preflights and refusal
to overwrite a frozen phase.

### Completed forced-compaction rehearsal

Artifact root: `/var/tmp/dataflow-context-comparison-20261003/budget-smoke`.
One separate synthetic eight-turn session per arm, with an 18,000-token nominal
full-input limit, exercises compaction before starting the larger experiment.

| Arm | Correct | Estimated model cost | Model calls |
|---|---:|---:|---:|
| Native baseline | 8/8 | $0.014132 | 18 |
| Native history | 8/8 | $0.012950 | 16 |
| DSGym | 7/8 | $0.007984 | 16 |

All 50 provider requests have usage records. There are no estimated or actual
18k input-budget violations; the largest actual input is 14,328 tokens and the
largest estimate is 17,987. This small rehearsal establishes functional
operation, not a general accuracy advantage. The script conversation never
reaches the limit; its over-budget summary path is tested separately without
paid calls. Native compaction changes prefixes: cache hit rates are 85.7% and
85.9%, so reducing context is not cache-neutral. Detailed artifacts include
`report.json`, `budget-audit.json`, full wire bodies and frozen sources.

The four metadata-selected full sessions are now frozen in `control/` and
`bounded/`, three repetitions per arm and condition: **72 jobs / 2,502 solver
turns**. Both conditions use the same candidate source, data, prompts, model,
reply cap and call allowance. Native recorded `contextWindowTokens` remains 0;
the full-input service policy applies the 64k limit after overhead accounting.
The two conditions are running. Their final accuracy/cost comparison and the
separate ledger intervention are still pending. The primary 108-job campaign
continues on its original sources; it has not been modified by this experiment.

The reviewed source patch is retained at
`/var/tmp/dataflow-context-comparison-20261003/verified-candidate.patch`, with
hashes in `verified-candidate.json`. Before promotion, `git apply --check`
passed against this checkout. The patch was applied only after every frozen
primary solver job and judgment completed.

The supervisor checked frozen and supplemental sources, candidate/patch hashes
and unchanged primary file contents, then saved the completed report. The
promoted checkout passes formatting, **1,313 agent-service tests**, typechecking
and **89 benchmark tests**. All five live integer/process checks pass again on
the promoted service, with no model calls and owned-resource cleanup verified.
The initial unit run inherited the benchmark's zero-retry flag and failed two
default-retry tests; that log is preserved. Clearing benchmark-only flags for
the unit runner restores both tests and the entire suite without changing any
solver policy. Exact candidate contents were checked before this continuation,
allowing only the recorded formatting step.

Candidate experiment sources remain frozen. The verified continuation transfers
the context queues to three native workers each, adopting already-started
children without replaying them. Its state and per-file hashes are in
`promotion.json`; logs are `promotion-bun-test-default-env.log`,
`promotion-typecheck.log`, `promotion-benchmark-test.log` and `promotion-live.log`.
The full-input policy remains disabled by default.

The ledger intervention is now predeclared in `ledger/manifest.json`: all 12
bounded history controls are reused, including incorrect answers, and only
12 new ledger jobs / 417 solver turns are paid for. Control identity, settings
and complete judgments are checked before linking their original artifacts;
the report distinguishes comparison costs from additional spending. The
registered follow-up waits for both context conditions, verifies source hashes
and checks the bounded-input audit before launching the ledger queue. Its
status is recorded in `followup.json`. The ledger stage has not started yet.

The first completed native CDP session reached 237,010 actual input tokens in
the unbounded condition. The corresponding bounded session remained below
57,085 actual tokens, with no measured or estimated 64k violations. Its answers
were mostly incorrect in both conditions (3/39 and 1/39 respectively). This is
an interim functional check, not evidence of an accuracy improvement; all
predeclared repetitions and the matched baseline remain necessary.

The same completed CDP pair costs an estimated **$0.591755 unbounded versus
$1.188852 bounded**, with 158 versus 184 model calls. Prefix-cache loss after
compaction and extra calls explain why a smaller input limit does not imply a
lower billed-token estimate. This single-session result motivates measuring
both cache behavior and answer utility before adopting a default limit.

### Missing-judge recovery

The primary Uber history repetition 3 completes all 35 solver answers, but
one original judgment has no verdict after three 8k judge replies consumed
their allowances on reasoning. The recovery rule grants every missing verdict
one further call to the same judge/prompt at 16k, never revisits binary scores
and never replays a solver. The original `results_eval.json` and all failed
judge replies remain unchanged; a hash-bound `judge-recovery.json` sidecar
records the additional response. This answer recovers a score of 1. Its extra
judge call reports $0.001346 in provider usage and is excluded from solver cost.
All subsequent missing judgments use the same rule. Failed recoveries remain
unjudged and keep the final accuracy report incomplete.

The current benchmark suite passes **86 tests** after adding control identity,
ledger predeclaration, judge recovery, stopped-controller checks and atomic
receipt publication. Interrupted serialization cannot expose a partial judge
receipt, and an existing receipt cannot be replaced. Recovery implementation
versions are archived separately while keeping the judge, prompt, selection
rule and reply cap fixed.

### Completed delayed-history and external-source check

`history-retention-run.ts` drives 20 requests through the live engine without
model calls. It keeps a 75-row working population with a three-row preview,
changes multiple ancestors, then reads a row outside that preview after 8 and
16 later requests. Those reads and historical fork/retrieval create no engine
executions. Saved observations retain their original values after the original
source file is physically overwritten and deleted.

Executing the fork after overwrite uses the old definitions on the new external
bytes. A new fork's execution after deletion fails with `SCAN_NOT_FOUND`, while
the saved task-1 observation remains readable. Restoring task-1 rules computes
on the current updated input, and selected execution succeeds despite the
independent failed historical branch. All five checks pass, with resource
cleanup verified.

This makes the guarantee precise: historical **observations** are retained
within their result cap; historical **definitions** do not provide an immutable
backup of external files. This fixture fits within the retained cap and does
not prove that arbitrary rows of a larger historical result remain queryable
after its external inputs disappear. Artifacts:
`/var/tmp/dataflow-state-comparison-20261003/history-retention-live-final/`.
The analysis now counts executed/cached/failed/not-run operator visits from
both successful and failed execution receipts. These counts measure graph work,
not CPU time or a guarantee of computational savings.

### New historical actions in the ongoing full sessions

The earlier zero-use observation no longer describes all accumulated traces.
The later audit finds nine accepted historical inspections and three accepted
forks. In policing task 2, repetition 1, turn 3 forks the task-2 complete
`aligned_concerns` and displayed `corrected_concerns`, then forks the opening
display from task 1 for a three-screen comparison. Turn 5 explicitly reads the
earlier displays from tasks 1–4. This is a meaningful use of the existing tools
without an orchestration change or forced adoption quota.

The policing repetition 1 judgments are now available. Turn 5 correctly
combines support from four earlier screens; both matched controls answer that
turn incorrectly. Turn 3 recovers the correct common set but gives one rank as
11 instead of 12, so its final answer is incorrect despite valid forks. Two
goodbooks inspection turns and one march-madness inspection turn are also
incorrect. The completed audit has 19 accepted historical-action receipts: six
on correct turns, thirteen on incorrect turns and none awaiting judgment.
These comprise 17 inspections and two edit receipts containing three forks.
Multiple receipts on one turn are counted separately.

This is a concrete successful reuse example, not a causal or aggregate
accuracy advantage. The complete cohort and all repetitions remain necessary.
The per-event snapshot, including every action and matched control score, is
`holdout/native-history-use-audit.json`.

### Completed primary comparison

All **108 solver jobs / 3,582 turns** are complete: twelve full sessions, three
independent repetitions, 1,194 turns per arm. Every answer has a binary judgment
and known solver usage. The single missing original verdict is filled by the
documented judge-only recovery sidecar. The original controller retains its
`completed_with_failures` status because its original artifact check preceded
that recovery; no attempt or original judgment is overwritten. The final
resolved report is `holdout/report-final.json` under the primary campaign root.
The newly promoted runtime/budget code does not change these frozen results.

| Arm | Correct / 1,194 | Turn accuracy | Session-macro accuracy | Estimated solver cost |
|---|---:|---:|---:|---:|
| Native baseline | 268 | 22.45% | 23.95% | $10.943169 |
| Native history | 254 | 21.27% | 21.97% | $10.954626 |
| DSGym | 250 | 20.94% | 22.67% | $6.334359 |

These are the frozen fallback pricing estimates, excluding judging and engine
compute. Under one shared fresh-input pricing rule the DSGym cost is $6.185430;
native costs are unchanged. All paired whole-session/repetition bootstrap
intervals cross zero. Baseline-minus-history macro accuracy is +1.97 percentage
points with a 95% interval of [-5.07, +11.28]; DSGym-minus-history is +0.70 points
with [-10.86, +13.25]. This cohort does not establish an accuracy advantage for
history, and its aggregate model cost is essentially identical to baseline.

#### Does excluding early nonanswers close the cost gap?

The trace classifier finds 952 DSGym turns with code attempted, four correct
without code, 144 explicit no-code nonanswers and 94 wrong numeric answers
without code. These categories describe observed behavior, not model intent.
Primary outcomes retain every turn. Supplemental cuts match the same task,
repetition and question in both arms:

| Matched history / DSGym cut | Turns | History cost | DSGym cost under shared pricing |
|---|---:|---:|---:|
| All | 1,194 | $10.954626 | $6.185430 |
| Both correct | 122 | $0.626171 | $0.510092 |
| DSGym attempted code | 952 | $8.120715 | $5.620103 |
| Exclude explicit no-code nonanswers | 1,050 | $9.095401 | $5.838021 |

The gap remains after those exclusions. The both-correct consecutive-prefix cut
favors history ($0.041480 versus $0.052195), but contains only twelve turns.
These are conditional descriptive comparisons: skipped work can influence later
state and costs, and matching correct answers does not verify complete working
state. The report includes every cut and its denominator, rather than replacing
the primary result with a favorable subset.

The $4.769196 shared-price history-minus-DSGym difference decomposes into
$3.371377 additional cached-input cost, $0.495615 fresh-input cost and
$0.902204 output cost. Cached token volume accounts arithmetically for 70.7%
of that gap. Cache hit rates are already 98.35% for history and 98.13% for DSGym;
the relevant issue is also how much cached history is carried, not just whether
it gets a cache hit. This accounting motivates measuring payload size and
stable compaction together.

The completed history traces contain 17 accepted historical inspections,
three accepted forks and no restores. They also show 3,062 executed and 16,646
cached operator visits, versus 3,242 and 18,882 for baseline. These are visits,
not unique operators or CPU timings; 23 history and 29 baseline execution
receipts lack per-operator outcomes. The cross-screen policing example remains
a concrete success, while low adoption and foundational calculation errors
limit the aggregate effect. The next intervention remains the predeclared
context comparison and separate ledger stage; no orchestration rewrite is
justified by these results.

### Context comparison status: October 3, 2026, 9:25 p.m. Pacific

The fixed-runtime comparison has completed **60 of 72 jobs**: 30 unbounded
and 30 with the nominal 64k full-input budget. Both controllers and all six
active native jobs are alive and producing new answers. Every completed job
has complete artifacts. All frozen source checks pass (185 files per context
condition, 186 for the queued ledger comparison); the nine promoted production
files also match their verified hashes. The ledger stage has not started.

The bounded wire audit observes 3,401 requests, with usage available for
3,398 and three requests in flight. No estimate or recorded actual input
exceeds 64k. Maximum recorded actual input is 59,230 tokens; maximum estimate
is 63,967. This remains an interim audit: requests without completed usage
are not counted as successful budget compliance.

The following comparison includes only complete task/repetition sessions
available in **both conditions within each arm**. Completion determines
inclusion, not answer quality. All included turns have binary judgments and
known costs. The arms have different completed cohorts, so rows in this table
are suitable for comparing input policies within an arm, not ranking agents.

| Arm | Matched sessions / turns | Unbounded correct | 64k correct | Unbounded solver cost | 64k solver cost | Unbounded / 64k cache hits |
|---|---:|---:|---:|---:|---:|---:|
| Native baseline | 8 / 269 | 28 | 52 | $2.634116 | $5.441744 | 98.44% / 44.35% |
| Native history | 10 / 348 | 69 | 49 | $3.861454 | $7.822109 | 98.53% / 45.94% |
| DSGym | 12 / 417 | 72 | 68 | $2.497889 | $2.268324 | 98.04% / 85.47% |

Costs use the shared fresh-input pricing rule and exclude judging and engine
compute. The native input limit is effective, but smaller requests have not
translated into lower cost: completed matched native costs roughly double,
alongside a sharp decline in cache hits. Native baseline makes 855 versus 836
calls and history 1,158 versus 1,195, so additional calls alone cannot explain
the cost increase. Accuracy moves in different directions for the two native
arms. This evidence does not justify making the 64k policy the default or
claiming a general accuracy benefit. The remaining sessions and whole-session
uncertainty analysis are still required; preserving reusable prompt prefixes
through compaction merits a separate experiment after the frozen comparisons.

The report and progress snapshots, matched-session identities, source checks
and audit summary are preserved at
`/var/tmp/dataflow-context-comparison-20261003/status-audits/20261004T042540Z/`.

The subsequent [existing-results audit](existing-results-audit-2026-10-03.md)
separates solver latency from provider timing, accounts for the accuracy
difference by observed script behavior, and documents judge semantics and
causal-error annotation coverage. It makes no solver or judge calls. The
automatic ledger launch is now held for user review while the current context
campaigns continue.

### Ordinary ReAct observations and general repair guidance: October 4, 2026

The approved change adds bounded `scope` facts to ordinary operator blocks.
Filters, limits, distinct selections and scan previews are described from the
observation's graph; row counts use completed results and, when available,
their producing input-version bindings. A stored table being displayed
completely does not establish that its rows satisfy the current request.
Smaller and empty eligible sets are reported without suggesting that the
model relax the requested conditions.

Historical inspection uses the saved graph and results. Unexecuted forks
use that same saved version while naming the copies the model can inspect.
Earlier observations remain unchanged. Opaque Python `process` operators
mark internal row selection as unknown and stop ancestry inference. Missing,
failed, stale or unbound measurements remain unknown. Each scope payload
contains at most three facts plus an omission notice, uses at most 600
characters, and visits at most 32 operators. Execute receipts report local
facts once; operator inspection and retrieval can show input ancestry.

This uses the existing graph, result storage and dependency invalidation;
there is no additional execution, model call, tool, semantic validator or
model-generated summary. The ledger is unnecessary and remains disabled in
the ordinary ReAct tests. Data and flow statistics retain their existing
settings and budgets. The separate check interface is deferred.

The common prompt explains scope and successful computations with incorrect
inputs. Multi-task guidance distinguishes reusable calculations from answer
selections. A synthetic example reconnects an aggregate from a top-five report
to all covered units, preserving the coverage rule and the earlier report.
It also explains when keeping the top-five input would be correct. The example
uses the existing toy fixture, with no benchmark tasks or solutions embedded.
The default single-task prompt stays below its existing 28,500-character cap.

Verification:

- Full agent-service suite: **1,323 passed, 0 failed**, including generated
  reference consistency and execution of the synthetic prompt examples.
- Additional assertions passed across DELTA/LATEST and native/opSplit/opBlock
  context layouts, with ledger and statistics disabled; the focused rerun had
  **62 passed, 0 failed**. Budget tests include long names and cyclic ancestry.
- Type checking and formatting passed; rendered native references are current.
- The live engine suite passed **12 checks**, including every retrieval view
  and layout, exact large integers, two-row and empty qualifying sets, errors,
  saved inspection, forks and restoration. With ledger and statistics disabled,
  it repaired the toy report-based mean from **78** to the all-covered-unit mean
  **64.5**, retained old receipts and verified that reads did not execute.

Live receipts, prompt, traces and summary are in
`/tmp/observation-format-live-GN0YxT/`. Cleanup confirms removal of the test
agent, workflow and computing unit. The isolated service used for these checks
was stopped. This implementation checkpoint included no paid solver or judge
experiment; these checks establish representation and execution correctness,
not an accuracy improvement. The model-driven pilot below followed this
checkpoint. Existing frozen comparisons and the held ledger study were not
changed.

### Frozen ordinary-ReAct scope pilot: October 4, 2026

The model-driven verification compares the previous prompt/observations with
the approved scope facts and general repair guidance. Both services use the
same corrected Python runtime. A source gate permits differences in only the
nine observation/prompt files; every other runtime file, benchmark input,
solver prompt and harness source is hash-frozen. The services use Luna at
medium reasoning effort, DELTA context, a 40-call turn cap, an 8,192-token
reply cap, and the same unbounded input policy. There is no ledger, additional
check tool or context-compaction change. Data and flow statistics are disabled
in both conditions; sample and full retrieval views remain available. History
is enabled for LongDS and disabled for the single-task benchmark.

The predeclared pilot contains four complete LongDS sessions (Uber-driver
business analysis, climate-solution geoscience, horse-racing sports, and the
2019 community survey) and eight KramaBench tasks spanning all six domains.
Each condition gets three independent repetitions: 417 LongDS questions and
24 single-task questions. Smoke attempts are repetition one of the same
cohort. Failed answers are retained; no best-of selection or score-dependent
solver replay is permitted. The previously studied LongDS cohort makes this
an exploratory pilot, not held-out evidence of general improvement.

KramaBench uses its official evaluator. Full-pass accuracy requires a primary
metric of at least 1.0; raw F1/relative-error metrics remain separate by answer
type. LongDS uses the existing binary DeepSeek judge and its upstream prompt;
identical question/reference/answer triples share a judgment. Neither judge
defines the causal error label. Manual trace inspection selects accuracy
flips and cost differences, records the first divergence and distinguishes
observed mechanisms from an unproven effect of scope facts. Costs use the
same cache-aware token rates in both conditions and are estimates, not
invoices. Judge spend is separate. Latency includes wrong answers and runtime
failures; paired cost analysis also reports both-correct turns and consecutive
correct prefixes. Unknown judgments, costs and timing stay unknown.

The chat interruption stopped both services during the two LongDS smoke
attempts, after three and four saved answers. Those partial attempts remain
intact. One replacement full session was registered for **both conditions**
before resuming; completed KramaBench smoke attempts were reused. Original
and registered-recovery report views are separate. Saved partial spend and
any unrecorded interrupted-request cost must accompany the replacement view.
Detached supervisors and controllers now preserve active runs across chat
interruptions. Scheduling changes adopt live children without replaying an
attempt.

Protocol, source archives, original/recovery manifests, traces, progress and
paired reports live at `/var/tmp/dataflow-scope-verification-20261004/`.
The registered recovery cohort is complete: **882 recorded answers**, all
judged, with known solver usage and timing, across 48 single-task attempts and
24 complete LongDS sessions. Every saved trace contains a terminal agent step;
there are no empty final answers or terminal runtime failures. Adopted child
process exit codes remain unknown rather than being relabeled successful. The
raw LongDS controllers retain `completed_with_failures` for the original
partial attempts and unknown adopted exit codes; the completed-artifact audit
and recovery view distinguish these from solver failures.

The [portable report](../../benchmark/longds/reports/scope-verification-20261004.json)
contains summaries and hashes for both report views, matched settings, raw official metrics,
cost/latency distributions, work counts, scope facts and eleven selected
manual audits. `scope_verification.py` freezes the study;
`scope_verification_report.py` builds read-only paired reports. The reporting
verification suite has **34 passing tests**, including mismatch rejection,
unknown timing/cost, interrupted-request spend, official partial metrics and
opaque-process accounting. Both archived source trees and all four original
manifests match their registered hashes. All 216 pilot agent/workflow/compute
resources were removed; the two dedicated services on 3063/3064 were stopped.
The shared backend, prior candidate and held ledger experiment remain intact.

| Measure | Before | After |
|---|---:|---:|
| KramaBench full-pass answers | 17/24 (70.83%) | 18/24 (75.00%) |
| KramaBench estimated solver cost | $0.073567 | $0.079947 |
| KramaBench mean question time | 33.88 s | 34.57 s |
| LongDS correct answers | 75/417 (17.99%) | 81/417 (19.42%) |
| LongDS estimated solver cost | $4.484477 | $4.910262 |
| LongDS mean question time | 47.44 s | 42.82 s |
| LongDS median question time | 28.01 s | 25.84 s |
| LongDS p90 question time | 102.02 s | 86.73 s |
| LongDS model calls | 1,369 | 1,434 |
| LongDS input cache hit rate | 98.42% | 98.45% |

The task/repetition bootstrap for KramaBench accuracy spans **0 to +16.67
percentage points**. The LongDS macro accuracy change is **+1.31 points**,
with a session/repetition bootstrap interval of **-4.52 to +6.73 points**.
Neither establishes a reliable improvement. LongDS gains and losses are
30 after-only versus 24 before-only answers. Aggregating all three repetitions,
the four sessions are business 24→25 correct, geoscience 3→8, racing 8→8 and
survey 40→40. These are four independent sessions, not 417 independent tasks.

Solver cost rises **8.67%** for KramaBench and **9.49%** for LongDS. On the
17 KramaBench turns correct in both conditions, cost is $0.049921 before and
$0.055959 after; on 51 LongDS turns correct in both, $0.226720 and $0.247104.
The eleven consecutively correct LongDS prefix turns cost $0.073709 and
$0.061097, a small conditional subset that does not certify latent state.
All wrong answers remain in the main cost comparison. The median paired
latency changes are -0.33 s for KramaBench and -2.58 s for LongDS; timing is
descriptive because shared backend/provider load and scheduling changed.
There is no measured CPU-time breakdown. LongDS visits show 1,005→850
executed and 6,037→5,865 cached operator outcomes, with 115→141 failed outcomes;
these count visits, not distinct operators or causes.

The completed pilot costs an estimated **$9.548253** in solver usage. Saved
interrupted attempts add **$0.062417**, with two additional started questions
whose usage receipts were lost and whose costs remain unknown. Judge spend
is separate: **$1.552314** reported by the provider for 824 unique cached
verdicts and 826 recorded calls, with no unresolved verdicts or pending calls.
No solver was replayed because its answer was wrong and no judge-only recovery
was needed. The single-task wildfire smoke passes in both conditions; the
full racing smoke completes 35 questions each, with 0 versus 7 correct.

Most new scope facts cannot expose callback semantics: 3,344 of 3,696 facts
(90.5%) mark opaque Process selection; 149 (4.0%) describe explicit filters,
limits or distinct selections, with the rest describing previews. This is
receipt accounting, not an exact context-token overhead measurement. Neither
condition changes a retained within-turn or cross-turn prefix. Historical
inspection is used three times before and seven after; neither uses a fork
or restore. This pilot therefore provides little evidence about version-tool
benefits. Data and flow statistics remain disabled in both conditions.

Eleven selected manual audits identify important limits. The sole single-task
accuracy flip comes from case normalization of yes/YES/Yes, without evidence
that scope caused the repair. Both versions omit a study-inclusion marker in
the patient-age task. The archaeology task also exposes a definition/fixture
uncertainty: the local reference replay gives 38.06%, the recorded gold is
38.42%, and the agents' different adjacent-observation definition gives 50.25%.
Official scores remain unchanged. The KramaBench list F1 mean changes from
0.79365 to 1.0; numeric-exact success remains 12/18 in both conditions and the
numeric-approximate relative-error score remains 1.0 for all three repetitions.
Those raw metrics are kept separate by answer type.

One multi-turn regression directly concerns reusable state: both versions
answer the prior top-five report correctly, but the revised run truncates its
reusable calculation inside an opaque Process to five rows. The next task
needs five distinct route/family pairs; deduplication leaves four and the model
mistakes that subset for all eligible cases. The earlier run retains thirteen
calculation rows and applies a separate graph limit, so it can recover the
fifth distinct case. This is a real cross-turn failure despite a correct earlier
answer, and the new prompt guidance did not prevent it. Other selected score
flips reveal inconsistent judge requirements for equivalent salary summaries
and for extra numeric fields. These annotations explain selected cases; they
are not an exhaustive causal error distribution or a correction to official
scores.

A racing-session gain has a clear computational mechanism. The earlier run
uses a mean for the early-drive stage where the question explicitly requires
a maximum, and repeats the same erroneous aggregation in the next question.
The revised run computes the maximum, retains a complete start-level panel,
and reuses it for the next calculation. Both the flagged comparison share
and the retained/lost evidence counts match the recorded reference. The
correct calculation is authored before observing the completed panel, so
this trace does not establish that scope facts caused the gain.

The next racing repetition reverses that result: the earlier run computes the
required maximum correctly while the revised run averages every stage and
also restricts the clean flag predicate to pre-incident candidate membership.
Whole-session before/after scores are **0/7, 8/1 and 0/0** across repetitions.
That variation reinforces the need to distinguish observed computational
mechanisms from a stable effect of the prompt/representation change.

The representation, version bindings, budgets and ordinary ReAct execution
are verified. The accuracy benefit is not established, and multi-task accuracy
remains low. The conditional larger campaign and statistics/component
ablations are deferred. The next technical priority is to make reusable row
selection boundaries visible in actual model-authored graphs and to resolve
judge/reference inconsistencies before making a broader state-management
claim. The ledger and separate check interface remain deferred.
