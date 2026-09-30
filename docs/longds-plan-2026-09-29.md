# LongDS: where we stand and what to try next

2026-09-29, branch `feat/state-registry`. Numbers come from the full one-rep
run of 2026-09-27: our arm (`react-lean2`, runs `LongDS_PlanA/PlanB_20260927`)
against DSGym with our task text (`LongDS_DsgymShared_20260927`), Luna, 68
sessions, 2,225 turns. Scripts are in `logs/registry/` (`cost-anatomy*.py`,
`dsgym-cell-shape.py`, `ours-call-shape.py`, `rewrite-reasons.py`,
`engine-errors-seen.py`, `schema-in-requests.py`).

## Where we stand

Accuracy is a tie within one-run noise: 732 against 723 of 2,225. We cost
more: $15.61 against $9.11 (1.7x).

### Why DSGym is cheaper

| | Ours | DSGym |
| --- | --- | --- |
| Model calls per turn | 2.73 | 2.41 |
| Turns with 3 or more calls | 41% | 25% |
| Input tokens per call | 50.4k | 39.2k |
| Output tokens per turn | 2,136 | 1,539 |
| Cache writes | $4.11 | $1.13 |
| Cached reads | $5.79 | $3.99 |
| Output | $5.70 | $3.99 |

- **DSGym does not batch, and it has no extra metadata.** Both arms see the
  same file list. In 57% of its turns it writes one computing cell (median
  about 2,000 characters), prints the result and answers on the next call.
  Only 22% of its cells just look at data, and in turn 1 it mixes
  `.columns`/`.head()` into the computing cell.
- **The requests do not spell out the schema.** Only 1–4% of turns name a
  `table.column`, and joins are stated only in some first turns (9%). After
  turn 1, DSGym knows its columns because its context keeps every cell it
  wrote, verbatim.
- **Our extra calls are mostly rewrites.** 42% of our follow-up editing calls
  rewrite a statement the previous call wrote; the rest add pieces left out.
  At least 58% of the rewrites answer a failure the engine returned, and only
  8% answer suspicious values.
- **Our prompt is bigger and is partly rewritten at every turn.** We have a
  13k-token system prompt against about 1k. At each new turn, the finished
  turn is replaced by a compact entry and the definitions index is generated
  again, so about 4k tokens are written to the cache per turn. That costs
  about $0.7 for the index and about $1.5 for the entry. The entry is a
  deliberate trade: keeping the raw turn instead would make every later call
  read more.

### Errors our engine returns

25% of our calls return at least one failure, against 10% of DSGym's cells;
on KramaBench it is 14%. Most of these failures are the model's own pandas
mistakes (KeyError 165, AttributeError 37, NameError 17), which DSGym makes
just as often (KeyError 172). About 540 further lines only repeat an earlier
failure ("not executed; upstream X failed"). The ones caused by our engine's
own rules:

| Issue | Times | Fix |
| --- | --- | --- |
| A result column holds lists or mixed types, so the result is rejected | 98 | Store them as JSON or text automatically |
| Execution timed out | 65 (23 of them in ds4g and kaggle-survey-2019) | Profile those two sessions and speed up the slow operator |
| Same name or function defined twice in one call | ~60 | The last definition wins, as in Python |
| Function dropped because no table uses it yet | not counted separately | Keep it |
| The agent runs `pip install` or imports a missing package | ~25 | List installed packages in the prompt; refuse pip |

That's about 250–300 errors, roughly 8% of calls. Removing them saves about
$1 per full run. It may also help accuracy, since a failed turn cascades.
KramaBench shows different frictions (duplicate headers 45, missing files 21,
union types 17), so these rules are not LongDS-only, but LongDS brings out
different ones.

### DSGym's problems, looked at again (Luna)

1. **It does not act.** It refuses or claims the data is inaccessible on 28%
   of turns, all wrong; 45 of 67 sessions start without code; a refusal
   predicts the next one (75% against 8%). This is where most of our wins
   come from, and it is not about state.
2. **Output floods.** Two sessions printed a huge table once, overflowed the
   context and lost the rest of the session.
3. **Real state mistakes, about 30 turns.** It retypes earlier printed
   numbers, reuses variables whose meaning changed, and keeps wrong helper
   functions. Our kept, documented tables avoid these.
4. **Both arms share the big problem.** 76–82% of wrong turns sit on an
   earlier wrong answer, and neither arm repairs it.
5. **On clean chains DSGym is a little more accurate:** 75% against our 71%
   on the same turns, both computed.

The reset and refresh probes (2026-09-28) showed no gap either. Our state
tools (bind, fork, supersede, at) were used on 22 of 2,038 turns.

## What we think

- **We have probably overcomplicated the state side.** On Luna, the state
  mechanisms are not what wins. What wins is that DSGym gives up.
- **Luna may be hiding the real comparison.** In the one earlier DSGym run on
  Terra (3 sessions, 72 turns) it refused 0% of turns. On Terra, DSGym's
  biggest weakness should mostly go away. Whatever gap remains would be
  closer to true state handling: stale variables, retyped numbers, finding
  the right earlier table.
- **Terra data so far is thin.** On LongDS (older build, 3 sessions) Terra
  dataflow scored 36% against DSGym 39%. On KramaBench (single task) it was
  74 against 65. There is no full Terra LongDS run.
- **Cost on Terra is uncertain.** On those earlier LongDS runs, Terra cost
  about the same as Luna for our arm ($0.41 against $0.44 for 72 turns) and
  about 1.5x for DSGym. On KramaBench it cost about 9x more.
- **Cost is a set of $1 items, not one big lever.** The engine rules, the
  turn-start rewrite and the prompt size are each worth about $1. The rest is
  structure: more calls, and more text per call.

## Plan

1. **Fix the engine rules** in the error table: store lists and mixed values
   as text, let the last definition win, keep unused functions, list
   packages and refuse pip. Check each on a short smoke run (cents). Look at
   the ds4g and kaggle-survey-2019 timeouts separately.
2. **Terra pilot.** The 8 sessions of the last check (235 turns), our arm and
   DSGym, 1 trial. On Luna that set cost $1.56 and $1.35; on Terra we expect
   about $3–15 per arm. Stop early if the first session costs far more.
3. **Read the Terra traces** for the state mistakes above (retyped numbers,
   stale or changed variables, frozen helpers, wrong earlier table) and count
   them in both arms. Keep investing in state tooling only if our arm shows
   clearly fewer. Otherwise, simplify the arm: drop the unused state tools
   and their prompt sections, which also shrinks the prompt.
4. **Only then consider the cost items:** an append-only definitions index
   (about $0.7) and asking the model to cover everything the request names
   in its first call. Keep the result previews: the rewrites that answer
   suspicious values are the ones that can change an answer.

No full run is planned before steps 1–3 are done and their costs approved.
