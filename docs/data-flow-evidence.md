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

# Data and flow evidence: computation and model context

**Historical calculation reference.** The configuration, action names, shared
budget, defaults, and filter availability below describe the older expression
protocol. For the current registered-Python protocol, use
[retrieval views](retrieval-views.md) and the
[registered-Python design](native-registered-python-design.md). Current data
statistics accompany explicitly retrieved result samples; automatic flow evidence
describes measured operator effects, including relevant non-retrieved ancestors.
The two evidence budgets are separate from the record budget.

This document describes the implemented **Python-native V2, batch + explicit
observe** path. The calculation and selection reference was checked against
implementation commit `c5620b9b43f21ee2aa222bfc4ff0c5faf0958ede` on 2026-09-16.
The subsequent `feat/evidence-compaction` branch preserves those calculations
and selections, then compacts their display. See the
[compaction contract](evidence-compaction.md) for the updated count format,
same-observation deduplication, and same-frame upstream references. Examples
below retain the original expanded formatting to explain the individual facts.
It is an implementation reference, not a proposal or a claim about benchmark
accuracy.

In one sentence: **data evidence describes a table; flow evidence explains an
operation and its input/output relationship; the combined configuration selects
from both within the same budget as the table sample.**

Contents:

1. [Configuration and what the four configurations mean](#1-configuration-and-comparison-contract)
2. [Collection, validation, and observation pipeline](#2-from-execution-to-model-context)
3. [Data evidence formulas and limits](#3-how-data-evidence-is-computed)
4. [Flow evidence formulas and operator coverage](#4-how-flow-evidence-is-computed)
5. [Using the surrounding DAG](#5-how-the-surrounding-dag-is-used)
6. [Shared budget and combined selection](#6-how-the-shared-budget-and-combined-selection-work)
7. [Exact result examples for all four configurations](#7-what-the-model-sees-in-the-four-configurations)
8. [DELTA, LATEST, observation, and upstream changes](#8-where-results-appear-in-delta-and-latest)
9. [Error handling and unavailable evidence](#9-errors-and-unavailable-evidence)
10. [Limitations and interpretation](#10-limitations-and-interpretation)
11. [Verification and source map](#11-verification-and-source-map)

## 1. Configuration and comparison contract

The two public evidence-exposure settings are strict booleans:

| Configuration | `dataEvidence` | `flowEvidence` | Eligible additional text                                                  |
| ------------- | -------------- | -------------- | ------------------------------------------------------------------------- |
| No evidence   | `false`        | `false`        | Neither evidence family                                                   |
| Data only     | `true`         | `false`        | Output-column/table measurements                                          |
| Flow only     | `false`        | `true`         | Operator contracts, input/output measurements, bounded upstream summaries |
| Data + flow   | `true`         | `true`         | Both families, selected together                                          |

Both default to `false`. A matched comparison uses the same operators, tools,
collection policy, layout, and budget, changing only these two booleans:

```json
{
  "agentMode": "native",
  "nativeProfileCollection": true,
  "parallelToolCalls": false,
  "contextMode": "delta",
  "resultSelection": "all",
  "maxOperatorResultCharLimit": 2000,
  "dataEvidence": true,
  "flowEvidence": true
}
```

Change `contextMode` to `"latest"` to use the current-dataflow layout. The four
evidence settings work in either layout. Python client spellings are
`data_evidence`, `flow_evidence`, and `native_profile_collection`.

### Important boundaries

- **No evidence is not no data.** The agent still gets the requested table's
  shape, typed schema, and available records, subject to the result budget.
  Operator definitions, DAG connections, receipts, and errors also remain.
- **Flow only is not an absence of all statistics.** For example, a Filter can
  show input/output null and distinct counts as a relational flow fact. What is
  disabled is the standalone `Data measurement` family, not every numeric
  measurement and not physical profiling.
- **Data only still uses DAG-aware relevance ranking.** Declared column
  dependencies help choose columns and facts in every configuration. Turning
  `flowEvidence` off removes flow fact text; it does not remove knowledge of the
  DAG from the common selection algorithm.
- **`nativeProfileCollection` is separate from exposure.** It controls publishing
  the V2 structured profile from the engine, defaults to `false`, and should be
  set before creating operators. An existing workflow cannot mix compiled
  collection policies. Keep it `true` in all four matched arms to compare
  exposure with collection held fixed. Evidence switches do not retroactively
  collect missing measurements.
- **`observe` controls successful result visibility.** `resultSelection: "all"`
  does not override the explicit observe list in batch mode. No `inspectResult`
  tool is available, and observing cannot turn on a disabled evidence family.
- This no-evidence configuration still uses the new Python V2 catalog. It is
  not the historical V1/native-all-results baseline under a new name.

The removed `dataLevel`, `flowLevel`, and `columnStats` settings are not
compatibility aliases. Agent creation/PATCH rejects retired settings, including
zero/false values. See the [cleanup contract](evidence-only-context.md) for the
complete removal boundary. Legacy transport metadata retained for old traces or
the dashboard is not a source of V2 evidence text.

## 2. From execution to model context

```text
V2 operator + declared inputs
          |
          v
Python execution: output DataFrame + operation counters
          |
          +--> bounded worker profile of actual output values
          |
          v
Structured metadata + typed result/schema + execution identity
          |
          v
Validate/merge profiles; bind output to exact producing input versions
          |
          v
Explicit observe --> common table view + eligible data/flow facts
          |
          v
One budgeted observation --> DELTA event or LATEST operator block
```

There is no extra LLM call to calculate, select, or summarize these facts in
this path. There is no SQL analysis, task-specific metric, or semantic inference
from arbitrary Python source. Evidence selection reads already-stored results,
profiles, operator parameters, and the relevant snapshot's DAG; it does not
execute operators or fetch additional rows.

The Python runtime attaches `native_v2` metadata to the output DataFrame,
including operator identity/revision, declared inputs, row-effect category,
input/output row counts, and operation counters. When collection is enabled,
the worker's `ProfileAccumulator` publishes a structured
`texera.table-profile`, version 1 envelope through the reserved profile channel.
The agent decodes that envelope rather than parsing human-readable legacy stats.

### Two separate coverage questions

1. **What records were retrieved for display?** `info.result` is a stored,
   potentially truncated result sample. Its length need not equal the table's
   total row count.
2. **What records were profiled?** The worker profiles the actual output
   DataFrame, independently of that display sample, up to the limits below.

It is therefore normal to see one sampled row next to a fact labeled
`full=8365 rows`. Conversely, a displayed sample is not evidence that the
profiler covered the full output.

### Result-version binding

Before relational evidence is accepted, the agent binds a result to:

- workflow and operator identity;
- operator revision, submitted definition hash, and incoming-subgraph hash;
- producing execution and output port, not merely the latest retrieval;
- ordered input roles and their exact result-version IDs;
- available Scan source fingerprints: path, size, and modification time.

The result ID hashes this identity. Source fingerprints are not file-content
hashes. The table profile is tagged with the same result ID. Mismatched count,
schema, operator, revision, or native contract invalidates optional evidence;
provably stale/wrong-request results are rejected.

A cache hit may reuse a previously stored profile only when the original
producing result and input bindings match exactly. Equal row counts or the same
operator ID are insufficient. A cached result without its original input proof
does not acquire a relationship to today's newly materialized inputs.

These bindings are retained in audit metadata. Full version hashes and repeated
execution labels are **not** printed in every successful result body.

## 3. How data evidence is computed

### 3.1 Column measurements

For a column `c`, let `P` be the number of rows actually processed by the
profiler, `Z` the number of missing values, and `Q = P - Z` the non-null count.
Null-like values are normalized as missing; a literal string such as `"NULL"`
is an ordinary value unless an explicit parsing/transformation step changed it.

| Measurement              | Calculation                                                  | Availability/meaning                                                          |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Null count               | `Z = count(missing(c))`                                      | Exact over the processed prefix                                               |
| Non-null count           | `Q = P - Z`                                                  | Exact over the same prefix                                                    |
| Null ratio               | `Z / P`                                                      | Stored as `null` when `P = 0`; rendered counts use `Z/P`                      |
| Distinct non-null values | `D = size(exact typed-value dictionary)`                     | Unknown if the bounded dictionary is abandoned; null is excluded              |
| Uniqueness ratio         | `D / Q`                                                      | Stored only when `D` is available and `Q > 0`; not a separate fact line today |
| Range                    | Minimum/maximum non-null value                               | Numeric and datetime domains; not a string min/max summary                    |
| Value frequencies        | Exact count per dictionary value, sorted by descending count | Retained only while the exact dictionary is available                         |
| Other count              | `Q - sum(counts of displayed top values)`                    | Non-null mass outside the displayed list, not a null count                    |

Counts, values, and range are separate candidates, not an inseparable column
report. The selector can keep the counts while omitting values or range.

The default frequency list has at most eight entries. After agent-side merge,
equal counts are ordered by scalar value. A list is called `nonnull values` if
it contains the whole retained domain; otherwise the label is
`top values (not exhaustive)`. A partial-prefix domain remains partial even if
all its distinct values fit in the list.

The implementation uses **bounded exact dictionaries, not approximate
distinct-count sketches or a streaming heavy-hitter estimate**. If a column
exceeds the distinct-value limit, distinct count and frequency information
become unavailable instead of pretending the retained entries are exhaustive.
Null counts and supported ranges can remain available independently.

Typed scalar encoding preserves `int64` values as decimal strings in metadata,
avoiding JavaScript-number rounding. The renderer prints those decimals
exactly. Strings are JSON-quoted/escaped; `null`, `"NULL"`, and `"null"` remain
different. Timezone-aware profile datetimes are normalized to UTC. Unsupported,
oversized, or non-finite values disable affected value/range facts rather than
inventing a substitute statistic.

### 3.2 Structural measurements

The worker can also measure:

- **Duplicate rows:** `P - number_of_distinct_typed_rows`. This counts extra
  occurrences beyond the first, not every occurrence of a duplicated row.
- **All-null rows:** rows for which every profiled column is missing, provided
  the complete row width is available.
- **All-null columns:** profiled columns with `P > 0` and no non-null values.

The `data.structure` text is a candidate only when there is an actual anomaly:
positive duplicates, positive all-null rows, or at least one all-null column.
It is not a repeated zero-valued structural report on every table. An internal
column-only scope suppresses this whole-table structural line.

### 3.3 Physical profiling limits

These are worker collection limits, **not** the model-context character budget:

| Default limit                 |          Value | Consequence when reached                                                                            |
| ----------------------------- | -------------: | --------------------------------------------------------------------------------------------------- |
| Processed rows                |        100,000 | Remaining rows are not profiled                                                                     |
| Processed cells               |      1,000,000 | Reduces the processed prefix on wide tables                                                         |
| Profiled columns              |            128 | Later columns omitted; full-row structural claims disabled                                          |
| Distinct values per column    |            256 | Exact dictionary abandoned on overflow                                                              |
| Distinct row identities       |          4,096 | Duplicate-row metric unavailable on overflow                                                        |
| Displayed frequency entries   |              8 | Remaining non-null mass is `otherCount`                                                             |
| Profiled scalar string length | 192 characters | Affected value/range data becomes unavailable                                                       |
| Encoded worker payload        |   65,536 bytes | Drop the largest value dictionaries/frequencies first, retaining compact categories where possible; then native counters and profile contents if necessary |
| Accumulated collection time   |    0.2 seconds | Cooperative cutoff checked every 128 rows; not a hard wall-clock execution timeout                  |

The accumulator still tracks the full output row count via DataFrame lengths
when value profiling stops. Row selection is a **prefix of worker output**, not
a uniform random sample or a statistically representative sample.

`full=N rows` on a column requires a valid version-bound profile, a processed
row count equal to the output's total row count, and all expected worker
contributions. Otherwise it is labeled `partial prefix=P/N rows` (`?` if the
total is unknown). Full row coverage does not imply that all columns, distinct
values, or optional metrics survived their independent limits.

### 3.4 Merging workers and invalid metadata

The agent checks envelope format, safe integer counts, column/schema
consistency, identity, and unique worker/producer IDs before merging. It accepts
at most 64 payloads, 65,536 bytes per payload, and 262,144 bytes in total. An
unknown expected worker count makes the profile unavailable; missing expected
workers make valid contributions partial.

- Counts are summed over distinct contributions.
- Distinct values are **unioned and their frequencies combined**, not obtained
  by adding worker distinct counts. If merge dictionaries are absent or their
  union exceeds the limit, global distinct/frequency information is unknown.
- Ranges combine compatible worker ranges; incompatible datetime domains do
  not acquire an apparently precise merged range.
- Full coverage requires all expected workers to finish profiling all their
  output rows.
- Cross-worker duplicate-row counts are unavailable: local duplicates do not
  detect duplicates across partitions.
- Operator-specific native counters are currently retained only for a single
  worker contribution; they are not naively summed across workers. The worker
  also omits native counters if its accumulator received multiple DataFrame
  yields, because one frame's counters would not describe the combined output.

An unavailable optional profile does not turn a valid table execution into an
error.

## 4. How flow evidence is computed

### 4.0 What a flow line reports

The runtime measures every counter below on the full tables, and the renderer
validates them, but a counter is not a line by itself: a filter that drops rows
or a join that leaves keys unmatched is doing what it was written to do. A flow
line reports only where a step's result departs from what its code asked for,
in one of these ways (examples from KramaBench and PrepBench data):

| Line | Example |
| ---- | ------- |
| A filter rejected values written like one of its literals or a kept value (case, spacing, punctuation between words, leading zeros), or holding a literal's words with only an article or a zero part added | `"Violation" values the condition rejected equal its literal "yes" except for case, spacing or punctuation: "Yes" × 1,559; "YES" × 1,151.` |
| A condition that looks for literals kept no row (the furthest test the rows reached, with its literal) | `no row passed the condition's test for "07"; "start_date" values that reached it: "9/22/2002" × 1; "10/21/2002" × 1; "8/25/2002" × 4.` |
| Join keys equal only when written alike | `1 left key (2 rows) matches a right key only when case, spacing, punctuation and leading zeros are ignored: "Las Vegas, Nv" ~ "Las Vegas, NV".` |
| A join that matched no key | `the join matched no keys; left keys look like "45421", right keys like "18053677".` |
| Repeats in an identifying column whose rows agree on their numbers (Python step output, or rows an aggregate sums, counts or averages) | `"area" repeats 43 values with the same "reports" (452 rows, 401 distinct), …; this aggregate's sum, count and mean count each repeat.` |
| The same record listed by several source files (needs the scan's file column) | `94 of 94 input rows are 43 records each listed once by 38 different sources apart from "file", …; the aggregate counts every copy.` |
| A group key that pools a column naming entities (one line per aggregate) | `grouping by "Beach Name" pools rows with different "Community" values in 14 of 1,155 groups, e.g. "Atlantic Avenue": "Provincetown", "Harwich".` |
| A cast that turned values into nulls, a None verdict, ties in a window, an empty source file, union or pivot gaps | `"Age" could not be converted in 1 of 14 rows, e.g. "NA" × 1; those cells are now null.` |
| The same record listed by several of a multi-file scan's files (no file column needed) | `94 of 764 rows of this table are 43 records listed in 2–4 of the 52 files, e.g. "Columbus, GA-AL Metropolitan Statistical Area, 1,302" in Alabama.csv and Georgia.csv; a sum, count or mean over these rows counts each copy.` |
| Copies an aggregate reads when its input comes from several sources, with its result counting each record once (only when that differs) | `94 of 94 rows read here are 43 records repeated 2–4 times (identical in every column; the input comes from several sources), …; counting each record once: "total" = 243,377 (now 593,524).` |
| Rows a column marks as excluded that an aggregate reads, with its result without them; a projection that drops the mark | `2 of 14 rows read here have "Case_excluded" = "Yes" ("C3L-01247", "C3N-01825_replication"); without them: "median" = 2.65631 (now 2.42405).` |
| A dedupe on an identifier (built-in distinct or `drop_duplicates` in Python) that drops rows whose other values differ, or collapses rows with an empty key | `distinct on "NWS ID" removed 828 rows, among them 7 whose "NWS ID" repeats with different values in other columns, e.g. "051506": "Station Name" "THE CROWN" / "HANGMAN", …; 821 with an empty "NWS ID", collapsed into one.` |
| Inside a Python step: merge or `.map` lookup keys that match only once written alike, the same record in several files the function read itself (`open()`, csv, pandas), a file's repeated header columns the function never read | `"wollaston_beach_datasheet.csv" has 4 columns labelled "Enterococcus" (column 5, column 7, column 9, column 11); the function never read column 11.` |

The group-key line also gives the group count with the pooled column added to
the key (`grouped by "Beach Name", "Community" there are 1,171 groups (now 1,155)`).

**Runtime stats (2026-10-14).** The model sees these lines as
`- runtime stats:` (`- runtime stats (<step>):` for an upstream step). With
flow evidence on, the system prompt says once what they are and that they help
validate a result: whether a step did what was intended and whether the data
has a trap (`RUNTIME_STATS` in `prompts.ts`). Tool results no longer carry a
per-result note, and nothing makes the agent answer them. Precision rules for
the new lines:
- A record shared by several files must name something: a text cell that is
  not a date. Among rows a function read by hand, only rows with a number count.
- A dedupe is checked only on a key with at least half as many values as rows.
  Its key group counts as different records only when two columns, or a
  number, differ; copies that differ only in their file or state are copies.

On 17 KramaBench tasks whose failures a runtime check can reveal (10 reps,
statistics off), Luna went from 68.8% with flow off to 82.4% with runtime stats.

A rejected row is blamed on the column its condition read last (in `a and b`,
the part that failed), so a value rejected by one part is never reported under
another. Punctuation before or after a value's words is part of the value
(`"</td>"` is not `"<td"`, `"A-"` is not `"A+"`), except brackets, quotes,
separators and footnote marks (`"Aberdeen,"` is `"Aberdeen"`,
`"Week 13 (Final)"` is `"Week 13: Final"`); a value that holds a literal among
other words (`"Human-Vulcan"`, `"Black/Blue"`, `"New York, NY"`) is another
value, not the literal written differently.

Lines that only restated counts or the code's intent are gone: filter
rejected-value lists and predicate-column nulls, join coverage and duplicate
keys, aggregate group sizes, non-null and distinct-count lines, Python-step
dropped values, zero-failure casts, null deltas and window lag boundary nulls.
The 2026-10-14 trace study of 3,307 flow lines found the agent acted usefully
on seven, all of these kinds; the rest were redundant or misleading.

The forms below describe how the measurements are computed:

| Form                 | Source                                                        | Example interpretation                                           |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `Flow guarantee`     | Implemented operator contract plus its declared parameters    | A Filter returns a stable subset; a Project preserves rows       |
| `Flow measurement`   | Runtime counters and/or version-matched input/output profiles | Three of five input rows survived the filter                     |
| `Flow upstream <id>` | Bounded traversal over matching ancestor results              | The final count follows an aggregate at a particular group grain |

Contracts do not claim the agent chose the correct scientific formula. In
particular, the UDF contract explicitly says row/column mapping is unknown.

### 4.1 Validation before measurements

Local evidence requires a completed V2 result whose operator ID and revision
match the snapshot. Relational measurements additionally require:

1. Every declared input is present, successful, complete, and matches its stored
   input role, port, version, workflow, and operator revision.
2. The native metadata names the same operator type and ordered input operators.
3. Native input/output counts match the bound materialized tables; output count
   also matches the table profile. Counts must be nonnegative safe integers.
4. The row-effect declaration, when present, agrees with the catalog.
5. Operator-specific equations below are consistent.

Invalid counters are omitted with an audit reason such as
`invalid_join_counters`; they are not converted into a confident claim. A
contract can still be available when optional numeric profiling is unavailable.
Full operator counters can remain valid even if column profiling covered only a
prefix, because the runtime measured those counters during the actual operation.

### 4.2 Filter

The runtime evaluates the declared Python `apply(row)` on the declared predicate
columns. It counts `None` predicate results separately and applies the explicit
`nulls` policy (`drop`, `keep`, or `error`).

Let input rows be `N`, kept rows `K`, rejected rows `R`, and null predicates `U`:

```text
K = number of rows retained after applying the null policy
R = N - K
U = number of predicate calls returning None
output rows = K
```

The renderer verifies `K + R = N`. With `nulls=drop`, `U <= R`; with
`nulls=keep`, `U <= K`; a successful `nulls=error` result requires `U = 0`.
A line prints `kept=K/N`, `rejected=R`, and `null predicates=U` only when a None
verdict dropped rows (`U > 0`); otherwise the counts restate the row counts.
`0/0` is explicitly undefined, not zero-percent selectivity.

Rejected values appear only as near misses or, when nothing passed a test for a
literal, as the values the condition saw (§4.0). The predicate columns' null and
distinct counts are not shown: those nulls are usually what the condition was
written to drop.

### 4.3 Aggregate

The runtime forms groups from the declared `groupBy` keys; null keys form a
group. For group sizes `n_g`:

```text
G = number of groups = output rows
sum_g n_g = input rows N
group size range = [min_g n_g, max_g n_g]
```

For each reducer output `a`, it also records contributor counts `q_(g,a)`:

- `count` with no `col`: `q_(g,a) = n_g`, the row denominator.
- A reducer with `col`: `q_(g,a)` is the non-null count of that source column
  in the group.

The fact reports `sum_g q_(g,a) / N` and the per-group min/max, with the reducer
name. For `mean`, this is the actual non-null denominator. For `count_distinct`,
it is the contributing non-null population, **not** the distinct result. For
`first`, the fact explicitly notes that the reducer includes the first null;
its non-null count does not change that behavior. Sample standard deviation
uses `ddof=1`; the displayed non-null population is not itself the `n-1`
divisor. Empty-group ranges are undefined; a global aggregate with no group
keys still has its single global group, including on empty input.

These contributor counts are validated but not shown: they restate the
reducer's own definition. An aggregate's lines are a group key that pools a
column naming entities and input rows it would count more than once (§4.0).

### 4.4 Join

For an equijoin, keys are explicit; the runtime never infers them. For eligible
key `k`, let left multiplicity be `L(k)` and right multiplicity be `R(k)`.
`nullsEqual=false` makes any row with a missing key component ineligible for
matching. With `nullsEqual=true`, those key tuples participate in matching.

For shared eligible keys `C`:

```text
matched output contribution M = sum_(k in C) L(k) * R(k)
left matched rows              = sum_(k in C) L(k)
right matched rows             = sum_(k in C) R(k)
side unmatched rows            = total side rows - side matched rows
side distinct keys             = number of distinct eligible keys
side matched keys              = |C|
side unmatched keys            = side distinct keys - |C|
side max multiplicity          = maximum eligible-key multiplicity (0 if empty)
```

Output is checked against the declared join:

| Join type | Expected output rows                             |
| --------- | ------------------------------------------------ |
| Inner     | `M`                                              |
| Left      | `M + left unmatched rows`                        |
| Right     | `M + right unmatched rows`                       |
| Full      | `M + left unmatched rows + right unmatched rows` |
| Cross     | `left rows * right rows`                         |

These counters validate the join; they are not shown, because matched and
unmatched rows are what a join is written to produce. The model sees keys that
are equal only when written alike and a join that matched no key (§4.0).
The counters' denominators differ. Ineligible null-key rows count as unmatched
rows but are not eligible distinct keys. Declared `validate` cardinality
constraints are enforced during execution; violations produce an error.

Example: one key occurring twice on the left and three times on the right
contributes six joined rows, while matching two left rows, three right rows,
and one key on each side. Output size divided by the smaller input cannot
recover exact unmatched rows; that old heuristic is not used.

### 4.5 Row-preserving transformations

`Project`, `Cast`, `Map`, `Sort` and `Window` have declared row-preserving
behavior. Their contracts specify changed columns, dependencies, and order
behavior; this is not inferred by parsing function bodies. Examples include:

- Project: selected/renamed columns; same rows and order.
- Map: one row out per row in, same order; the added and dropped columns and
  the columns the function read are measured at run time. The author's `doc`
  stays in the definition; it is not an engine guarantee. Process reports
  unknown mapping as a warning.
- Sort: stable sorting, preserving row identities but changing order.

For `Cast`, the runtime counts conversion failures by column. With
`errors="null"`, failed conversions produce null and the failure count can be
shown; with `errors="raise"`, a bad conversion stops execution and becomes an
error, not a successful lossy result.

A Cast with failures shows one line per column, with failed-value examples when
they account for every failure. Null deltas of a Cast or Map are not shown: for
a Cast they equal the failure count, and a Map writes its nulls on purpose.

### 4.6 Other operators

| Operator        | Runtime measurement and checks                                                                                                     | Contract/qualification                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Scan            | Selected/resolved/omitted file counts; output rows; per-source format, size, mtime, and parse/coverage metadata                    | Preview versus parsed source is explicit; a preview is not the full source                                             |
| Union           | `output = sum(input rows)`; columns absent on each input port                                                                      | Concatenation without deduplication, in input-port order; aligned absent cells are null                                |
| Distinct        | `removed = input rows - output rows`                                                                                               | Stable retained subset under declared keys and `keep` policy                                                           |
| Limit           | Same retained/removed equation                                                                                                     | Stable positional slice using offset and `n`; not a top-k guarantee without sorting                                    |
| Window          | Row preservation, number of partitions, ordering ties beyond the first row in each tie run                                         | Stable partition ordering; original input order restored in the output                                                 |
| Window lag/lead | Boundary-induced nulls and total output nulls per output column (measured, not shown)                                              | For positive offset `d`, boundary nulls are `sum_g min(d, n_g)`; existing null source cells can add more null outputs  |
| Explode         | Array elements `E`, empty/null parents `H`, null elements, max elements per parent; `output = E` or `E + H` for `empty="null_row"` | JSON-array elements in parent/element order; other columns repeat; internal parent mapping is not an added user column |
| Unpivot         | With `C` selected columns, `output = input rows * C`; retained null-cell count                                                     | Row-major expansion includes null cells                                                                                |
| Pivot           | Unique index/key pairs `P`, index groups `G`, generated columns `C`, absent cells `G*C - P`; `P = input rows`, `G = output rows`   | Duplicate pairs are an error, not implicit aggregation; absent cells differ from existing null input values            |
| UDF             | Input row counts and output row count only                                                                                         | Row/column mapping remains unknown, even if all counts are equal                                                       |

Scan selection follows actual resolved regular files, deduplicated and sorted.
Preview caps include at most five text files and one file per Excel/HTML
category; omitted files are counted. Parsed sources and sheet/header choices
have their own recorded coverage. File coverage is not a claim that the correct
scientific population or all desired workbook sheets were chosen. Per-source
detail is lower priority than the compact selected/resolved summary.

For Project, Sort, and Split there is no invented operator-specific metric in
addition to their contract and common table/data evidence. Arbitrary UDFs do
not gain declared row/column semantics merely because their code looks simple.

## 5. How the surrounding DAG is used

### 5.1 Downstream relevance: choose useful columns

`downstreamRelevantColumns` starts with the current operator's declared fields,
then follows consumers in the **same snapshot's DAG**. It reads structural
parameters such as predicate columns, projection/rename fields, group keys,
join keys, reducer columns, sort/window fields, and explicit function inputs.

When following a chain, requested output columns are mapped back through known
contracts: a Project rename to its original column, a Derive output to its
declared inputs, an aggregate output to its source column, a window output to
its value/partition/order columns, or a Join-suffixed column to the correct
input role. Split/Unpivot/Pivot also have declared dependency mappings.

The walk is bounded to depth eight, 64 queue visits, and 64 examined consumer
edges. It stops through opaque UDFs and excludes cycles. It does not inspect
future edits, parse Python for semantic lineage, or use benchmark vocabulary.

This is a **ranking heuristic**, not a guarantee of exhaustive semantic lineage.
Relevant columns receive preference for schema slots and data-count facts; a
column is not removed from the actual result table by this ranking.

### 5.2 Upstream summaries: explain the calculation behind a result

An observed non-UDF result can carry a few flow summaries of bound ancestors,
even when their successful table bodies were not requested. For example, an
observed final count can repeat that the Aggregate behind it, grouped by
`["Beach Name"]`, pools two communities' beaches, or that a cast upstream
turned values into nulls. A summary carries only the lines of §4.0.

The breadth-first traversal:

- follows only exact input-version/port/revision bindings;
- emits at most **three** summaries, visits at most **32** queued ancestors,
  and follows at most **eight** upstream edges of depth;
- summarizes Project, Aggregate, Join, Filter, Distinct, Limit, Union, Unpivot,
  Pivot, casts with measured conversion failures, and the opaque UDF boundary;
- includes at most two high-priority local measurements for Aggregate or Cast, or one
  for the other summarized types (local measurement priority at least 94);
- traverses past the first three candidates before selecting summaries, so
  conversion losses can take priority over nearby routine operations;
- stops at a UDF with an explicit unknown-mapping message. Observing a UDF
  itself does not traverse behind it.

These are bounded calculation facts, not a dump of hidden input tables,
arbitrary input profiles, function source, or a full provenance proof. Every
summary competes inside the observed output's own budget and appears only when
flow evidence is enabled.

## 6. How the budgets and combined selection work

Let `B = maxOperatorResultCharLimit`, normally 2,000. The renderer uses
JavaScript string length (UTF-16 code units), including internal line breaks.
Since 2026-09-23 evidence is additive. The table (shape, schema, sample rows,
notice) is identical in every arm and fits `B`. Data measurements and flow
evidence each get a budget of their own, equal to the room the table's first
allocation (shape, schema, reserved rows) left. So turning a family on never
removes a row or a line of the other family: the Data-only view is the
no-evidence view plus the data lines, the Flow-only view is it plus the flow
lines, and the combined view is both, in that order:

```text
E = B - length(shape + schema + reserved rows + notice)
length(shape + schema + all visible rows + notice) <= B
length(selected data evidence) <= E
length(selected flow evidence) <= E
```

An observation can therefore exceed `B` by up to `E` per enabled family.
Historical compaction keeps a recorded observation whole unless an explicit
limit is given. Before 2026-09-23 the data facts outranked the rows that
overflowed the reserve, so enabling data evidence showed about 29% fewer rows
(Luna traces: 9.0 against 12.7 rows per incomplete table).

It is a **per-successful-result body** limit. Tool receipts, operator headers,
properties/code, DAG links, errors, the system prompt, and previous events are
outside this body limit. Observing multiple operators can spend up to a body
budget for each. It is not a 2,000-token limit or a bound on the whole prompt.
The execution request also passes configured result/cell retrieval limits to
the backend, so the selector may receive an already-truncated sample.

### 6.1 Selection procedure

1. **Shape first.** Try `Output Table: N rows, C cols`. If even that cannot fit,
   return an omission marker within the budget.
2. **Try a complete table.** All rows and typed columns must be present, the
   stored sample must be explicitly untruncated, row/column display limits must
   permit the whole table, and cells must not contain transport truncation
   markers. Append the entire schema + table atomically if it fits.
3. **If the complete table fits, omit standalone data facts.** They are marked
   `redundant_complete_table` in audit metadata. Flow facts remain eligible
   because the complete output does not reveal input retention, join coverage,
   or aggregate denominators. Complete-table cells are not clipped by the
   sampled-cell rule below.
4. **Otherwise choose a schema subset.** Schema selection has a target of
   `floor(0.30 * B)`, including a conservative allowance for a partial-schema
   notice. Prefer relevant columns, then lexical name order; print chosen
   fields in their original schema order. Partial schemas say `(shown=k/C)`.
5. **Reserve room for records in the same budget.** Ordinary results reserve
   up to `floor(0.25 * B)` for rows. Raw Scan previews reserve up to
   `floor(0.75 * B)`. The room left after this first allocation is `E`, the
   size of each evidence family's own budget.
6. **Order the stored records.** Ordinary views alternate first, last, second,
   second-last, etc. from the stored result array. Preview views retain prefix
   order so headers below preambles can survive. These positions are not
   random samples and not necessarily the first/last rows of the full source.
7. **Clip long sampled string cells.** Keep 160 characters for ordinary samples
   or 120 for previews, followed by `...[truncated]...`. Rows not placed in the
   reserve then fill the rest of `B`, exactly as without evidence.
8. **Gate evidence by the two booleans.** Disabled families are not printed
   and nothing competes across parts: rows fill the table's budget, data facts
   fill their own budget `E`, flow facts fill theirs.
   Raw-preview transport columns do not produce per-column distribution facts;
   the preview is for discovering the real parse/header. Structural anomaly
   candidates are still subject to the usual rules.
9. **Sort each part's candidates and greedily append whole facts.**
   Descending priority, preserving collection order for ties. Skip a
   fact that does not fit and continue trying later, possibly shorter facts.
   At data budgets of at least 600 characters, count rows use at most half
   the allocation when other data facts exist. This leaves room for ranges
   and distributions; compact repeated categories get higher priority than
   long value lists. There is no LLM selection here.
10. **Try an incomplete-view notice.** Append it only if space remains. Full
    omission reasons are retained internally even if a printed notice cannot
    fit.

Empty/zero row-limit settings do not request a fresh full table: row selection
still operates only over already-stored records. Internal column/detail/row
limits used by rendering or compaction are not new `observe` tool parameters.

### 6.2 Current fact priorities

These are ordering weights, **not confidence scores**. They apply after early
shape/schema/sample allocation:

| Candidate                                                                   |    Priority |
| --------------------------------------------------------------------------- | ----------: |
| First sample row, if not already placed in its reserve                      |         105 |
| Nonzero Cast conversion-failure count                                       |         100 |
| Upstream calculation summary at depth `d`                                   | `98 - d/10` |
| Scan coverage; Filter retention; Aggregate groups; Join output contribution |          96 |
| Aggregate per-reducer contributors; Join per-side coverage                  |          95 |
| Union, Window summary, Explode, Unpivot, Pivot, Distinct/Limit removal      |          94 |
| Window lag/lead null counters                                               |          93 |
| Changed null counts on relevant row-preserving columns                      |          90 |
| Filter predicate-column before/after profile                                |          88 |
| Relevant-column counts / other-column counts                                |     85 / 80 |
| Structural anomaly                                                          |          82 |
| UDF input/output counts with unknown-mapping qualification                  |          75 |
| Relevant-column values / other-column values                                |     65 / 60 |
| Relevant-column range / other-column range                                  |     62 / 57 |
| Zero Cast conversion-failure count                                          |          50 |
| Other unplaced sample rows, by zero-based selection rank `r`                |    `35 - r` |
| Scan source detail                                                          |          30 |
| Local operator contract                                                     |          25 |

### 6.3 What “combined” actually does

There is no third combined estimator. The implementation builds the same
candidate facts and enables both families:

```text
common table view
  + priority-selected(data candidates union flow candidates)
  subject to one B-character body limit
```

Consequently:

- Combined is not guaranteed to contain every line visible in DataOnly plus
  every line visible in FlowOnly.
- A high-priority flow fact can displace a data range or additional row; a data
  count can displace a low-priority flow contract.
- Enabling a family makes facts eligible, not mandatory. Small complete tables,
  missing metadata, and limited budgets can make enabled/disabled views identical.
- There is not yet universal cross-family deduplication. For example, a Filter
  before/after fact and an output-column count can both mention the same output
  null count. The renderer does suppress complete-table redundancy and
  unchanged transformation-null facts, but it does not claim all duplication
  has been eliminated.

Every observation records `options`, `resultVersion`, `inputs`, `selected`
fact IDs, immutable text chunks, and `omitted` reasons (`budget`, `disabled`,
`unavailable`, or `redundant_complete_table`). These lists support audits; the
model receives the selected text, not a second verbose metadata report.

## 7. What the model sees in the four configurations

### 7.1 Controlled example and tool call

These are verbatim result-body renders, not invented benchmark outputs. The
fixture was run through the real Python V2 runtime and worker collector, then
the TypeScript profile/version binding and production context assembler. The
input CSV has column `x` and values `[-1, 0, 10, 20, 30]`. The Filter produces
`[10, 20, 30]`; for this example, only its first row is retained in the stored
display sample, while profiling covers all three output rows.

The call deliberately puts the consumer before the producer. The shared
scheduler resolves this forward reference:

```json
{
  "operators": [
    {
      "op": "filter",
      "id": "selected",
      "input": "source",
      "columns": ["x"],
      "func": "def apply(row):\n    return row['x'] > 0"
    },
    {
      "op": "scan",
      "id": "source",
      "files": "data/example.csv"
    }
  ],
  "observe": ["selected"]
}
```

Each render below has `B=2000`, collection enabled, the same schema, and the
same stored sample. Only the evidence booleans differ. Common system/tool
instructions, action receipts, and operator-block wrappers are omitted here;
their placement is explained in section 8.

### 7.2 Neither enabled

`dataEvidence=false`, `flowEvidence=false`:

```text
Output Table: 3 rows, 1 cols
Columns: "x":int64
Sample stored row 1: 10
View incomplete; unshown rows/columns or evidence omitted.
```

The model can see the type, output size, and one real value. It is not shown
the full output distribution or the five-row input denominator as additional
evidence. Other ordinary receipts may still reveal an upstream row count.

### 7.3 Data only

`dataEvidence=true`, `flowEvidence=false`:

```text
Output Table: 3 rows, 1 cols
Columns: "x":int64
Sample stored row 1: 10
Data measurement: "x" (full=3 rows): null=0/3, nonnull=3; distinct(nonnull)=3.
Data measurement: "x" (full=3 rows): nonnull values=10:1, 20:1, 30:1; other=0.
Data measurement: "x" (full=3 rows): range=[10, 30].
View incomplete; unshown rows/columns or evidence omitted.
```

Now the model knows the output's distribution despite seeing only one sampled
row. It does not receive Filter-retention or before/after flow facts.

### 7.4 Flow only

`dataEvidence=false`, `flowEvidence=true`:

```text
Output Table: 3 rows, 1 cols
Columns: "x":int64
Sample stored row 1: 10
Flow measurement: Filter kept=3/5, rejected=2, null predicates=0 (nulls=drop).
Flow measurement: predicate column "x": input (full=5 rows) null=0/5, distinct(nonnull)=5; output (full=3 rows) null=0/3, distinct(nonnull)=3.
Flow guarantee: Filter: stable subset of input rows; predicate columns=["x"]; nulls=drop.
View incomplete; unshown rows/columns or evidence omitted.
```

The model sees the selection effect and its declared behavior. Notice the
profile-derived null/distinct comparison: it belongs to the flow channel.
There is no standalone output value-frequency or range fact.

### 7.5 Both enabled

`dataEvidence=true`, `flowEvidence=true`:

```text
Output Table: 3 rows, 1 cols
Columns: "x":int64
Sample stored row 1: 10
Flow measurement: Filter kept=3/5, rejected=2, null predicates=0 (nulls=drop).
Flow measurement: predicate column "x": input (full=5 rows) null=0/5, distinct(nonnull)=5; output (full=3 rows) null=0/3, distinct(nonnull)=3.
Data measurement: "x" (full=3 rows): null=0/3, nonnull=3; distinct(nonnull)=3.
Data measurement: "x" (full=3 rows): nonnull values=10:1, 20:1, 30:1; other=0.
Data measurement: "x" (full=3 rows): range=[10, 30].
Flow guarantee: Filter: stable subset of input rows; predicate columns=["x"]; nulls=drop.
View incomplete; unshown rows/columns or evidence omitted.
```

This small example fits every eligible fact. The combined order is by priority,
not a Data section followed by a Flow section.

| View      | Body length, including line breaks |
| --------- | ---------------------------------: |
| Neither   |                     130 characters |
| Data only |                     341 characters |
| Flow only |                     442 characters |
| Both      |                     653 characters |

These are character measurements of this fixture, not token or dollar-cost
predictions. A maximum budget is a ceiling; the no-evidence arm does not pad
its result to 2,000 characters.

### 7.6 Both enabled with a tighter budget

For exactly the same fixture with `B=500`, the actual combined render is:

```text
Output Table: 3 rows, 1 cols
Columns: "x":int64
Sample stored row 1: 10
Flow measurement: Filter kept=3/5, rejected=2, null predicates=0 (nulls=drop).
Flow measurement: predicate column "x": input (full=5 rows) null=0/5, distinct(nonnull)=5; output (full=3 rows) null=0/3, distinct(nonnull)=3.
Data measurement: "x" (full=3 rows): null=0/3, nonnull=3; distinct(nonnull)=3.
Data measurement: "x" (full=3 rows): nonnull values=10:1, 20:1, 30:1; other=0.
```

It uses 451 characters. The range and local contract do not fit, and neither
does the final incomplete-view notice. The audit records the range and contract
as omitted for `budget`. There is no attempt to partially cut a fact sentence to
fill the last 49 characters. The absence of a printed omission notice is not
proof of complete visibility.

### 7.7 Complete small table

If all three output records are actually stored, untruncated, and fit, the
no-evidence and DataOnly result bodies are identical:

```text
Output Table: 3 rows, 1 cols
Columns: "x":int64
Complete table (all rows):
10
20
30
```

Data facts are redundant with this complete table and are suppressed, even
when `dataEvidence=true`. FlowOnly and Combined can still append the Filter
retention, input/output comparison, and contract from the earlier example.
This is deliberate: seeing the entire output does not reveal how many input
rows were rejected.

For a raw Scan preview, “complete table” means the complete **preview output**,
not the complete underlying source. The Scan definition and, when enabled,
the flow coverage fact identify that distinction.

## 8. Where results appear in DELTA and LATEST

The result body above is the shared renderer. Layout decides where it is
placed; it does not create separate data or flow calculations.

### 8.1 DELTA: event-owned observations

With the normal service configuration, DELTA defaults to
`messageLayout: "native"`. The context assembler reconstructs the ordinary
user task, assistant tool calls, and matching tool-result messages. A dataflow
tool-result text contains its batch receipt followed by the event observation.
It does **not** resend every current operator's successful table on each step.

For the example, the observation excerpt is:

```text
Observation:

- scan operator `source` added
  result: executed, 5 rows; result not requested
- filter operator `selected` added
  Inputs: source
  result:
    Output Table: 3 rows, 1 cols
    Columns: "x":int64
    Sample stored row 1: 10
    [the selected evidence lines from the chosen configuration]
    View incomplete; unshown rows/columns or evidence omitted.
```

The square-bracketed line is an explanatory placeholder, not literal renderer
output. Substitute one of sections 7.2–7.5 to obtain the relevant body. The
complete batch receipt precedes this excerpt and retains `operators`, their
statuses/messages, `observe`, and any observation errors. The wire framing is:

```text
user:      task/context prefix
assistant: tool-call(dataflow, operators=[...], observe=["selected"])
tool:      matching tool-result(batch receipt + Observation above)
assistant: next tool-call, if any
tool:      that next event's observation
...
```

Each successful observation captures its exact text, evidence choices, input
bindings, and event DAG once. Later settings, added consumers, failures, or DAG
edits do not rewrite earlier DELTA evidence. Imported older events without a
recorded evidence frame are not retroactively enriched with newly enabled facts.

Compaction is subtractive: it may remove sample rows or truncate the sequence
of recorded chunks, but does not compute fresh facts, refill an old observation
from today's profile, or choose evidence using a later DAG.

### 8.2 LATEST: current dataflow

LATEST normally defaults to `messageLayout: "opSplit"`: task/current-dataflow
prefix plus separate operator-block messages, in creation order. It shows the
current definitions and currently requested results rather than a replay of
all past observations. A readable concatenation of the relevant blocks is:

```text
# User Task

Keep positive x values.

# Current Dataflow
## Operators

### scan operator `source`
Inputs: none
Properties: {"files":"data/example.csv"}
Result: executed, 5 rows; result not requested

### filter operator `selected`
Properties: {"columns":["x"],"func":"def apply(row):\n    return row['x'] > 0"}
Inputs: source
Result:
  Output Table: 3 rows, 1 cols
  Columns: "x":int64
  Sample stored row 1: 10
  [the selected evidence lines from the chosen configuration]
  View incomplete; unshown rows/columns or evidence omitted.
```

Again, the bracketed line stands for the chosen body, not actual text. The
production render also appends a compact last-completed-action receipt,
including the observe list and the qualification that tool completion does
not prove every operator executed successfully. A cached read gets a receipt
too, so its completion is not lost when LATEST replaces the previous view.

LATEST uses current evidence settings for current observed results. Visibility
is governed by the current batch observation, not a cumulative entitlement to
show every table ever observed. Earlier observations are not the main LATEST
context. Optional history/reasoning layouts are separate configuration choices.

### 8.3 Explicit observation, batching, and changed ancestors

To retrieve a stored result without edits or re-execution:

```json
{ "operators": [], "observe": ["selected"] }
```

Omitting `observe`, or passing `[]`, returns successful receipts rather than
table contents. Errors are an exception and remain visible. The model cannot
use `observe` to request disabled evidence or uncached rows. For a focused
table/column calculation it can add Project, Filter, Distinct, or Aggregate
operators and explicitly observe their outputs.

The batch implementation uses the **same `ToolCallScheduler` as parallel tool
calls** internally, while provider parallel tool calls are disabled in this
configuration. Chains/branches can reference existing operators or another
item anywhere in the batch. Dependencies are resolved through unchanged
existing DAG nodes as well. Mutations are applied in a stable topological
order. A failed producer blocks dependent edits; independent valid edits can
still succeed. Successful edits use the normal post-step execution path;
disconnected branches may need separate backend requests.

When an upstream definition changes, or a new upstream materialization replaces
the old one, descendants' old results are invalidated in the current snapshot.
Newly earned downstream results enter that event's DELTA even if the model did
not directly edit the downstream operator. **Their successful contents still
require an explicit observe entry.** Otherwise the event keeps a receipt such
as `re-executed ...; result not requested`, while prior DELTA observations
remain historical facts. LATEST reflects the current DAG/result state and does
not label the stale downstream result as a current valid measurement.

## 9. Errors and unavailable evidence

Neither evidence switch hides execution or validation failures. Error rendering
runs before successful-result budget selection and does not depend on the
observe list. It preserves the relevant operator/revision, stage, error code,
field, and submitted function location when available.

The important cases are:

- **Bad input table:** an `INPUT_*` diagnostic identifies the input index and
  producer before the consumer function runs. Repair the producer; the model
  should not repeatedly rewrite a consumer that never executed.
- **Bad output table/function:** an output or callback diagnostic points at the
  actual failed contract or submitted code.
- **Blocked downstream consumer:** use a compact reference to the root error
  only if a matching root diagnostic (operator/revision/code) is available in
  the same snapshot. Otherwise retain diagnostic detail so the consumer does
  not lose its only explanation.
- **Rejected edit:** retain the attempted-definition diagnostic without
  pretending the live DAG definition changed. Repeated unchanged invalid
  submissions are handled by validation-repair throttling.
- **Missing/invalid profile:** keep the valid table. Omit affected facts and
  record an unavailable reason. Missing, unknown, zero, and undefined are
  different states.

`inspectError` can retrieve saved diagnostics in the V2 tool surface. It is not
`inspectResult` and cannot retrieve successful table content or enable stats.
Diagnostic details are not answer-table rows. Old success evidence is not
attached to a failed revision.

## 10. Limitations and interpretation

The implementation intentionally does not claim:

- exact full-table distinct counts above its bounded dictionary capacity;
- uniform sampling, comprehensive distribution statistics, histograms,
  quantiles, correlations, or task-specific quality scores;
- semantic lineage through arbitrary UDF code;
- scientific correctness from row counts, type correctness, or a successful
  execution;
- exhaustive upstream explanation of an arbitrarily large DAG;
- a larger context budget when both channels are enabled;
- that an enabled channel must produce a line on every observation;
- that flow exposure is a clean removal of every profile-derived statistic
  when data exposure is off.

For experiments, describe the four arms as **evidence-exposure ablations**
over a common Python V2 operator framework. Hold collection, tools, sample
limits, model/reasoning, and layout fixed. Use fresh agents/run labels rather
than flipping switches halfway through a history: disabling data evidence does
not erase data facts legitimately shown in earlier DELTA events.

Lower observation size does not by itself establish lower task cost or better
accuracy. Cost also depends on the number of tool/model turns, generated code
and reasoning, how many operators are observed, accumulated history, and
provider cache hits. Use native benchmark scores and cache-aware `stats.json`
costs to evaluate that outcome separately.

## 11. Verification and source map

### 11.1 How this document was checked

The four result examples and the 500-character example were generated from
the five-row CSV fixture using the actual Python runtime, worker collector,
profile decoder, result-version binding, selector, and production DELTA/LATEST
context assembler. The only synthetic retrieval choice was retaining one
output row in the display sample. No LLM call or backend restart is needed for
this check.

Captured `archeology-easy-4` pilot `inputMessages` were also checked as a framing
sanity check: NoEvidence had neither measurement family; DataOnly had only
standalone data facts; FlowOnly had only flow facts; Combined had both. Those
traces follow different agent trajectories, so they are not the controlled
same-table examples above and do not establish a causal performance result.

Relevant existing tests can be run from `agent-service/`:

```bash
bun test \
  src/agent/native/evidence.test.ts \
  src/agent/native/evidence-settings.test.ts \
  src/agent/native/evidence-context.test.ts \
  src/agent/native/evidence-runtime.test.ts \
  src/agent/native/profiles.test.ts \
  src/agent/native/result-versions.test.ts \
  src/agent/tools/native-batch-tools.test.ts \
  src/agent/tools/native-batch-scheduler.test.ts \
  src/agent/tools/native-batch-context.test.ts
bun run typecheck
```

Worker-only profile/transport tests, from the repository root with its Python
environment and generated protobuf stubs available. On a fresh worktree, first
activate `.venv` and run `bash bin/python-proto-gen.sh` as described in the
[local setup guide](local-dev-with-agent.md); the transport test imports those
generated modules even though the standalone profiler does not need them:

```bash
PYTHONPATH=amber/src/main/python .venv/bin/python -m pytest \
  amber/src/test/python/core/util/test_table_profile.py \
  amber/src/test/python/core/runnables/test_structured_profile_transport.py
```

Documentation-checkpoint verification on 2026-09-16: **176 targeted TypeScript
tests passed, 23 Python profile/transport tests passed, and TypeScript checking
passed.** The four result bodies, the complete-table example, and the tight-budget
example were also checked against the Markdown text after formatting. Generated
Python stubs are local build artifacts, not part of this documentation commit.

The live `benchmark/e2e/native-program-run.ts` smoke (2026-09-22; it replaced
the `native-evidence-run.ts` / `native-diagnostics-run.ts` drivers of the
retired JSON batch tool) covers dependent batching, cached observation, error
repair and hidden-result behavior against a running Texera backend.
They are distinct from local unit tests and from paid real-model evaluation;
this documentation change does not initiate a new benchmark run.

### 11.2 Source of truth by responsibility

| Responsibility                                  | Source                                                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public settings/defaults                        | [`types/agent.ts`](../agent-service/src/types/agent.ts), [`native/settings.ts`](../agent-service/src/agent/native/settings.ts)                                                                                                      |
| Operator contracts and declared parameters      | [`catalog-v2.ts`](../agent-service/src/agent/native/catalog-v2.ts), [operator specification](native-python-dataflow-plan.md) (old exposure mapping superseded here)                                                                 |
| Actual operator execution and flow counters     | [`native/python/runtime.py`](../agent-service/src/agent/native/python/runtime.py): `execute_native`, `_filter`, `_aggregate`, `_join`, `_scan`, and shape operators                                                                 |
| Bounded output profiling                        | [`table_profile.py`](../amber/src/main/python/core/util/table_profile.py): `ProfileLimits`, `ProfileAccumulator`                                                                                                                    |
| Worker publication                              | [`data_processor.py`](../amber/src/main/python/core/runnables/data_processor.py): `_publish_table_profile`, `finish_table_profile`                                                                                                  |
| Profile validation/worker merge                 | [`profiles.ts`](../agent-service/src/agent/native/profiles.ts): `mergeTableProfiles`                                                                                                                                                |
| Execution/input/cache identity                  | [`result-versions.ts`](../agent-service/src/agent/native/result-versions.ts): `bindResultVersion`                                                                                                                                   |
| Data/flow candidates and shared-budget selector | [`evidence.ts`](../agent-service/src/agent/native/evidence.ts): `collectNativeEvidence`, `selectNativeObservation`, `restrictNativeObservation`                                                                                     |
| Dependency ranking and bound-input traversal    | [`evidence-lineage.ts`](../agent-service/src/agent/native/evidence-lineage.ts)                                                                                                                                                      |
| Immutable observations and invalidation         | [`workflow-snapshot-storage.ts`](../agent-service/src/agent/workflow-snapshot-storage.ts): `captureNativeObservations`, `setOperatorResult`                                                                                         |
| Batch schema, observe, dependency scheduling    | [`native-batch-tools.ts`](../agent-service/src/agent/tools/native-batch-tools.ts), [`tool-call-scheduler.ts`](../agent-service/src/agent/tools/tool-call-scheduler.ts)                                                              |
| Successful-result/error rendering               | [`result-formatting.ts`](../agent-service/src/agent/tools/result-formatting.ts)                                                                                                                                                     |
| DELTA/LATEST placement and provider framing     | [`context-utils.ts`](../agent-service/src/agent/util/context-utils.ts), [`native-frames.ts`](../agent-service/src/agent/context/summarize/native-frames.ts), [`server.ts`](../agent-service/src/server.ts): `buildContextAssembler` |
| Model instructions for evidence and observation | [`native-python-mode.md`](../agent-service/src/agent/prompts/native-python-mode.md)                                                                                                                                                 |

For removal/migration details, continue with
[Evidence-only context checkpoint](evidence-only-context.md). Historical
level-based experiment descriptions are not the specification for this path.
