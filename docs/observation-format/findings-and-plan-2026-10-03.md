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

# Findings and change plan (2026-10-03)

This note records the fork-and-restore findings and the original proposal.
The run and its full tables are in
[validation.md](validation.md#fork-and-restore-2026-10-03). After reviewing the
traces, we adopted the smaller iteration below. The column-command proposal
at the end is superseded; it has not been implemented.

## Summary

- One rep with Luna on five LongDS sessions, 164 turns. The dataflow agent
  answered 78 turns correctly and DSGym 88. Costs were $1.09 and $0.55. Fork
  and restore were never used.
- The two agents tie on the turns that change a rule. The gap is in later
  turns that build on earlier answers. When an earlier answer was wrong, DSGym
  still got 12 of 36 later turns right; we got 4 of 35.
- The restaurant trace exposes a problem in the shape of the graph. Each task writes a new `process`
  operator that starts again from the cleaned table, re-types the rules it
  needs, and cuts the result down to the answer. No operator holds the rows
  under the current rules. So:
  - later tasks have nothing to build on;
  - rules drift when they are re-typed;
  - there is nothing to update in place or fork.

  DSGym keeps its rules as columns of one data frame and reads them back.
- Most of the cost gap comes from the prompt. Late in a session, about
  nine-tenths of each call is earlier tasks' calls and receipts.
- Current iteration: retain basic ReAct and the existing historical tools,
  teach reusable working results with separate answer selections, and verify
  this change before experimenting with context reduction.

## Accepted iteration after review

The history operations already exist: inspect a saved result, fork its
historical input closure, and restore an earlier definition on current inputs.
Their absence from the run does not show what they would contribute if used.
We keep those operations and the existing ReAct loop, tool schema, context
assembly and cache layout.

The implemented prompt revision demonstrates one continuous, synthetic
five-task analysis. It retains all unit scores before the top-k report,
measures coverage on the full source rather than the filtered scoring rows,
revises an existing rule, compares every unit with a historical working table,
and restores the rule for later tasks. Ordinary operators express this;
there is no new column language, table-alias registry or automatic rewiring.
The prompt also says to preserve eligibility when fewer rows qualify than
requested, and to check the population and count grain before changing a rule.
Saved state records a computation, not a correctness verdict.

Verification runs the example through the actual graph compiler and Python
runtime and through the live engine, including historical reads without
execution, changed current inputs, two qualifying rows and an empty result.
The first benchmark probe is the first eight turns of restaurants and Los
Angeles, with Luna and the previous arm's settings, plus a single-task
KramaBench smoke. These prefixes are a fast mechanism check, not the full
five-session comparison. Results are recorded in
[validation.md](validation.md#reusable-working-state-iteration-2026-10-03).

Context reduction remains a separate experiment. Retain immutable catalog
entries and measure prefix reuse rather than assuming that a task-boundary
cut is cache-neutral. Judge accuracy and preservation of the requested rules;
update counts and code volume are diagnostics, not adoption quotas.

## Next verification iteration

The fresh matched campaign and completed retrieval/history diagnostics are in
[validation.md](validation.md#matched-comparison-campaign-2026-10-03). The
five-session tables below describe the earlier pilot, not this campaign.
Keep the basic ReAct loop and optional history tools. The immediate priorities
are runtime compatibility, discovery of useful state, and the cost of carrying
an entire conversation. General accuracy/cost benefits from history remain
unproven. The earlier broad-trace audit found no successful historical actions.
The completed cohort has 17 accepted historical inspections and three accepted
forks, including one correctly answered cross-screen comparison where both
matched controls fail. Aggregate accuracy and cost do not establish a history
advantage. The final table and failure-adjusted costs are in
[validation](validation.md#completed-primary-comparison).

### Concrete compatibility correction

A recorded goodbooks process fails at pandas `pivot_table(..., fill_value=0.0)`
and later `unstack(...).fillna(0.0)` with `KeyError: dtype('float64')`. The same
minimal calculation works with ordinary integer columns and fails with nullable
`Int64` under the campaign's pandas 2.2.3 runtime. A candidate corrects the
process boundary by converting complete nullable integer columns directly to
NumPy `int64`. Columns containing missing integers retain their masks; integer
identifiers never pass through floats. This is a compatibility correction,
not a change to task orchestration or historical semantics.

The candidate lives in a separate worktree and its patch and test logs are
retained under `/var/tmp/dataflow-state-comparison-20261003`. The original frozen
jobs are complete. The correction and disabled-by-default budget policy are
now promoted to the primary checkout, with 1,313 agent-service tests, 89 benchmark
tests, typechecking and all five live process checks passing. Candidate sources
for the ongoing unbounded/64k controls remain frozen in their separate worktree.
Two matching error entries on
one completed turn do not establish that this fix explains the broader
accuracy gap.

The full-input budget and its forced-compaction rehearsal are recorded in
[validation](validation.md#verified-next-iteration-candidate). The candidate
keeps the existing ReAct loop and DELTA compactor, with a common calibrated
estimate and an independent wire guard. Calibration uses development request
usage rather than accuracy. Compaction changes cache prefixes, so measure
total cost rather than assuming a benefit from fewer tokens.

The completed 20-request live retention check also establishes a boundary:
saved observations survive delayed reads and external source overwrite/deletion,
within their retained cap. Executing historical definitions may read changed
external bytes or fail after deletion. Full historical materialization after
external inputs disappear remains a separate, unproven guarantee.

### Framework changes to test

1. **Make available state easy to discover.** Test the existing `stateLedger`
   with history, showing names, saved versions, schema, row counts and input
   provenance. Distinguish a complete working population from a ranked answer
   leaf and distinguish execution freshness from analytical correctness.
   Keep state selection with the model; do not automatically fork or restore.
2. **Improve concise failure feedback.** Audit root execution errors separately
   from blocked descendants and failed retrievals. Preserve the root message,
   operator, user-code location and useful recovery information. Measure
   whether summarizing unchanged cached ancestors reduces repeated bytes and
   repair attempts before changing the receipt format.
3. **Bound the full provider request.** Account for system instructions and
   tool definitions as well as the assembled trajectory. Preserve stable
   prefixes between compactions, and keep definitions/results available through
   explicit inspection after old conversation turns leave the prompt.

Across six completed matched session/repetition groups, native history's mean
full input grows from 23,837 tokens in the first five turns to 102,820 in the
last five; DSGym grows from 11,411 to 59,874. The first-request median serialized
system/tool overhead is 49,345 characters for history versus 3,288 for DSGym.
These descriptive numbers include nonanswers and are not a causal efficiency
estimate. They show why setting each existing context knob to 64k would not
give both interfaces the same full-request budget.

### Experiments in order

| Stage | Matched comparison | Decision it informs |
|---|---|---|
| Complete current campaign | DSGym, native baseline, native history; all frozen repetitions retained | Actual accuracy/cost differences and mechanisms, including abstention-adjusted costs |
| Context calibration and comparison | All three arms on one frozen runtime revision, unbounded versus a nominal 64k full-input budget; 8k output cap and 40 calls unchanged | Whether explicit state retains utility when conversation history is limited, and whether costs fall |
| Discoverability | History versus history + ledger at the same calibrated budget | Whether visible state provenance improves population selection, reuse and accuracy |
| Historical stress | Natural sessions with delays of 8/16 requests, multiple changed ancestors, rollback, and temporary branches | Historical values versus historical definitions on current inputs; recovery and source/result retention guarantees |
| Script-interface control | Original DSGym versus a separately labeled function-calling Python ReAct baseline, same model, kernel and limits | How much behavior comes from the XML action interface rather than state management |
| Evidence/model checks | Data statistics and flow evidence varied independently; a separate model sanity check | Whether findings depend on evidence exposure or one model's interface behavior |

For the initial bounded-context and ledger comparison, predeclare these four
full sessions from metadata: `business/my_uber_drivers/task2` (14 rollback
labels), `geoscience/cdp-unlocking-climate-solutions/task1` (39 turns, 15 update
and 14 counterfactual labels), `sports/big_data_derby_2022/task1` (10 update and
10 rollback labels), and `community/kaggle-survey-2019/task2` (low-change
control). Use three independent repetitions, retain failures and unknown costs,
and expand to the original twelve-session cohort after protocol validation.
This selection is based on workload metadata, not which solver won.

The 64k target must include system/tool overhead under a common estimator.
Audit actual provider input-token usage and report violations; a character
estimate is not an exact model tokenizer. Keep ledger, statistics/flow,
interface and model interventions separate from the context intervention.
Changed prompts/runtime revisions require freshly frozen controls, not a
comparison to an old arm carrying several other differences.

Historical stress must also record recomputation and cache use, execution
latency and rows processed. The existing 6,000-row diagnostic recomputes the
copied historical graph initially; it does not prove reuse of a full historical
materialization. Both old/new files remain available. Test replacing/deleting
the original physical file separately, and state the retention guarantee
before proposing durable materialization or input-version features.

Report whole-session paired accuracy, model cost, cost per correct answer,
both-correct cost, historical operation use, repaired/unrepaired tool errors,
and runtime work. Correct answers do not imply correct complete working state,
and no-code answers can be legitimate reuse. Keep all failures in the primary
score rather than rerunning until a favorable trace appears.

## Findings

### The run

| turns | dataflow | DSGym |
|---|---|---|
| all (164) | 78 | 88 |
| rule changes that need no old version (30) | 10 | 10 |
| rule changes that keep both versions (16) | 6 | 5 |
| later turns that depend on such a change (46) | 9 | 19 |
| rollbacks after such a change (22) | 5 | 11 |
| cost | $1.09 | $0.55 |

We have two DSGym runs on these turns, and they differ from each other by 6
turns. So one rep cannot show that the dataflow agent is worse, but it does
show it is not better.

### Where the gap is

The 49 later turns (dependents and rollbacks) mostly sit downstream of a
mistake: 35 depend on a turn the dataflow agent answered wrongly, and 36 on a
turn DSGym answered wrongly. With every dependency right, the agents are close
(8 of 14 against 10 of 13). With a wrong dependency, DSGym still answered 12
of 36 and the dataflow agent 4 of 35.

DSGym does not get there by starting over. It reloaded the raw files on only 3
of the 49 turns, and otherwise used variables from earlier turns. The
difference is in what each agent read. For the dataflow agent's turns with a
wrong dependency:

| what the turn read | turns | right |
|---|---|---|
| a table made by a turn it had answered wrongly | 21 | 1 |
| only the base tables, rebuilding every rule in a new `process` operator (19 to 114 lines of Python) | 10 | 1 |
| other earlier tables | 4 | 2 |

DSGym read a variable from a turn it had answered wrongly on 19 turns, and
was still right on 6. In each of those six, the earlier mistake was in
something the next turn did not use:
- extra rows in an answer;
- one field's values;
- a rounding difference;
- source IDs that the judge rejected on one turn and accepted on the next.

Restaurants turns 6 to 8 show both patterns side by side. Turn 6 switches the
value rule to the top quartile of cost within each cuisine, and both agents
got turn 6 wrong.

**DSGym.** It listed nine carried-over rows where five were asked. But its
`orders` frame now carried the new `expensive_cuisine` column correctly, and
turns 7 and 8, built on that frame, came out right.

**Dataflow.** On turn 8 it did not read its turn-6 operator at all:
- It wrote a new operator off the turn-1 cleaned table.
- It re-typed the day-based slow rule, the within-cuisine value rule and the
  pressure weights.
- It left out the turn-4 rule that a restaurant needs at least ten cleaned
  orders. Its first attempt applied that threshold to the wrong count, and the
  second dropped it.

It listed four rows where the reference has two. DSGym filtered on its
`restaurant_counts` from earlier turns and listed exactly those two.

Two of the ten turns that only DSGym answered correctly are judge
inconsistencies:
- **Water turn 6.** Both agents name the same five sources, off by one from
  the reference IDs, and only DSGym's are accepted.
- **Water turn 28.** The judge reads the question as yes-or-no for DSGym, but
  as a list for us.

### The cause: one-off scripts around the cleaned table

The restaurants session introduces its rules one at a time:
- turn 2: slow orders are judged within each day category;
- turn 4: a coverage screen requires at least ten orders per restaurant;
- turn 6: expensive orders are judged within each cuisine.

A pipeline would hold these as steps that later tasks read. The dataflow agent
built something else:

| task | new operators | reads |
|---|---|---|
| 1 | `cleaned_orders` (process, 24 lines), `pressure_scan` (process, top ten) | the scan |
| 2 | `fixed_day_review` (process, 13 lines, top-k) | `cleaned_orders`, `pressure_scan` |
| 3 | `dropped_rows` (process, 20 lines) | `cleaned_orders`, `pressure_scan` |
| 4 | `covered_overlap` (process, 13 lines, top-k) | `cleaned_orders`, `pressure_scan` |
| 5 | `coverage_sensitivity` and `coverage_topten_audit` (process, top-k), `coverage_stability` | `cleaned_orders` |
| 6 | `cuisine_value_comparison` (process, 15 lines, top-k) | `cleaned_orders`, `covered_overlap`, `coverage_topten_audit` |
| 7 | `value_treatment_shift` (process, 20 lines, top-k) | `cleaned_orders` |
| 8 | `low_volume_high_risk` and `low_volume_all_rows` (process) | `cleaned_orders` |

28 of the 29 tasks after the first read `cleaned_orders` directly. Each task's
operator recomputes the rules it needs from there, and most keep only the rows
the answer needs. Across all five sessions:
- 266 of the 376 operators are `process`;
- 110 operators are cut to a top-k inside;
- only 7 of 164 tasks changed an earlier operator.

This one pattern accounts for what we saw:

- **Rules drift.** A rule that is written once per task can come out
  differently each time, or be left out, as on turn 8.
- **Earlier answers carry forward.** When a task does read an earlier table,
  it is usually an answer list, so that turn's mistakes come along.
- **Fork and in-place update have nothing to act on.** A rule lives inside a
  function that also does everything else, so changing the rule means
  rewriting the whole function in a new operator.
- **Output grows.** We write 1.5 times DSGym's code by characters (564k
  against 375k). The share of lines repeated verbatim from earlier turns is
  similar in both (21% and 28%), so the difference is in how much each task
  writes, not in copying alone.

DSGym does what we hoped the dataflow would do. Its `orders` frame gains
`slow_day`, `expensive_cuisine` and `repeat_exposed` columns as the rules
arrive, and small frames such as `restaurant_counts` sit beside it. Later
turns read them.

### The cost

We estimated Luna's prices by fitting them to the five runs: $0.26 per
million uncached input tokens, $0.018 per million cached, and $1.30 per
million output tokens. At those prices:

| | cached input | output | uncached input |
|---|---|---|---|
| dataflow | $0.54 | $0.38 | $0.17 |
| DSGym | $0.19 | $0.29 | $0.07 |

Output per call is about the same: 657 tokens against 593. The difference is
how much each call carries: 71k tokens on average against 29k. For the
dataflow agent this grows from 25k in a session's first five turns to 122k in
its last five. The context keeps every earlier task's calls and receipts in
full. On the last turn of a session, the messages sent with each call are 311
to 584 KB, against a 40 KB system prompt.

### What the new commands did

Nothing. There were 30 turns where a rule could change in place. On them the
agent updated an earlier operator 5 times, forked nothing and restored
nothing. Most of those requests also ask how the result compares with the old
one. The agent answered them by building a second version next to the first.

## Original proposal (superseded)

The following was the initial proposal before the trace review. It is retained
to explain the decision, not as the current implementation plan.

### 1. Rules as columns on a working table

Give the agent what DSGym has: one table that carries the current rules as
columns, which later tasks read.

A working table is a named chain of operators. Each rule is a column (or a
row screen) that a task adds, and the name always means the table with every
current column:

| command | effect |
|---|---|
| `add column orders.slow: <expression or Python>` | the rule becomes a column of `orders` |
| `update column orders.slow: <definition>` | the rule changes in place; everything that reads `orders` recomputes |
| `fork column orders.expensive from task 5 as expensive_t5` | the task-5 rule sits next to the current one |

Under the hood, each column is an operator in the chain. So it is saved with
every answered task, and it can be inspected, forked or restored like any
other operator. Answers come from small leaf operators off the working table.
The answer action gets a `top N by column` option, so tables that hold state
never need to be cut down to an answer.

In the restaurants session this would look like:

| task | what the agent writes |
|---|---|
| 1 | the cleaned `orders` table; columns `slow`, `expensive`, `rating_silent`, `repeat_exposed`; `pressure_rows` (rows with at least five orders, and their score); answer: top ten by score |
| 2 | `update column orders.slow` to the top quartile within each day category |
| 4 | `add column orders.covered` (the restaurant has at least ten cleaned orders), which `pressure_rows` applies |
| 5 | a relaxed variant of `covered`, for the comparison; the strict one stays current |
| 6 | `update column orders.expensive` to the top quartile within each cuisine |
| 7 | `fork column orders.expensive from task 5 as expensive_market`, for the market-wide comparison |
| 8 | a leaf off `pressure_rows` for the low-volume cuisines; every current rule, coverage included, already applies |

This is where the dataflow should beat a script:
- **Changes propagate.** When `slow` changes, everything downstream
  recomputes on its own. A script agent has to remember which frames went
  stale.
- **Rules can't drift.** Each rule is written once.
- **Rule changes are small.** A change is one line, not a new function.

The multi-task part of the system prompt, and its examples, get rewritten
around this pattern. We are adding commands rather than more instructions
because the prompt already tells the agent to build on earlier tables and
update them in place, and it did so on only 7 of 164 tasks. The existing fork
and restore commands stay; with rules as separate operators, they finally
have something to act on.

Open design questions:

- **Several working tables per session.** The Los Angeles session has a
  roster and parsed bulletins. Tables can also be derived from one another:
  `pressure_rows` aggregates `orders`.
- **Row screens.** Either a boolean column that leaves filter on, or a
  separate `add filter` command.
- **Rules within groups.** "Top quartile within each day" needs window
  functions in expressions, or a short Python column function.
- **Display.** Receipts and the catalog would show each column with the task
  that set it and its current definition.

### 2. Drop answered tasks from the context

Once a task is answered, its calls and receipts leave the context. Its
catalog entry stays: the request, the operators it created or changed with
their definitions, result shapes, and the answer. Details are one `inspect`
away. The cut falls at a task boundary, so everything before it stays an
identical prefix and the prompt cache keeps working.

A late call would then carry the system prompt plus about 0.5k tokens per
earlier task, instead of about 3k.
- **Cost estimate.** By rough estimate, this alone takes the run from $1.09
  to about $0.75. Most of the rest of the gap to DSGym is output and uncached
  input, which the working table should shrink.
- **Earlier evidence.** In September, keeping only the catalog matched
  full-history accuracy at 2.7 times less cost on the native multi-task runs.
- **Known risk.** A convention may be stated once, in an early receipt. In
  one LongDS session (university rankings), full history recovered such a
  convention and the catalog did not.

### 3. Measurement

1. **Two-session check.** Build changes 1 and 2 together and run them on
   restaurants and Los Angeles, one rep, for under a dollar. Count:
   - the turns that change a rule with an in-place column update;
   - the code written per task;
   - accuracy.

   Go on if at least half of the rule changes land as in-place updates and
   code per task falls by at least a third. Otherwise, find out why before
   building more.
2. **Three reps.** Run three reps of the new arm and of DSGym on the five
   sessions, about $5 in all, and report results by turn type.
3. **Judge audit.** Before reporting the comparison, audit the turns where
   both agents give the same values but get different scores.

## Evidence

- **Runs:**
  - `benchmark/longds/system_scratch/LongDS_LongDSObservationFormatLunaForkLedger`
    (this worktree);
  - `LongDS_DsgymShared_20261003_dsgym-shared_luna_t1` (the state-registry
    worktree);
  - the 09-26 and 09-27 baselines, archived as `<SUT>.tar.zst` in the main
    checkout's `benchmark/longds/system_scratch`.
- **Scripts,** in `logs/obsfmt/analysis/`:
  - `fork_analysis.py`: accuracy by turn type, cost, and state actions;
  - `reuse_study.py`: what each turn read;
  - `structure_study.py`: the tables in "Where the gap is" and "The cause",
    and prompt sizes;
  - `retype_study.py`: code volume and repeated lines.
