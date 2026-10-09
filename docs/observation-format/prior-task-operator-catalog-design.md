<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements. See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership. The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied. See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Prior-task operator catalog and smaller process operators

Date: 2026-10-05.

This document specifies the proposed task catalog and process-authoring
guidance. The agent continues to use ordinary ReAct with
`inspect`, `edit`, `execute`, `retrieve` and `answer`. Earlier tasks are
represented by saved task records; the current task keeps its own ReAct
trajectory. The design does not introduce an analytical ledger, input token
cap, automatic compaction or a new planning protocol.

**Implementation status:** implemented locally and awaiting code review. The
shared native prompt contains the smaller-process guidance and tested sensor
example below. Prior tasks use canonical operator blocks with Python bodies on
demand, answer-source markers, saved-version labels, separate deletions and
collapsed unchanged fork ancestors. No table renderer or new ledger is added.
Completed records are frozen in their existing endpoint snapshots and preserved
in exported action traces. Local deterministic verification does not measure
provider cache hits, benchmark accuracy or paid-run cost; no new pilots are
started by this change.

## 1. Purpose

At a new task, the model should be able to identify useful earlier work from
its actual definitions, connections and output metadata. It should retrieve
the relevant saved computation, decide whether its rules and inputs fit the
new request, and then reuse, revise or fork it.

The catalog should answer four questions without a discovery call:

1. What did this earlier task add or change?
2. What does each operator compute, and which tables does it consume?
3. What output was available when the task finished?
4. Which outputs supported the answer, and which earlier tasks supplied inputs?

It is an index into saved computations. Earlier answers, operator descriptions
and dependency links are evidence to examine, not guarantees of correctness.

## 2. What the existing pilot tells us

The Terra-generated prefix for LongDS v1.1 Lite
`business/netflix_movies_and_tv_shows/task3`, through Q27, has:

| Scope | Process operators | All operators | Process share |
| --- | ---: | ---: | ---: |
| Saved graph at Q27, including fork-created operators | 106 | 166 | 63.9% |
| Operators not created by forking | 37 | 70 | 52.9% |
| Operators added for Q7, including its forks | 7 | 9 | 77.8% |

Q7 authored two new process operators and forked seven existing operators.
Its nine declarations contain approximately 1,100 characters; their Python
bodies contain approximately 10,800 characters. These are character counts,
not token counts or a cost estimate. They show why a short catalog estimate
cannot assume full Python bodies are inexpensive.

These counts describe one prefix, not the whole benchmark. Process share is
not a quality score: a short custom statistic can be an appropriate process.
The important questions are whether an operator combines independently
changing rules and whether reusable intermediate tables are exposed as outputs.

The [existing pilot report](../../benchmark/longds/reports/state-management-pilot-20261005.md)
also records a process that computed a complete working table internally but
returned only a limited report. Historical retrieval cannot recover a local
DataFrame that was never published as an operator output.

## 3. Context at the start of a task

The model receives the system prompt, available tool schema, prior-task
records in task order, and the current request. During the task, normal ReAct
calls and observations append after that starting context.

Each prior-task record contains:

- Task number and completion status.
- The original public question and any supplied public context.
- A chronological sequence of operator blocks changed while solving the task,
  with unchanged fork ancestors represented by a compact source reference.
- The agent-generated answer, visibly clipped when necessary; inspection
  returns the original.
- Observed earlier-task dependencies and declared answer sources.
- A compact deletion section when applicable.

Previous reasoning and execution trajectories are retrieved when needed
instead of included automatically. This is the explicit task-boundary context
policy, not an LLM-written summary of a long transcript.

Completed task records refer to their saved endpoint snapshots. Later edits
must not change earlier definitions, metadata or answers. The catalog freezes
the representation, statistics choice and retained record text at answer time;
later display settings apply to new tasks without rewriting earlier blocks.
Earlier frames remain byte-identical as new tasks are appended. This supports
prefix caching; actual cache hits depend on the provider and request
serialization and must be measured.

Incomplete tasks remain clearly labelled. They must not acquire a fabricated
answer or claim completed historical results. Historical computation tools
operate on the completed snapshots the runtime actually supports.

## 4. Catalog operator blocks

Each task is a Markdown section. Within it, reuse the canonical operator block
from receipts and detailed inspection. This keeps one representation for an
operator rather than introducing a catalog-specific six-column table.

The header puts the action near the front:

```text
- **operator_id** (kind, action) — answer source
  - definition: <actual native declaration and parameters>
  - inputs: <ordered input ports and operator IDs, with saved-task references>
  - result: <saved availability, rows and columns>
  - columns: <ordered names and types; explicit omitted-column count>
  - note: <compact statistics or limited/empty/one-row information, when applicable>
```

Show the answer-source marker only for a declared source. A process declaration
contains its function signature and accurate `doc`; its complete authored
Python stays on demand. Statistics are optional, identify their coverage and
do not include automatic sample records. The task heading supplies the saved
checkpoint for these blocks; keep explicit version labels on input, origin and
answer-source references. Unavailable fields are omitted or explicitly labelled
according to the observation contract.

Reuse `describeOperator` and `operatorBlock` and their existing field ordering,
with small additions for answer-source and fork-summary information. Keep
`stateLedger: false`; reusing formatting does not enable a ledger.

### Scope and ordering

Include every successfully created or changed operator, even when it is not
an ancestor of the final answer. A useful exploratory or working table can
be relevant to a later task. Mark answer sources to distinguish the computation
that actually supported the answer.

Use first committed edit order within the task. Repeated edits produce one
block with the final definition saved at the task endpoint. An operator created
and then updated remains `created`; a fork subsequently changed should show
both its saved origin and that it was updated. Detailed attempts remain in
the original trace.

Chronological edit order is not necessarily dependency order. The inputs field
supplies explicit graph lineage. When one fork command creates several
operators simultaneously, use deterministic input-before-consumer order within
that command's group, and preserve the command's position among other edits.

Do not recursively expand unchanged upstream graphs into each entry. Reference
their saved owners. For a fork, show the fork root and summarize its unchanged
copied ancestors beneath it. Keep the full operator-ID mapping and definitions
available through inspection and the original receipt.

For example, Q7's `fractional_prior` fork root can carry a note that it copies
six unchanged upstream operators from the saved task-5 branch, with the actual
`fractional_prior__` naming prefix. Q7 then has three main blocks: that fork
root and its two newly authored processes. The recorded origin is task 5;
older task numbers embedded in ancestor names are not the saved source address.

Collapse only copies whose definitions and mapped upstream dependencies still
match the recorded fork. Preserve the exact source task, root and mapping from
stored facts, not a name-based guess. A copy changed or rewired after the fork,
or affected by a changed copied ancestor, must remain visible as changed work.
An ancestor explicitly used as an answer source should also retain its block.
Keep exact input IDs where a new operator connects to a copied ancestor, even
when that ancestor's own block is collapsed. Inspection must make the copied
inputs and mapping discoverable from the displayed fork root.

Put deletions in a separate, short section containing the actual ID and the
deletion action. Deletion affects later reuse and must not disappear from the
catalog. A rejected edit adds no successful change; skipped actions add none.
Successful earlier edits remain visible if a later action fails.

### Illustrative task entry

This example uses the small sensor fixture exercised by the prompt test. Its
values are illustrative, not LongDS benchmark answers.

#### Task 1 (answered)

Question: Which two sensors have the largest median absolute deviation?

- **readings** (scan, created)
  - definition: `scan("data/sensor_readings.csv")`
  - result: 8 rows × 2 columns
  - columns: sensor str, reading float64
- **sensor_dispersion** (process, created)
  - definition: `process(fn=median_deviation, doc="One row per sensor with unscaled median absolute deviation and count n of non-null readings; mad is null when n=0")`
  - inputs: in[0] `readings`
  - result: 4 rows × 3 columns
  - columns: sensor str, mad float64, n int64
  - note: if statistics are enabled, stats full; mad null=1/4, range=0..10
- **sensor_ranked** (sort, created)
  - definition: `sort(by=[("mad", "desc"), "sensor"])`
  - inputs: in `sensor_dispersion`
  - result: 4 rows × 3 columns
  - columns: sensor str, mad float64, n int64
- **sensor_top** (limit, created) — answer source
  - definition: `limit(2)`
  - inputs: in `sensor_ranked`
  - result: 2 rows × 3 columns
  - columns: sensor str, mad float64, n int64
  - note: limited table; its parent has 4 rows

Answer: `[{"sensor":"D","mad":10},{"sensor":"A","mad":2}]`

Observed task dependencies: none recorded.

Answer sources: `sensor_top` (version at end of task 1).

The answer is the earlier agent's output. By default, no result rows are
added beneath these operator blocks. A subsequent question about all sensors should
inspect `sensor_dispersion`, not inherit `sensor_top`'s selection.

### Answers using earlier tables

Always render a separate Answer sources line, even when the task created or
changed no operators. Include the saved-task address for each declared source,
and its earlier producing/defining task when the stored provenance establishes
that distinction. Preserve the exact result/definition version internally;
an ID by itself is insufficient when that ID has been reused.

For example, a task answering directly from a saved task-1 result can say:

```text
No operators created or changed.
Answer sources: sensor_dispersion (saved version from task 1).
```

When the runtime consolidates an unchanged result into the current task's
endpoint, identify that saved endpoint and annotate its earlier origin when
known. Do not infer the producing task from the task number of a snapshot or
from an operator name. Missing declarations remain explicitly unknown.

### Definitions and code

Keep full Python bodies out of the default task catalog. The process declaration
shows its callable function and output description; task inspection can return
the complete authored function and helpers in the canonical Markdown operator
block. Native declarations are retained in full, including row functions; schema
display follows the saved receipt's column budget and labels omitted columns.
The separate authored function bodies remain on demand.

Long declarations and schemas need explicit omission labels. Use the existing
inline-code escaping and safe fenced-code rendering for detailed bodies. Never
silently present a clipped definition as complete or invent a summary of the
formula from an operator name. The saved code is authoritative; the model's
`doc` is a claim about that code to check when necessary.

IDs in the catalog must work with tools. Use an actual short `new_operator_id`
for the fork root and the runtime's returned mapping for its ancestors.
Display-only names such as `scores′` or `scores@t7` are not valid graph IDs
today. A future alias feature would need an explicit, version-aware resolver;
cosmetic abbreviation alone is insufficient.

## 5. Result metadata and statistics

Catalog construction reads saved metadata; it must never execute an operator
or start fresh profiling. Show shape and schema independently of optional
statistics. Display each result as available, stale, failed, not executed or
unavailable according to the saved state; definitions can remain inspectable
even without a result.

When `catalogStatistics: true`, include compact null counts, distinct
counts and numeric ranges from profiles that match the saved result identity
and operator revision. Preserve exact integer counts. Mark partial coverage
explicitly. Omit absent statistics; keep result availability independent of
profile availability. The result line repeats column names only when identifying
actual per-column statistics; the columns line carries the schema. Use the
existing small column/profile display budgets and state how many column
statistics were omitted. Omit the generic process-opacity scope sentence from
catalog blocks; retain concrete filter, limit and source-preview facts.

For file operators, show declared paths and recorded files read when available,
distinguishing those two facts. Preserve selected and omitted file counts when
known. A source path is not evidence that every matching file was read.

Catalog statistics and result records are independently controlled and off by
default:

```json
{"catalogStatistics": false, "catalogRecords": 0}
```

`catalogStatistics: true` enables version-matched saved profiles. `catalogRecords`
sets the maximum previously observed rows per operator; a positive value enables
rows. Only frozen observations from that task matching its final result version,
revision and upstream graph are eligible. Unobserved, stale or failed results do
not acquire rows, and row limits remain within the original observation's
character budget. A read-only task can retain its retrieved rows; an unchanged
fork copy with retained rows remains visible when records are enabled.

These settings are accepted at agent creation and through `PATCH /:id/settings`.
They apply to newly captured catalog entries. Completed entries retain their
original representation, preserving historical message prefixes. Statistical
retrieval capabilities, profile collection and execution retention are separate
controls; enabling statistical retrieval does not enable catalog statistics.
The model can discover headers and examples itself with a scan preview or result
retrieval even when both catalog options are off.
Optional flow evidence remains a separate setting. Shapes and profiles help
assess coverage and missingness, but do not prove correct filters, formulas,
denominators or rule versions.

## 6. Smaller process operators and accurate descriptions

A process should implement one coherent custom transformation with an output
that can be independently inspected, reused or revised. Boundaries follow the
meaning of the work rather than a fixed line count or one operator per column.
Related helpers for one parser, statistical calculation or model fit can stay
together.

Use predefined operators for supported loading, projections, casts, filters,
joins, ordinary aggregation, sorting and limits. Connect existing tables as
inputs to custom calculations. A source process is appropriate for parsing an
unsupported format; it should expose the parsed table for downstream work.

Separate reusable calculations from report selection. When a process computes
all groups' values, return that complete table. Apply ranking, projection and
top-k selection downstream. If a calculation revises a reusable rule, expose
that rule at an operator boundary its consumers actually share.

An accurate process `doc` should concisely state:

- The output grain, such as one row per sensor or one row for the whole input.
- The actual transformation or formula and the meaning of derived fields.
- Important assumptions, units, weighting, exclusions or missing-value behavior.

Include only applicable details. Avoid vague labels such as "analyze data" or
claims of correctness. Keep the description synchronized with changes to code
and selection rules. This is system-prompt guidance; the runtime validates
syntax and output contracts but does not automatically prove semantic agreement
between prose and Python.

### Shared system-prompt guidance

The following guidance is implemented in the shared
[native prompt template](../../agent-service/src/agent/prompts/native-mode.md),
so both single-task and multi-task sessions and both prompt-reference variants
receive it:

> Keep each process focused on one coherent custom transformation that can be
> inspected, reused or revised independently. Use separate catalog operators
> for supported file loading, ordinary filters, joins, aggregation, sorting and
> limits. Connect their tables as process inputs. Return the complete working
> table before a report's ranking or cutoff. Keep related helpers together when
> they implement one algorithm; choose boundaries by the meaning of the work.
>
> Write a concise, accurate `doc` naming the output's row grain and calculation,
> with important input assumptions, units and exclusions when they apply.
> Describe the formula actually implemented, including null handling or
> selection inside the function. Update the doc whenever those rules change.

### Generic executable example

Assume `readings` is a connected table with `sensor` and numeric `reading`
columns. The custom process computes unscaled median absolute deviation:
`median(abs(reading - median(reading)))` over non-null readings per sensor.

```dataflow
create operator sensor_dispersion: process(fn=median_deviation, doc="One row per sensor with unscaled median absolute deviation and count n of non-null readings; mad is null when n=0")
    def median_deviation(df):
        rows = []
        for sensor, group in df.groupby("sensor", sort=False, dropna=False):
            values = group["reading"].dropna()
            mad = (values - values.median()).abs().median() if len(values) else float("nan")
            rows.append({"sensor": sensor, "mad": mad, "n": len(values)})
        return pd.DataFrame(rows, columns=["sensor", "mad", "n"])
create operator sensor_ranked: sort(by=[("mad", "desc"), "sensor"])
create operator sensor_top: limit(2)
create edge readings.out -> sensor_dispersion.in[0]
create edge sensor_dispersion.out -> sensor_ranked.in
create edge sensor_ranked.out -> sensor_top.in
```

Batch these known changes in one edit, execute the selected branch and retrieve
the required result. More operator boundaries do not require one model call
per operator. The complete `sensor_dispersion` table stays available when the
next question asks about all sensors or a revised statistic.

The example is generic. It contains no benchmark-specific rules, annotations,
reference answers or reference code. Existing multi-task guidance adds how to
reuse, revise and preserve these computations across tasks.

## 7. Retrieval, reuse and version semantics

The model first selects a relevant task or operator from the catalog. It can
inspect any completed earlier task, including one absent from the observed
dependency list.

For example, this requests a saved working branch and its complete Python in
one inspection, without reading table records:

```json
{
  "reasoning": "Check the earlier sensor statistic and its inputs before reusing it.",
  "actions": [
    {
      "type": "inspect",
      "target": "task",
      "task_id": 1,
      "operator_id": "sensor_dispersion",
      "include_implementation": true,
      "view": null
    }
  ]
}
```

Inspection returns the selected task-local computation and saved references
to unchanged earlier inputs. It does not automatically expand the whole
session graph. Expand relevant boundary references by their owning task and
operator ID. A state inspection can read a saved operator and its immediate
inputs; named state inspections can also be batched.

Set an available retrieval view to read selected saved root results. Inspection
with `include_implementation: false` must omit Python bodies everywhere,
including any attached task catalog. `view: null` must omit result records.
The detailed computation should be rendered once, without duplicating it in
an attached full change catalog.

Before reuse, compare input coverage, row grain, filters, formulas, units and
limits with the new request. Inspect code when the description does not resolve
those questions. Repair an incorrect step and verify the affected outputs.

| Capability | Meaning and appropriate use |
| --- | --- |
| Inspect saved state | Read definitions and available observations from a specific completed task. Leaves the current graph unchanged. |
| Reuse current state | Connect a current operator that already expresses the requested rule. An earlier saved result is not a directly addressable current graph input. |
| Fork saved state | `fork operator sensor_dispersion from task 1 as baseline_dispersion` copies the saved root and its entire upstream definition graph into the current graph. Use it for historical downstream computation or a separate scenario. |
| Restore a definition | `update operator sensor_dispersion from task 1` restores that operator's saved definition on its current inputs. It does not recursively restore every ancestor. Use it when the session adopts the earlier rule again. |
| Revise a shared rule | Update the responsible current operator. Its descendants become stale and must execute before current retrieval; independent branches remain usable. |

A fork uses the supplied new root ID and the runtime's ancestor mapping, today
based on `new_root__original_id`. Compatible saved observations can be read
immediately, but executing the fork can recompute ancestors. Forking does not
bind new downstream execution directly to an old complete materialization.
Do not claim zero recomputation or guaranteed cost savings.

Restoration can create a combination of an old rule and current upstream
treatments. Its changed-input receipt matters. For a whole historical branch,
fork the branch rather than assuming one restored definition restores its
input versions.

Saved definitions do not snapshot external file bytes. Reproducible replay
requires frozen inputs and the relevant deterministic execution environment.
Unavailable historical records remain explicitly unavailable.

## 8. Task dependencies and answer sources

Observed dependency links come from recorded table reads, computation inputs,
reused definitions and saved-state references. They do not certify correctness
or necessarily capture conventions carried only in prose. Catalog scope and
dependency scope are different: showing all changed operators does not mean
all of them contributed to the answer.

`answer` with `from` automatically records computed source tables. For a
free-text `content` answer, the agent should supply `operator_ids` for the
completed tables it used. Mark those operators as answer sources in their blocks
and retain the separate source line when no new block exists.
Availability validation checks that the sources exist and completed, not that
they semantically justify the answer.

Declared sources select the default saved sub-DAG for task inspection. A named
intermediate root selects another branch when the final report is inappropriate.
Without declared sources, prior reads are unconfirmed candidates; do not expand
them as if they were a proven answer computation. Keep this uncertainty visible.

Graph lineage covers explicit operator inputs. It does not expose every local
variable in a process or every external read hidden inside Python. Small,
connected processes and native file operators make that lineage more useful.

## 9. Comparison with ordinary Python plus a catalog

The Python baseline retains one persistent kernel. It receives the same public
question/context and earlier agent answers, plus its executed script IDs,
execution status, bindings written, answer variables, observed dependencies
and compact write-time table metadata. It retrieves exact historical scripts
and captured outputs on demand. The agent can print current variables, preserve
named copies or files, and adapt or rerun earlier scripts.

The baseline chooses its own retention policy. It is not forced to overwrite
variables or forbidden to keep an old copy. Historical catalog metadata records
what a script wrote; it does not restore the old value of an overwritten name
or provide automatic historical heap lookup.

The Dataflow catalog adds explicit operator definitions and input edges;
historical inspection addresses saved operator versions, and fork/restore
provide graph operations for reuse and recovery. Full process bodies remain
on demand, as full scripts do for Python. Both sides receive compact metadata
without automatic sample records. Access serves equivalent purposes but graph
operators and script blocks have different granularity; do not call their
lineage metrics identical measurements.

Any future full-code catalog condition must expose equivalent historical
script text to Python and report its additional input cost. A comparison with
special Python copy guidance is a separate retention intervention, not the
ordinary baseline.

## 10. Implementation responsibilities

| Area | Responsibility |
| --- | --- |
| `task-history.ts` | Construct saved task records from successful ordered edit receipts and endpoint snapshots; consolidate changes and fork copies; render canonical blocks with answer-source and source-task references. |
| `native/observation-format.ts` | Reuse canonical operator descriptions and Markdown blocks, including safe inline and fenced code and small marker/note additions. |
| `native/catalog-summary.ts` | Derive compact saved-result summaries from matching stored schemas/profiles, without rows or execution. |
| `util/context-utils.ts` | Present immutable prior-task frames before the current task's ordinary ReAct messages. |
| Task inspection runtime/renderer | Return the chosen local branch once; respect implementation and result-view choices; preserve earlier-input references. |
| Shared native prompt | Encourage coherent processes, accurate descriptions, complete working tables, focused verification and batched graph edits. |
| Multi-task/history prompt sections | Explain catalog selection, unverified dependencies, saved versions, fork versus restore and answer sources. |
| LongDS harness | Keep input visibility, metadata and historical-code access comparable with Python; record settings and costs. |

Build the catalog from stored execution facts and authored definitions, without
an extra LLM summarization call. The legacy `state-ledger.ts` formatter can
provide reusable formatting ideas; this design keeps `stateLedger: false`.

Use event order rather than final workflow array order to establish chronology.
Within a fork event, retain its source mapping so unchanged copies can point
back to the precise saved definitions. Before deployment, update the history
prompt to describe the actual blocks and regenerate the native references.

The current draft needs an explicit implementation-body switch: catalog/index
construction should omit bodies, while selected detailed inspection can attach
them. Avoid leaking full catalog code through task inspection when its
`include_implementation` flag is false.

## 11. Verification and bounded evaluation

### Offline correctness

Check chronological edits, repeated changes, created-then-updated operators,
rewiring, fork groups, restored definitions, deletion, rejected edits and
partial action failures. Check answer-source markers and unchanged-input
references without whole-graph expansion.

Check fork collapse counts and exact source mappings, modified or rewired
copies, changed copied ancestors, answer sources among collapsed inputs and
multiple forks in one edit. Verify sources from earlier tasks remain labelled
even when no operator changed in the answering task.

Verify saved definitions and result metadata stay tied to their task when the
live graph changes. Cover unavailable/stale/failed results, mismatched profiles,
partial statistics, exact integer counts and explicit schema omissions. Check
Markdown escaping, long declarations and multiline Python.

Task inspection must retrieve multiple operators together, omit Python and
records when not requested, and avoid duplicating catalog and sub-DAG blocks.
Context tests should verify that old task frames remain unchanged as current
ReAct messages and later completed tasks append.

Execute the generic prompt example in all four variants: single-task/full,
single-task/on-demand, multi-task/full and multi-task/on-demand. Check complete
working-table retention, report selection, missing readings and zero dispersion.
Validate generated prompt/tool/operator references and run the relevant types
and unit checks. No model calls are needed for these tests.

### Pilot measurements

Keep any next experiment limited to the already reviewed LongDS v1.1 Lite
pilot scope, with no input token cap or automatic compaction. Freeze source and
settings before paid calls. Preserve the ordinary Python-with-catalog baseline,
and use verified checkpoints containing the state the probes require.

Measure more than final accuracy:

| Measurement | What it establishes |
| --- | --- |
| Final answer and available partial scores | Whether the requested result was obtained; preserve official and deterministic oracle scores separately. |
| Historical state selection | Whether the requested rule version and required current components were actually used. |
| Working-table availability | Whether reusable intermediates required by the probe exist as addressable outputs with the correct grain and scope. |
| Update freshness | Whether affected descendants reflect a changed rule rather than a stale result. |
| Branch preservation | Whether a temporary scenario leaves independent/main-branch state intact. |
| Dependency precision/recall | Actual computation/read lineage against private annotated dependencies, with granularity and unresolved cases stated. |
| Recovery effort | Retrieval calls, repeated code, rebuilt operators, executed ancestors and actual cache reuse. |
| Representation cost | Catalog size, retrieved implementation volume, input/output tokens, cache-aware model cost and latency. |

Record process count and authored code-size distribution as diagnostics, not
optimization targets. Classify errors as input discovery, wrong transformation,
incorrect historical selection, stale update, inherited earlier error, hidden
working table, answer-source omission or tool recovery, with trace evidence.

More atomic operators should improve inspectability and local repair, but can
increase catalog rows and engine overhead. On-demand code should reduce repeated
input, but can add retrieval turns. Report these tradeoffs and prefix-preparation
cost separately from continuation cost; keep harness replay time separate from
agent solving time.

Prompt improvements, richer catalogs and version tools are different
interventions. An accuracy or cost gain after all three change does not isolate
automatic versioning. A later version-tool control must retain the same catalog,
prompt and historical-code access while disabling historical-value and recovery
capabilities; the current settings require harness work to provide that control.
Do not substitute an invalid settings combination for an ablation.

One attempt on a few probes is a mechanism illustration. It cannot establish
a benchmark-wide accuracy or cost advantage. Benchmark answers, annotations,
oracle anchors and reference code remain evaluator-only.

## 12. Expected effect and remaining work

Operator blocks should let the model locate work from its actual operation
and inputs without inspecting every operator. Accurate descriptions should make process
selection less ambiguous. Independently reusable outputs should make it easier
to inspect a mistake, revise one rule and verify affected descendants. Saved
version references should preserve useful history without copying unchanged
Python into every new task.

Those effects remain hypotheses until the integrated representation is tested.
Markdown blocks alone do not guarantee fewer tokens than a table. The expected
savings come from on-demand bodies, collapsed unchanged forks and compact
metadata. Compared with the old ID-only catalog, the richer catalog adds input
and may avoid discovery calls; measure the net effect. Its size still grows
with the number of tasks and meaningful changes, and cache discounts do not
reduce the model's actual context length.

Keep smaller-process guidance fixed when measuring the catalog change. Record
prompt, catalog and version-tool interventions separately. A prose instruction
is not an enforced operator-size mechanism and does not establish a versioning
benefit by itself.

An optional current-tables index is deferred. If tested later, place it after
the immutable prior-task frames and show actual current IDs, last-changing task
and valid current result shape. Account for its extra input and provide a
comparable live-binding index to Python when claiming discovery parity.

The shared guidance and example add 2,010 characters to the initial native
prompt. Token overhead depends on the model's tokenizer and cache use; this
change alone does not demonstrate a cost reduction.

## 13. Implementation and review notes

- `agent-service/src/agent/task-catalog.ts` collects committed changes and renders
  endpoint definitions through the existing operator formatter. The complete
  delta and exact fork mappings remain in the stored record; rendering alone
  collapses unchanged copies. Deleted or disconnected fork roots cannot hide
  surviving working tables. Answer sources and altered copied ancestors retain
  their blocks.
- `task-history.ts` assembles dependencies, renders the task frames and returns
  an independent copy for inspection. Inspecting a selected task branch does
  not repeat its full change catalog or bypass the implementation flag.
- `workflow-snapshot-storage.ts` holds each completed catalog once, deeply
  frozen and not inherited. Its lifetime follows the existing snapshot tree.
  `texera-agent.ts` captures it at answer time and retains it in the exported
  action trace so import preserves the exact earlier representation without
  executing or profiling.
- `graph-edits.ts` and `versioned-graph-edits.ts` now resolve ordinary, restore
  and fork commands in one ordered private draft and validate the final graph
  before committing. Typed receipts preserve command order and fork mappings.
  A failed edit commits none of its drafted operators. New traces record the
  ordering policy; older traces keep their previous replay semantics.
- Historical lookup and catalog reads share the existing immutable workflow
  fingerprint memo. Mutable drafts bypass that memo. Execution caching and
  saved-observation validation retain their existing version semantics.
- Older fork receipts without a mapping compact only when the saved root proof
  establishes the unchanged copied DAG. Source IDs are recovered from stored
  origins, not guessed from names. Missing proof leaves the copies visible.

Regression coverage includes creation followed by updates, command order,
edge-only edits, implicit consumer changes on deletion, rejected/skipped
edits, saved sources without edits, fork compaction, changed ancestors,
removed roots, disconnected copies, immutable frames, statistics coverage,
on-demand Python, selected-branch inspection, export/import and single-task
compatibility. The generic process example is executed locally against its
small fixture in the prompt tests.

Provider cache hit rates still need measurement after review. A preserved prompt
prefix only makes cache reuse possible. Forking copies definitions and exposes
compatible saved observations; it does not bind a downstream engine port to an
old materialization. No real-model or benchmark campaign has been started for
this implementation round. The review follow-up below records deterministic
live-engine checks separately.

### Local verification completed

From `agent-service/`:

- `bun test`: **1,415 passed, 0 failed**, across 118 files, including 8 snapshots.
- `bun run typecheck`: passed.
- Prettier check on the implementation and regression-test files: passed.
- `bun run render:native-reference`: regenerated the rendered prompts; reference
  drift tests passed in the full suite.
- `git diff --check` from the repository root: passed.

The tests use local fixtures and mock models/execution for the agent loop.
They cover byte-identical historical message frames as tasks are appended,
trace import even when historical tools are disabled on the receiving agent,
and rejection of graph rewrites on a completed imported leaf. They do not
establish provider cache hit rates or live engine cache performance.

The implementation is left in the working tree for code review. No new
benchmark or paid-model pilot has been started.

## 14. Review follow-up: compact rendering and live verification

The review identified real catalog repetition. Result summaries now repeat a
column name and type only when identifying statistics for that column. They omit
absent-statistics labels and schema-only columns; the separate columns field
still shows the schema. Generic process-opacity scope sentences are omitted
from catalog blocks, while meaningful filter, limit and source-preview facts
remain. The task heading supplies the checkpoint, so individual block headers
no longer repeat it. Input, origin and answer-source version references remain.
The prompt and generated reference explain this convention.

### Existing Netflix prefix, without execution or model calls

Imported the existing 27-task prefix from
`/var/tmp/dataflow-state-pilot-20261005/prefix-dataflow/rpc-responses`, covering
153 ReAct steps. Restored recorded endpoint metadata verbatim from the saved
snapshots: the snapshot API omits the retained result array, so passing its
flattened metadata through the live execution-result binder would discard
profiles. No fresh statistics, reference answers or executions were used.

Both renderings use these same saved facts. The before rendering reconstructs
the pre-review formatting; it is not a new experimental arm or a rewrite of
the historical model's actual input.

| Measure | Before review fixes | After review fixes |
| --- | ---: | ---: |
| Complete rendered catalog, characters | 117,806 | 109,350 |
| Displayed operator blocks | 97 | 97 |
| Collapsed unchanged fork copies | 70 | 70 |
| Redundant checkpoint labels on headers | 97 | 0 |
| Generic process-scope sentences | 58 | 0 |
| Unknown input-row scopes in recorded snapshots | 0 | 0 |
| Tasks with unresolved access provenance | 0 | 0 |

The raw records retain 166 changed-operator blocks and all exact fork mappings.
The reduction is **8,456 characters (7.18%)**, not half the catalog. Most outputs
in this real prefix have valid profiles, so their actual per-column statistics
remain. Questions, answers, long identifiers, definitions and metadata account
for the rest. These are character measurements, not tokenizer counts or a cost
comparison. The review's roughly 45k-character projection understates this
prefix's complete content.

Neither suspected provenance problem appears in the saved session, including
its original recorded task-history responses. The conservative version-binding
checks remain unchanged: an unbound fixture's same-snapshot row count cannot
prove which input version a consumer actually used. Unknown provenance remains
available in the structured records when evidence is missing.

Audit artifacts, including the full readable prefix and reproducible offline
script, are in `/var/tmp/operator-catalog-review-20261005/`:
`before-catalog.md`, `after-catalog.md`, `before-summary.json`,
`after-summary.json` and `audit.ts`. These are local evaluator artifacts.

### Live engine checks, without model calls

Used this worktree's agent service on port 3074 and the existing live backends.
The computing-unit application endpoint in this local deployment is port 8888;
port 8082 is its admin listener. Initial endpoint-only setup failures allocated
no workflows or agents. Correcting the fixture environment required no engine
or agent production changes.

- `task-context-run`: **10 checks passed**. Covers original-producer caching,
  selected task sub-DAGs, pinned input versions, saved reads, fork/restore,
  deletion, and unknown task errors. Added a mixed create/delete/fork/rewire
  batch that computes 21 from task 1's original inputs. A rejected historical
  command commits no staged operators and retains the computed result.
- `observation-format-run`: **12 checks passed**. Covers live receipts, typed
  retrieval views, settings validation, prompt examples, saved/forked scopes,
  restore on current inputs, empty/small selections and execution failures.
- `history-retention-run`: **5 checks passed over 20 requests**. Historical
  reads survive later requests, physical file overwrite and deletion without
  executing. Executing a fork after source overwrite recomputed on the new
  external bytes, confirming that a fork is not an old-materialization binding.
  Restoring rules on current inputs still works after an independent failure.

All three fixtures made **zero model calls** and cleaned up their owned agents,
workflows and computing units. The historical fixture remains bounded by its
retained result cap; it does not establish unbounded retention or paid-run
accuracy/cost gains. Fixture logs and reports are alongside the offline audit;
the observation-format report is in `/tmp/observation-format-live-RQIwd8/`.

Updated local verification: **1,417 Bun tests passed, 0 failed**, across 118
files with 8 snapshots. Type checking, implementation formatting, generated
prompt drift checks and `git diff --check` passed. Paid pilots remain stopped
for code review.

## 15. Independent catalog controls, 2026-10-05

Added `catalogStatistics`, default `false`, and wired the existing
`catalogRecords`, default `0`, into prior-task operator blocks. Agent creation,
settings retrieval and live settings updates support both controls independently.
Enabling statistical retrieval no longer enables catalog statistics. Definitions,
inputs, saved output shape and columns remain visible with both controls off.

Enabled records reuse bounded observations actually retrieved in the task and
matching its final completed result identity, operator revision and upstream
graph. They never sample again. Frozen catalog frames retain both their original
settings and record text after later settings updates, result changes and import.

Verification: **1,423 Bun tests passed, 0 failed**; type checking passed.
Regression tests cover all four statistics/records combinations, row limits,
invalid settings, missing observations, mismatched versions, read-only tasks
and historical frame immutability. The live `task-context-run` fixture passed
**11 checks** with **zero model calls**, including controls through the settings
API and engine-generated profiles and records. Its owned resources were removed.
Artifacts are in `/var/tmp/catalog-controls-live/`; no paid pilots were run.

## 16. Registered protocol, 2026-10-09

The registered-Python protocol (`set`/`delete` statements, Python in a
separate `python` field) keeps this design and changes four things:

- **Definitions are listed with their code.** Functions are registered once
  and called by name, so an entry opens with `Definitions:`, the source of
  every binding the task registered or changed, in definition order and once as
  the task left it. A definition re-sent unchanged adds nothing. The operator
  blocks keep the function's signature; an operator's own `doc` is part of its
  `set` statement and is not repeated as a description.
- **Columns are complete.** Each block lists every column name where a chain
  starts and `same as x` (with retyped, dropped or added columns) below it. The
  receipts' 16-column budget hid columns that later questions needed: NFL Q18
  read `x_o`, which all four Terra catalog runs of 2026-10-07 lost.
- **No task inspection.** The protocol has no `inspect target=task`, so entries
  and clipped answers no longer point at one. Earlier versions are read with
  `name@N` inputs; current definitions with `inspect namespace`.
- **Answers cannot declare sources.** `Answer sources: not declared` is
  followed by the results the task read, as labelled candidates.

The delta comes from the task's committed edit receipts (first-edit order,
final definition) and the snapshots before and after the task: an operator is
`created`, `updated` (with `the definitions its function uses changed` when
its statement did not change, or `restored task N's version` when it returns
to an earlier task's revision) or deleted. An input left unchanged by the task
names the earliest task that saved that same result version. Forks, collapsed
copies and saved-result handles do not exist in this protocol.

Implementation: `agent-service/src/agent/task-catalog.ts`, rendered by
`task-history.ts`; the prompt describes the layout when `taskContext` is
`dependencies`. Tests: `native/task-catalog-agent.test.ts`.
