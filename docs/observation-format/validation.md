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
