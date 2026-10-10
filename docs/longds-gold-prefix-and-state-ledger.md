<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# LongDS: the gold-prefix protocol and the state ledger

Two pieces built on 2026-10-02 on `feat/operator-history-lean`. The first is an
evaluation protocol that measures how an agent uses correct earlier state without
the cascade of its own earlier mistakes. The second is the agent mechanism it was
built to test: the system verifies reuse of earlier state instead of asking the
model to inspect history.

## Why

In every natural LongDS session we ran, 74–82% of dependent turns sat on an
earlier wrong answer, so per-turn accuracy on state-dependent turns was measured
on a few dozen surviving turns. On those, the script agent with a persistent
kernel was ahead (Terra: 31/37 vs 18/37 on the same turns), and our agent reused
earlier operators on 93% of turns without ever reading what it reused: a 19-row
filtered watch list wired in as the lookup for a 30-unit pool, an 8-row report
used as the population, an empty table used as the source of a global constant.
The version tools (fork, inspect state, bind, restore) were used on about 0–1% of
turns because the model never overwrites a definition; versions were never the
problem, producer selection was.

## The gold-prefix protocol

Every LongDS task ships its reference solution (`task.py`, v1.1 for all 68
tasks). `benchmark/longds/gold_state.py` replays it turn by turn in one
namespace, checks each turn's answer against gold, and after every turn records
the state the reference holds: each DataFrame/Series as Parquet (written once per
distinct content; nested cells become JSON strings, mixed-type columns become
text), each small scalar/collection as a constant, which turn created and last
changed each name, and which earlier names the statement that assigned it read.
For the five prepared sessions every turn replays exactly (Restaurants 33/33,
Kiva 37/37, Netflix 36/36, Survey-2022 30/30, NFL 42/42).

`benchmark/longds/gold_prefix.py` turns that into per-turn inputs under
`<gold-state>/<case>/prefix/turns/tNN/`:

| file | content |
| --- | --- |
| `prefix.md` | tasks 1..t-1: request, reference solution, gold answer, tables created or changed |
| `state.md` / `state.json` | every table in force after task t-1, with rows×cols, parents and the task that last changed it |
| `seed.changes` | the dataflow arm's edit program: one `scan(<parquet>)` per table |
| `seed_kernel.py` | the script arm's kernel preamble: the reference code of turns 1..t-1, output suppressed |
| `message.dataflow.txt` / `message.script.txt` | the single request each arm receives; identical bytes except three arm sentences (persistence, answer channel, where the loaded state lives) |

A turn is eligible when every earlier turn replayed exactly; the dependent
eligible turns of the five sessions are 172 per arm.

Runners, one process per turn:

- `agent-service/benchmark/multiturn/run-gold-prefix.ts turn-dir prepared-dir out-dir baseline|history|ledger`
  creates an agent, loads the tables through `POST /api/agents/:id/seed-state`
  (`{changes, completedTasks}`), runs one request, and records the answer,
  usage, wire audit, workflow and which seeded tables were read or wired in
  (`state-use.json`).
- `benchmark/longds/gold_prefix_dsgym.py --turn-dir … --prepared … --out … --model …`
  runs the paper's `MultiTurnReActDSAgent` over the local kernel executor; after
  allocation the kernel executes `seed_kernel.py`, so it holds the reference
  variables, helpers and constants. The executor mounts the reference base
  directory read-only (`--extra-ro`) so the reference code's data paths resolve
  inside the sandbox. Matched budget: 40 calls, 8,192 output tokens, medium
  reasoning effort.
- `benchmark/longds/gold_prefix_campaign.py run|judge|report` launches the jobs
  with a fixed concurrency, judges with the paper's judge (DeepSeek-V4-Pro through
  OpenRouter, appendix E.2 prompt) and reports accuracy by arm, session and label
  with token cost at the frozen rates.

The loaded state is a hidden synthetic step (`synthetic: "state"`): its
snapshot and results are inherited by the request, nothing about it is rendered
into the model's context, and it does not count as a task. `completedTasks`
makes the ledger number the request after the loaded tasks.

What the protocol does not do: it does not test rollback across turns of the
same session (each turn starts from reference state, so the loaded tables are
the current version), and it gives both arms the reference code as the
transcript of earlier work, which is more than a natural dataflow session shows.

## The state ledger (`stateLedger`)

Three receipts, all derived from snapshots and results, never written by a
model and never rewritten once written (so the prefix stays cacheable):

1. **Ledger** — the Answer receipt of a sealed task lists every table the task
   created, changed or deleted: `name rows×cols kind ← inputs · definition`,
   with `limited table`, `1-row constant` and `EMPTY` tags and `[updated]` for a
   revised definition. The answer itself is no longer echoed in the receipt or
   duplicated as assistant text.
2. **Provenance card** — an Edit receipt lists every input taken from state that
   predates the task (an earlier task's table, `[task k]`, or loaded state,
   `[loaded]`) with its shape, inputs and definition, and which new operators
   consume it.
3. **Execution notes** — under an executed operator: an input with 0 rows, an
   input that is a limited (top-k) table (with its unlimited parent), a join side
   that is a filter of a table that also exists unfiltered, and the row counts
   on both sides and in the output of a join (with the unmatched count for an
   inner join).

The vocabulary stays the edit language. With `stateHistory`, two commands are
added: `update operator <id> from task <N>` restores the definition task N
saved, in place, on today's inputs (the receipt names inputs that changed
since); `fork operator <id> from task <N> as <new_id>` copies that version and
its task-N inputs under new IDs, next to the current one. `inspect
target=state` reads a saved version or lists an operator's versions. A restore
is itself saved when its task is answered, so going back never removes a
version. The prompt's "Earlier tasks" section describes the gestures: extend,
update in place, and with `stateHistory` read, fork or restore a saved version.

Settings: `stateLedger` (ledger, provenance, notes; default false) and
`stateHistory` (saved-version inspection, restore and fork; default false). The
experiment arms are `baseline` (both off), `history` (`stateHistory`) and
`ledger` (both on).

Code: `agent-service/src/agent/state-ledger.ts` (pure functions),
`tools/dataflow-action-runtime.ts` (wiring), `tools/dataflow-actions.ts`
(rendering), `context/summarize/native-frames.ts` (answer echo),
`texera-agent.ts` (`seedState`, task base), `prompts.ts` (`nativeStateText`).
Tests: `state-ledger.test.ts`, `seed-state.test.ts`, `state-history-prompt.test.ts`.

## Mechanism v2 (2026-10-02, after the pilot's trace study)

The trace study of the first pilot
([benchmark/longds/reports/gold-prefix-pilot-20261002-trace-study.md](../benchmark/longds/reports/gold-prefix-pilot-20261002-trace-study.md))
found the dataflow arms 18% more expensive than the kernel script under one
accounting rule, all of it in 1.4 extra calls per turn (schema discovery, the
retrieve-then-retype answer pair, repairs of engine strictness), and found
every lineage tool unused because nothing in the protocol ever gave it a
target. The changes below remove the mechanical calls and give the model a way
to reference state instead of retyping it. Everything stays inside the
existing vocabulary; nothing is a per-benchmark rule.

Operators and engine (`native/catalog.ts`, `native/python/runtime.py`):

- `values`, a literal-table operator, was added on 2026-10-02 and removed on
  2026-10-03: across 338 traces the model used it in 4 tasks, 3 of them to type
  in numbers it had read from raw file lines instead of parsing them. Constants
  the request supplies stay in the definition that uses them; lists the
  reference solutions keep are seeded as parquet scans (below).
- `join(how="semi" | "anti")`: the left rows with (without) a match, each once,
  left columns only. The way to use a selection that exists as a table.
- Permissive where pandas is permissive, with the adjustment recorded in the
  execution receipt (`note:` lines from `nativeAdjustmentLines`): a boolean
  column sums and averages as 1/0 (`boolAsInt`); a window or unpivot output
  that names an existing column replaces it (`replacedColumns`); a right-side
  join column whose suffixed name is also taken gets the suffix again instead
  of failing (`renamedRight`); `pd` and `np` are bound inside every callback.

Actions (`tools/dataflow-actions.ts`, `tools/dataflow-action-runtime.ts`):

- `inspect` of the graph or of an operator returns the rows and columns of every
  completed result, so a listing is not followed by a schema read.
- `retrieve` takes an optional `columns` list that restricts any view to those
  columns of a wide table, in place of a projection operator.
- `answer` with `from` (`native/answer.ts`, ported from the lean branch)
  composes the final answer from an executed table by a fixed mapping: one row
  an object, several rows a list of row objects, one column a list; a
  projection `t[key=column:digits, ..., :digits]` names keys, picks columns and
  rounds (half to even, as Python); several parts separated by `;`
  (`leaders=top[country, score:2]; movers=moves`) give one answer key per
  table, which is what most LongDS answers need. It may close the call that
  executed the table. Decimals need a stated precision that matches the
  session's requests;
  an empty table, more than 50 rows, a missing column or unrounded decimals are
  refused with the reason, and the model answers in `content`. An answer with
  `content` is still the only action of its call.

Ledger (`state-ledger.ts`, `stateLedger` only):

- Ledger lines and provenance cards carry the table's columns
  (`· columns: a:int, b:str, +3 more`, 120 characters).
- The limited-table note fires only when the consumer is a join, filter,
  aggregate, map or process; a projection or sort of a top-k is report shaping.
- Current-pool note: an aggregate or window that reads table T is told which
  smaller tables derive from T through row-subset operators (filter, limit,
  distinct, semi/anti join): `note: leaders reads players (86 rows); smaller
  tables derived from it in state: reliable (42 rows), current (33 rows).`
  Lineage only; seeded scans have none, so the note is silent in the
  gold-prefix protocol and speaks in natural sessions.
- Literal note: a filter or map whose literal list equals a key column of a
  small table in state (one row per value, held in full, not an ancestor of the
  operator) is told which table holds it and that `join(how="semi")` keeps the
  dependency explicit.

Protocol (`gold_state.py`, `gold_prefix.py`, `gold_prefix_rules.py`,
`gold_prefix_campaign.py`):

- Lists and sets the reference keeps are never dropped for length. Each is
  classified against the tables beside it: `column_names` when every item names
  a column of one table (stays in the constants line, in full), otherwise
  `values` with the column whose values contain every item. These are written
  to one-column parquet files under `prefix/collections/` and seeded as `scan`
  operators like every other table; the kernel arm has them as variables
  already.
- The state listing shows every table's column names (numbered families
  compressed losslessly, `Q6_1..Q6_12`; 16 entries per table, then `+N more`;
  types come from `inspect` or `retrieve`). With types and 60 columns the
  late-turn messages had grown 35–50%, more than the discovery call they
  replace; membership lists are listed as one-column tables in the per-task
  blocks rather than printed in full as constants. A late turn's message is
  now about 20–30k characters longer than the pilot's (listing 20–26k, rules
  4–5k), fresh on the first call and cached after.
- `gold_prefix_rules.py` writes, per turn, the conventions the completed tasks
  stated (ordering, ties, rounding, denominators, fallbacks, populations),
  extracted by the model from the request texts; `build_message` places the
  block before the current question in both arms. Written once per turn,
  recorded with its usage.
- The judge runs the numeric gate first (`numeric_gate.diff`; an exact answer
  scores 1 without a call), then samples the judge until two verdicts agree,
  three at most (`--samples`, default 2). The report prices every arm under
  one rule as well (`uniform $`: fresh and cached input, output, no cache-write
  surcharge) and counts exact matches.

Tests: `benchmark/tests/test_native_v2_values.py`, additions in
`test_native_v2_relational.py`, `test_native_v2_shapes.py`,
`test_native_error_taxonomy.py`; `native/answer.test.ts`,
`state-ledger-notes.test.ts`, additions in `native-program.test.ts` and
`tools/dataflow-actions.test.ts`. The reference documents under `native-mode/`
are regenerated.

## Operating notes

- Never edit the runner or the service API while a campaign is launching jobs:
  the runner is read per job, the service is not. Two incompatibilities
  introduced that way failed 70 baseline jobs instantly (no model cost) on
  2026-10-02; they were rerun after both service instances were restarted on the
  new build.
- Start the agent service with `bun run src/server.ts` (no watch) for campaigns;
  `bin/local-dev.sh` uses watch mode and would reload on every edit.
- Python runtime files (`native/python/*.py`) are read per call by a running
  service; do not edit them while runs are live.
- `pkill -f <pattern>` matches the shell that runs it when the pattern appears
  in that shell's own command line; find the PID with `lsof -tiTCP:<port>` instead.

## System prompt layout (2026-10-03)

`agent-service/src/agent/prompts/native-mode.md`, rendered to
`native-mode/SYSTEM_PROMPT.txt`, is organized in three parts:

1. **The dataflow tool**: the role, the five actions grouped as look
   (inspect, retrieve), change (edit), run (execute) and finish (answer); then
   editing the dataflow, the operator catalog and Python inside operators.
2. **Working on a task**: five steps (start from what exists, look at the
   data, build, run and read, answer), then "Earlier tasks": tables from
   earlier tasks are the state to build on; extend, update in place, and with
   `stateHistory` read, fork or restore a saved version; with `stateLedger`
   what the receipts record.
3. **Examples**: a single task, reading results (by retrieval setting),
   several tasks (wiring an earlier table with a semi join, updating a rule), earlier state (reading an earlier table; with `stateHistory`
   update from an earlier task, fork an earlier version, inspect a saved definition).

The earlier-tasks basics are now in every prompt, so the `baseline`, `history`
and `ledger` arms differ only by the history and ledger paragraphs and their
examples. Generated parts: the catalog (`graphCatalogText`), retrieval views
(`nativeRetrievalText`), evidence (`nativeEvidenceText`), earlier tasks
(`nativeStateText`) and state examples (`nativeStateExamples`).
