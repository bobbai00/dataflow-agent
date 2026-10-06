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

# Saved versions and references: the simplified state model (2026-10-06)

This document records the decisions of 2026-10-05/06 on how the dataflow
agent handles state across tasks, the system-prompt text that teaches it, the
two context policies it runs under, and the work list. It supersedes the
state-related parts of
[prototype-adjustments-2026-10-05.md](prototype-adjustments-2026-10-05.md)
(sections 3 and 4) and the fork material in
[prior-task-operator-catalog-design.md](prior-task-operator-catalog-design.md).
The evaluation plan (four state checks, cohorts, decision rules) stays where
it is in the adjustments document.

## 1. Decisions

1. **Every answered task is a save point.** When a task is answered, the
   dataflow as it stands is sealed under that task's number. Every operator
   with a completed result becomes a version. Nothing inside a task is
   publicly addressable by task number. Sealed definitions never change; retained
   results can become unavailable after cleanup or eviction, which must be reported.
2. **One addressing rule: `operator@N`.** `scores` is the current operator;
   `scores@2` is the version saved at the end of task 2, with the definition,
   inputs and result it had then. References are accepted as edge sources, reads, answer sources and sources
   of definition-copy commands. Edit targets and execution targets remain current IDs.
3. **References replace ancestor-copy forks, while editable variants remain.**
   Reading `scores@2` or connecting it as an input uses the exact saved result.
   `create operator variant from scores@2` copies one definition with saved
   direct inputs; the variant can be edited and rewired. Ancestors are result
   handles, not recursively copied operators. Low observed fork-edit usage is
   a reason to simplify names, not evidence that editing old computations is unnecessary.
4. **One read action.** `inspect operator` and `retrieve` merge into `read`:
   definition, inputs, result shape and columns, plus rows in the chosen view.
   `inspect graph`, `inspect task` and the version list go. Evidence: graph
   inspection 25 uses in 595 Luna turns; the version list 0; `inspect task`
   154 calls in 60 Terra turns, 56% repeating a task already fetched, 12–14k
   characters each, fetching what the catalog entries now carry.
5. **`diff` is an operator.** Two tables in, one row per explicit key out,
   with status and per-column old, new and delta. The prior wording audit
   counted comparison language in 494 of 777 Lite turns (64%). This is a
   candidate-selection heuristic, not a claim that one diff solves those turns.
6. **Returning to a rule is an update:** `update operator scores from
   scores@2` puts the task-2 definition on today's inputs. Not called
   "restore": the prior wording audit reported 141 turns labelled Counterfactual + Rollback using
   "restore" or "revisit" to mean *for this comparison only*, and a verb with
   that name would invite the leakage we measure.
7. **The boundary is explicit.** The answer receipt lists what the task saved
   and how to reference it. That receipt is the catalog entry; there is one
   record, rendered once.
8. **Context policy is a separate axis.** Earlier tasks reach the model either
   as their full ReAct transcript (trajectory) or as sealed catalog entries
   (catalog). Both receive the same boundary records and use the same
   references; the state model does not depend on which is chosen. Retention and
   context reduction must be measured separately.
9. **Answers declare their sources,** and `answer from` can cut a table
   (`top N by column`), so reports stop being operators.

## 2. The state model

### 2.1 Save points

A task's save point is the moment the answer is accepted. The sealed record
holds, for every operator in the graph: its definition, its inputs, its
revision, and its result version (row count, schema, profile, and the
materialization the engine holds for it). Operators whose result at that
moment failed or never ran are recorded as such and can still be read with `view: null`. They cannot supply records or an
input table at that save point.

Only end-of-task versions exist. An operator created and revised three times
within task 4 has one version, `x@4`. An operator unchanged since task 3 is
addressable as `x@3`, `x@4`, `x@5` …; these are the same version, and the
catalog says in which task it last changed.

### 2.2 References

`x@N` denotes the version of `x` saved at the end of task N. Semantics:

- As an **edge source** (`create edge scores@2.out -> shift.in[0]`): the
  consumer reads the exact saved materialization. The reference has no
  upstream execution. If the materialization was not retained or was evicted,
  the action fails with `HISTORICAL_RESULT_UNAVAILABLE`. Recomputing old code
  against today's files would produce a different state and is never a fallback.
- In a **read** (`read scores@2 view=full`): the saved block and records,
  with bounded coverage labelled. `view: null` reads the definition without data.
- In an **answer** (`answer from scores@2 top 5 by score`): composed from the
  saved table; the source recorded is `scores@2`.
- In a **definition update** (`update operator scores from scores@2`): the
  old definition on today's input connections; see 2.4.
- In an **editable branch** (`create operator variant from scores@2`): one
  new operator with the old definition and saved direct input tables. Edit the
  variant for a temporary scenario, or explicitly rewire it to current inputs.

A reference never changes a default rule, never executes on its own, and
cannot be edited. Connecting it adds a hidden read-only result handle to the
graph; receipts and catalog inputs display the original `operator@task` address. `scores@7` when `scores` had no completed result at the end
of task 7 is refused with the reason; it is never substituted or recomputed
silently.

### 2.3 What "current" means

The current graph is what edits act on and what execute computes. Each
save point freezes a copy of it; the current graph moves on. A task that
changes nothing still produces a save point (its versions equal the previous
ones).

### 2.4 Reapply a definition or create an editable branch

`update operator scores from scores@2` makes the definition `scores` had at
the end of task 2 its current definition. Inputs are today's. Consumers are
invalidated and recompute on the next execute. The receipt names inputs whose
version differs from what they were at task 2, because the recomputed table
is the old rule on today's data, which is usually what "return to the stricter
screen" means and is not the task-2 table. For the task-2 table itself, use
the reference.

An editable branch differs from that update:

```
create operator variant from scores@2
update operator variant: aggregate(by=["market"], score=mean("value"))
```

Its inputs initially refer to the direct input results saved with `scores@2`.
The current `scores` and its consumers stay unchanged. If an old input lacks a
completed retained result, branch creation or execution fails clearly; a
failed old definition can nevertheless be inspected with `view: null` and
reimplemented explicitly on available inputs.

### 2.5 Retention in the engine

The ordinary port cache invalidates superseded results and uses identity-bound
fingerprints. The agent's graph hash is also identity-bound; it is not an
existing content-addressed proof that can simply replace the engine hash.

The first implementation uses **exact producer references**, scoped to one
workflow: original execution, logical operator, output port and result URI.
At an accepted answer, completed results receive retained aliases. A saved
input binds that exact table to one zero-input read-only handle. No copied
ancestor graph and no cross-operator content-hash lookup are needed.

Cache cleanup deletes metadata first and clears a result table only when no
remaining alias references its URI. Session/workflow teardown removes the
retained aliases and their unreferenced tables. Reads pin pagination to one
materialization; a missing table is an error rather than a recomputation.

A content-addressed cache, byte accounting and LRU policy are separate future
engine work. Hashing must account for external file changes, runtime settings,
non-deterministic processes, ordered ports and authorization before enabling
broader reuse. For this bounded pilot, retention has no implemented byte cap;
record storage use and clean up owned workflows. Do not call references
"free": they avoid upstream recomputation but still require result I/O,
consumer computation and model tokens.

## 3. Actions

### 3.1 After the change

| action | arguments | effect |
|---|---|---|
| `edit` | `changes` | graph commands, atomic: `create operator id: <definition>`, `update operator id: <definition>`, `delete operator id`, `create edge a.out -> b.in[k]`, `delete edge …`, `update operator id from source@N`, `create operator variant from source@N` |
| `execute` | `operator_ids` | compute the named operators and their ancestors, reusing valid results; receipts say `executed` or `cached` per operator |
| `read` | `operator_ids` (IDs or `id@N`), `view` (`null` for definitions only; otherwise available `sample`, `sample_stats`, `full`), `columns`, `include_implementation` | the operator block (definition, inputs, result shape, columns, scope notes) and rows in the view; never executes |
| `answer` | `from` or `content` + `operator_ids` | ends the task; see 3.3 |

The new public protocol does not advertise `fork` (action or edit command),
`inspect graph`, `inspect task`,
`inspect state` and its version list, `retrieve` (folded into `read`),
`inspect operator` (folded into `read`). Older receipts can still be imported
through an internal compatibility path. `inspect reference` (on-demand
operator docs) is unaffected and stays off by default. Single-task sessions
keep unscoped graph inspection; this document covers multi-task sessions.

### 3.2 `diff`

```
create operator shift: diff(key=["market"], columns=["score", "rank"])
create edge scores@5.out -> shift.in[0]
create edge scores.out    -> shift.in[1]
```

Left is the earlier version, right the current one. Output: the key columns,
`status` (`added` right-only, `removed` left-only, `changed`; `same` only with
`include_same=True`), and for each listed column `score_left`, `score_right`,
`score_delta` (right − left; null for non-numeric or unmatched rows) and
`score_abs_delta`. Keys must be explicit, unique and non-null on both sides;
they are never inferred. Duplicate keys, incompatible types and output-name
collisions are refused rather than matched arbitrarily. Flow line in the receipt:
`diff: 15 keys; 2 added, 1 removed, 9 changed, 3 same`. The usual answers
are one cut away: `answer from shift top 5 by score_abs_delta`, or the
`added` and `removed` rows for "which markets enter and leave".

### 3.3 `answer`

`from` composes the answer from a table: `scores[market, score:3] top 5 by
score desc, market asc` (primary descending by default; explicit secondary
ordering). Sorting uses unrounded values and never guesses a tie-breaker
from the projection or physical table order. If the specified ordering still
leaves an ambiguous tie across the cut, the answer is refused; add the key
required by the question or express the requested tie-inclusive selection in
the graph. Parts joined with `;` give one key each. The recorded
source is the full table. The complete table is read through the engine's
result pagination, up to a ceiling above which the answer is refused with
"sort and limit in the graph"; no hidden operators.

`content` is for shapes `from` cannot express. In multi-task sessions it
requires `operator_ids`, the completed tables the answer rests on, or `[]`
when it rests on none. An answer without them is rejected with that one line.

### 3.4 The boundary receipt

The receipt of an accepted answer is the task's catalog entry: the operators
the task created or changed, each as an operator block, followed by what was
saved:

```
### 3. answer: ok
#### Task 7 saved
- **entropy_metrics** (process, created) — `entropy_metrics@7`, 15 rows × 12 columns
- **entropy_movement** (process, created) — answer source — `entropy_movement@7`, 15 rows × 5 columns
- **draft_scores** (process, created) — definition saved; result unavailable
Answer sources: `entropy_movement@7`
```

The internal save point records the complete graph, but the visible boundary
contains the **full chronological operator delta**: every operator created or
modified during that task, its final definition in first-edit order, plus
separate deletions. Non-answer working tables remain included. Unchanged
operators are not relisted at every task; their input references or earlier
entries identify them. Sources from an earlier task appear explicitly even
when this task made no edits. The illustrative bullets above are not a second
renderer: implementation reuses the canonical Markdown operator blocks.

Statistics and record snippets are independent settings, both off by default.
Rows are bounded observations already retrieved by the task, not the whole
execution result. Result shape and column types stay available. Definitions
and saved addresses are immutable; availability can later change through
cleanup. The catalog never executes just to fill a block.

Under catalog context, this frozen boundary is reused verbatim with the original
request. Under trajectory context, it is the last receipt in the task's raw
ReAct frames. This gives a stable prefix, not a guarantee of provider cache hits.

## 4. Two context policies, one mechanism

The state model is the vertical axis; how earlier tasks reach the model is
the horizontal one. Both policies get the same system prompt except for one
paragraph, the same tool, the same boundary receipts and the same
references.

| | trajectory (ordinary ReAct across tasks) | catalog |
|---|---|---|
| earlier tasks appear as | their full ReAct frames: every call and receipt, ending with the boundary receipt | one sealed entry per task: request, operator blocks, saved list, answer, sources |
| current task | raw ReAct frames | raw ReAct frames |
| what the model does to find a version | scrolls the transcript | reads the entry of the task that introduced the rule |
| context size | measure actual serialized input and billed/cache tokens | measure the same; no fixed token estimate |
| cache | append-only; one cold tail per task | append-only; sealed entries never change; the first boundary moves the prefix once |
| setting | `taskContext: trajectory` | `taskContext: dependencies`; compact variant is separate future work |

A future catalog variant may add a short footer after the sealed entries, one
line per live operator (`id kind rows × cols, last changed task N`), rebuilt
at each boundary. It replaces what `inspect graph` used to answer. It is a
setting, to be measured like the rest.

The experiment grid is therefore: state mechanism (fixed) × context policy
(trajectory, catalog) × agent (dataflow, Python with the equivalent catalog)
× model (Luna, Terra). Python keeps one persistent kernel and may retain
copies freely; it gets its own task/script catalog or raw trajectory, without
forced overwriting or injected reference state. No token cap or compaction.
Which policy wins, and whether saved references are actually used, are results.
Historic measurements from other configurations are not estimates for this one.

## 5. System prompt

The multi-task material replaces `native-multi-task.md`,
`native-state-history.md` and the earlier multi-task examples. Measure the rendered multi-task text
rather than treating a target character count as an experimental result. The single-task prompt is unchanged.

### 5.1 Tool text (multi-task sessions)

```
Actions run in order within one call.

- edit: apply the graph commands in `changes`, atomically. Commands: create,
  update and delete operator; create and delete edge; `update operator X from
  X@N` to make the definition X had at the end of task N current again.
- execute: compute the named operators and their ancestors, reusing results
  that are still valid. Receipts say which operators executed and which were
  served from cache.
- read: an operator's definition, inputs, result shape and columns, with rows
  in the chosen view (sample, sample_stats, full; `columns` restricts them).
  `scores` reads the current operator, `scores@2` the version saved at the
  end of task 2. `view: null` reads definitions without data, including failed
  operators. Several IDs per call. Reading never executes.
- answer: compose the answer from a table with `from` (projection, `top N by
  column`, parts joined by `;`), or give `content` and name the tables it
  rests on in `operator_ids`. Ends the task.

Source references may carry `@N`: as an edge source, in a read, in an answer
source, or as the source of a definition-copy command. Targets remain current IDs. A reference reads the saved version and never
changes the current graph.
```

### 5.2 Earlier tasks and saved versions

```
### Earlier tasks and saved versions

The dataflow persists across tasks. Each request is a task, numbered from 1.
When you answer, the dataflow as it stands is saved under that task's number:
every operator with a completed result becomes a version you can refer to
later as `operator@N`. The receipt of your answer lists what was saved.
Saved definitions never change; task 9 can return to task 3, and task
12 can return to task 9. Retained results can become unavailable after cleanup
or eviction; a missing result is reported, never silently recomputed.

`scores` names the current operator. `scores@2` names the version saved at
the end of task 2: its definition, its inputs as they were then, and its
result. A version can be read, connected as an input, answered from, or made
current again. It cannot be edited. Using a version never executes anything
by itself and never changes the current graph.

{{#catalog}}
Earlier tasks appear under `# Prior Tasks`: each task's request, the
operators it created or changed, what it saved, its answer and the tables the
answer rested on. Earlier answers are the earlier agent's output, not verified
facts; read a definition before relying on it.
{{/catalog}}
{{^catalog}}
Earlier tasks appear above in full, each ending with the receipt that lists
what it saved.
{{/catalog}}

A session revises its rules as it goes. Read each request for which of three
things it asks, and spell each the same way every time.

- **A rule changes from here on.** `update operator scores: <new definition>`.
  Everything built on `scores` recomputes on the next execute, so later tasks
  read the revised rule without further work. The old version stays saved.
  Do not build a second copy beside it.
- **An alternative applies to this question only.** Build the variant beside
  the current operator, reading the current or saved inputs it needs, and
  answer from the variant. Leave the default operators untouched; the next
  task continues from them.
- **The request names an earlier version** ("the strict screen", "the
  first-pass scores", "before the penalty"). Find the task that introduced
  that rule among the earlier tasks, then use the version directly: read
  `scores@2`, connect `scores@2` as an input, or `diff` it against the
  current table. When the session returns to that rule for what follows,
  `update operator scores from scores@2`: the task-2 definition becomes
  current on today's inputs, and the receipt names inputs that changed since
  then.

Never retype an earlier rule or its numbers from memory; the saved version is
one reference away.

Name rules the way requests will refer to them. An operator's `doc` is how a
later task recognizes a version, so write it as the rule it implements
("markets with at least ten cleaned orders"), not as a step ("filter rows").

Keep the table that holds every unit under the current rules apart from the
table that reports a selection of it. Rank and cut in the answer
(`from: "scores top 5 by score"`) or in a downstream operator, never inside
the operator that computes the scores; a later task that needs all units, or
a different cut, then has them. A process that returns a selection hides the
rest.

Before connecting an earlier table, read its definition and shape: is it
every qualifying row, an earlier answer's selection, or an older version of
the rule? When the request concerns a selection, keep it; when it concerns
every row, connect the table before the cut.

To compare two versions, `diff(key=[...], columns=[...])` takes the earlier
version on its first input and the current table on its second, and returns
one row per key with `status` (added, removed, changed) and each column's
old value, new value and delta. Answer from it with a cut:
`from: "shift top 5 by score_abs_delta"`.

Declare what an answer rests on. `answer` with `from` records its source
table; a free-text answer names its tables in `operator_ids`. Later tasks
start from those tables.
```

### 5.3 The example session

One five-task session on the existing toy fixture (24 orders across eight
units), receipts generated from the live engine as the current examples are.
Each task shows the call, the receipt lines the model must read, and the
boundary receipt.

1. **Build.** Scan `orders`, filter `eligible` to delivered orders, and aggregate
   a complete per-unit `scores`. Read it, then answer from
   `scores[unit, amount:2] top 3 by amount desc, unit asc`.
2. **Permanent change.** Update `eligible` to all positive-amount orders.
   Execute `scores`; the original values remain accessible as `scores@1`.
3. **Temporary alternative.** `create operator variant from scores@1`, then
   change the variant's aggregation to a mean. Its input remains `eligible@1`.
   Execute and answer from the variant; the default remains task 2's rule.
4. **Comparison.** Feed `scores@1` and current `scores` into an explicitly keyed
   `diff`. Only the comparison and stale current computations execute; the
   historical score ancestors do not. Specify `unit asc` as the secondary key
   when cutting by `amount_abs_delta`.
5. **Old rule, current data.** `update operator eligible from eligible@1`,
   execute `scores`, and answer from it. If the input file or its definition
   changed, this is a new result; `scores@1` continues to mean the original one.

Actual receipt counts must come from the executed fixture, not prose examples.
The fixture must also verify a missing retained table fails clearly.

## 6. What the scorer needs from these receipts

The four state checks (wrong-version, stale-rule, leakage, state match) combine
the benchmark's dependency annotations with evaluator-only keyed table
anchors. Merely declaring a source or reading an old state is not evidence of
using the correct version. Report unknown coverage separately from errors.
They read:
declared answer sources with their versions; `@N` references on edges, which
make version selection explicit; the boundary record's list of saved versions
and their result identities for state match; and `executed`/`cached` per
operator for the work metrics. Dependency precision/recall must distinguish
declared roots, observed reads and the transitive graph closure; scripts have
no automatic graph proof, so do not equate a read-variable count with lineage. These declarations record provenance, not whether the answer is correct.

## 7. Work list

Ordered by dependency. Core implementation has acceptance tests before the
separate bounded paid pilot at the end.

| # | work | acceptance |
|---|---|---|
| 1 | Planner: parse `id@N` in edges, reads, answers and restores; validate exact data availability separately from definition availability; bind one result handle; support editable definition copies; render historical addresses | unit tests: valid and refused references, restore drift note, byte-identical receipts across reruns; live fixture: a join over `scores@2` executes zero historical ancestors; changing the raw file cannot change saved values; unavailable results fail |
| 2 | `read` action replacing `inspect operator` and `retrieve`; lists of IDs; `include_implementation`; `columns` | unit tests; TOOLS.md regenerated |
| 3 | Remove `fork`, `inspect graph` (multi-task), `inspect task`, `inspect state`; remove their public prompt/schema paths; retain archived replay tests | suite green; references regenerated; new public actions validate; archived fixtures still replay |
| 4 | `diff` operator in the catalog and `runtime.py`; receipt flow line | pytest on added/removed/changed/same, nulls, explicit key refusal, large integers and overflow; live fixture task 4 |
| 5 | `answer from … top N by column`; pagination client; required `operator_ids` on `content` in multi-task sessions | unit tests for ties, rounding, ceiling, refusal text |
| 6 | Boundary receipt = frozen catalog entry; complete chronological deltas, answer selections and historical input addresses | render test on the Netflix prefix import; size recorded |
| 7 | Prompt and example session (5.1–5.3); prompt-matrix test; references regenerated | 400-combination test; example executes live |
| 8 | Catalog footer (optional, setting) | render test; size delta |
| 9 | Engine: exact producer retention and input bindings; shared-URI-safe cleanup; pinned pagination | Scala tests; live fixture from item 1 reports `cached` for a reference after an in-place update |
| 10 | Harness: paths-only inventory, agent-driven data discovery; v1.1 Lite selection; ordinary persistent Python with equivalent catalog/trajectory policies; observer captures | preflight prints the inventory; one dry run per arm |
| 11 | Scorer: the four checks with their three validation runs | gold replay scores 0 errors; skipped-Update replay scores 100% stale; renamed columns align |
| 12 | Day-0 scoring of existing traces; then a small predeclared v1.1 Lite pilot on Terra and Luna, no automatic expansion | numbers in `validation.md` |

These are acceptance criteria, not completion claims. Mock execution tests do
not verify retained materializations: run live engine fixtures before paid
pilot calls. Report model cost separately from replay/setup time. Freeze the
actual source-tree identity and arm settings, rather than only the base commit.

## 8. Decided against

- A `save` or `tag` action: the reference solutions never save; they do not
  overwrite. The boundary does the saving.
- `restore` as a verb: see decision 6.
- Named versions beyond the task number: the `doc` is the name, the task
  number is the address, and the catalog links them.
- Within-task versions: the gold has no such concept and no request asks for
  one.
- A separate "state diff" operator: the per-task entries are that diff.

## 9. Review and verification status

The original draft conflated an exact historical table with rerunning an old
rule against current files. That changes values and is not state recovery.
The revised contract above separates exact reads, definition updates and
editable variants, requires explicit comparison keys and selection tie-breakers,
and starts with exact retained producers rather than a general cache rewrite.

A five-task live engine fixture on 2026-10-06 used no model calls and verified:

- an in-place rule update changed the default while the old table stayed readable;
- a keyed diff consumed the old table as a cached input;
- an editable variant executed one new operator and one cached old direct input,
  without copying or executing historical ancestors;
- applying the old rule to a changed source produced new current values while
  reading the old scores still returned the original values;
- the first task's sealed catalog record stayed identical at the fifth task.

The fixture caught a result-lookup bug: a cached handle is registered under a
new output-port ID but retains the original producer URI. Lookup now matches
the registered port; its URI remains the original table. Regression coverage
is in HistoricalResultServiceSpec. The latest HistoricalResultService and
StructuredResultTransport checks passed 18 tests; earlier fingerprint checks
also passed. The Python runtime suites passed 49 tests; the complete agent
suite passed 1,444 tests, with typechecking and generated references current.
Full observer pagination also caught and fixed a small-integer JSON row-count
deserialization error. These checks establish the tested mechanics, not
benchmark accuracy or savings.

Local artifacts: `/var/tmp/lean-versions-live-check-6/verification.json` and
its RPC responses and frozen captures. The migrated live suites
`task-context-run`, `observation-format-run` and `history-retention-run` also
passed. A deliberate eviction check confirmed that a saved input reports
`HISTORICAL_RESULT_UNAVAILABLE` without rebuilding its ancestors. The private
reference gate reproduced all eight selected Lite answers (earthquake Q1–Q5,
university rankings Q1–Q3).

The bounded Terra/Luna pilot is complete: **64/64 answers and judgments** over
catalog/trajectory and Dataflow/ordinary persistent Python. Seven arms score
4/8, while Terra Dataflow trajectory scores 3/8. Dataflow costs 1.59–2.05 times
Python within the same model and context policy. The model-cost estimate is
$1.34 for solvers plus $0.45 for judging; no additional paid runs followed.
Actual trace checks confirm all 32 chronological task deltas and 52 later
comparisons of immutable saved records and canonical boundary content. The
pilot establishes neither an accuracy nor a cost advantage.

The [pilot report](../../benchmark/longds/reports/saved-versions-lite-pilot-20261006.md)
records the frozen source, exact costs, judge sensitivity, wrong-stage selection,
working-table checks and coverage. It distinguishes the paid solver revision
from post-run evaluator corrections and a regression-tested diagnostic fix
for invalid result projections. Statistics and snippets remain independent
catalog opt-ins and are off in this pilot. No scaling is recommended yet.

### 2026-10-06 audit of 9db5efcfa and the fixes that followed

The bounded pilot could not test the mechanism: no `@N` reference in any of
its 64 answers pointed at a version that differed from the current table, so
the only discriminating question was earthquake Q4, and the judge model was
not the paper's. A full read of the traces and the implementation found the
mechanism close to the design with these defects, all fixed the same day
(agent suite 1,449 tests, taxonomy pytest 112, references regenerated):

- Live edits in a saved-versions session accepted the retired `fork … as …`
  and `update … from task N`; they now fail with the `@N` form to use, and
  only recorded traces replay them (`legacyVersionCommands`).
- A saved-result handle could be deleted by its hidden ID, and a handle whose
  consumer or edge was deleted stayed in the graph; both fixed in the planner.
- Retention was silent: a session without an engine connection, or an engine
  `retain` failure, sealed the task as if its results were saved. The boundary
  receipt now carries `Retention: RETENTION_UNAVAILABLE …` or
  `RETENTION_FAILED …`, and the agent logs the failure.
- `diff` could never raise `DIFF_COLUMNS` for a key listed as a value column
  (the collision check ran first); the order is fixed and the taxonomy test
  covers the three `DIFF_*` codes.
- Tool text still described forks and `retrieve`; the saved-mode `edit` text
  did not mention `update X from X@N`, `create V from X@N` or `X@N.out`; the
  `answer from` text omitted `top N by column`; the inspect validator named
  targets that do not exist in saved mode; the operator_ids error suggested
  answering without sources. All rewritten.
- The boundary receipt did not say what was saved. Each changed block now
  ends with ``saved as `id@N` `` or `saved: no completed result`, and a
  `Saved versions:` line lists the task's versions and the unchanged ones
  still readable (capped at twelve names).
- A batched `read` with `columns` failed when any table lacked any column and
  paged before validating; it now keeps each table's present columns, notes
  the missing ones, and errors only for a table with none of them.
- The tie refusal suggested a column from the example data (`market asc`);
  it now names a column that identifies the rows when one exists.
- Prompt sections 5.1–5.2 are implemented in `native-multi-task.md` and
  `native-state-history.md` (rendered history prompt 4.8k words).

Still open from the work list: the live example session (5.3) regenerated
from the engine, the catalog footer (item 8), the scorer's four checks (item
11), and the Q4 verdict note in the pilot report. The predeclared run that
follows (Netflix task 2, Kiva task 1, water task 1; dataflow and Python, both
with the catalog policy; Terra and Luna; one rep; the paper's DeepSeek judge
through OpenRouter) measures, before anything else, how many `@N` references
point at versions that differ from the current table.
