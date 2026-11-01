# Retrieval views, statistics and runtime stats

`show result` displays a computed result in one of two views. `sample_stats`
shows a few records plus column statistics; `full` shows every record that
fits a character cap. With `flowEvidence` on, receipts also carry
`- runtime stats:` lines, facts the engine measured while operators ran.
`show result` first computes what is stale, then renders from the result the
agent already holds; the read itself never executes, so changing the view
never recomputes. The statements themselves are in
[Registered Python Dataflows](native-registered-python-design.md).

## Reading a result

```text
show result joined, checks
show result joined full
show result wide[Beach Name, "Sample Date"]
show schema wide from 200
```

Without a view, `show result` uses `sample_stats` when the session offers it,
else `full`. The view applies to every target, and each target has its own
status and result block, so a missing or stale target does not hide the
others. A column selection (`[...]`) takes one target; a name that holds a
comma, or spaces at either end, must be quoted, and an unknown name fails with
`UNKNOWN_COLUMN` and the result's column list. Statistics then cover only the
selected columns.

`show schema <id>` computes a missing or stale result first, then reads its
stored schema regardless of record and statistics budgets: up to 200 columns
and 20,000 characters per page, with `next_offset` (a zero-based column index)
when more remain. A scanned workbook's receipt lists its sheet names;
`scan(..., sheet='name')` reads one.

## The two views

| View | Records | Statistics |
|---|---|---|
| `sample_stats` | at most `maxResultRows` rows (default 3; 0 means no row cap) within `maxOperatorResultCharLimit` characters (default 2,000); text cells clipped at 160 characters | column statistics within their own 2,000 characters |
| `full` | every retained row within `fullResultCharLimit` characters (default 5,000); cells not clipped | none |

A result's records start with a `columns:` line and a caption, for example
`records: sample_stats; 3 of 10,012 rows, 8 of 8 columns (first and last
retained records; … marks omitted rows)`. The caption's notes say what is
missing:

- `complete`: every row and column is shown, nothing was clipped, and the
  engine transported the whole table. Only then is a result complete.
- `all rows`: every row, but not every column or cell.
- `first and last retained records; … marks omitted rows` (preceded by `one
  row per cell pattern, then` when patterns chose rows), or `retained records,
  not a random sample`: a sample.
- `cut at N characters`, `N clipped cells`, `columns requested`,
  `first N rows; the whole table exceeds N characters` (`fullPreviewRows`),
  and `source preview only` (a `scan(..., preview=n)`, whose completeness
  refers to the preview, not the source file).

A sample takes one row of each cell pattern (missing, number-like or text per
column; common patterns first, the all-missing one last) when the table has a
few repeating patterns, then rows alternately from the head and the tail of
the retained rows, and shows them in table order with `…` gaps
(`native/observation-format.ts`). If no row of a wide sample fits the budget,
columns are dropped, keeping first the ones this operator and the operators
downstream of it use. Records with more than `keyValueColumns` columns
(default 12) are written one `column: value` line per field; `tableFormat`
chooses a Markdown or tab-separated table. A chart's HTML is replaced by a
placeholder naming its size.

## Data statistics

Statistics appear only in `sample_stats` (`native/evidence.ts`,
`selectNativeObservation`):

```text
statistics: full table, 10,012 of 10,012 rows, 8 of 8 columns
| column | type | nulls | distinct | values |
```

`values` holds the range of a numeric or datetime column, never clipped, and
up to four frequent values (`all:` when they are every value, else `top:` with
the remaining count marked `not exhaustive`), each clipped at 40 characters. A
partial profile says `partial profile` and that its values describe profiled
rows only. Columns that do not fit the 2,000-character budget are left out; a
note follows when the table has duplicate rows, all-null rows or all-null
columns. Instead of a table the block says:

- `statistics: not shown; the complete records above show every value` when
  the records are complete;
- `statistics: unavailable for raw lines; parse them into columns first` for a
  table of raw text lines;
- `statistics: unavailable for this result` when there is no valid profile, or
  the profile covered no rows of a nonempty table.

With `dataHygiene` on, an incomplete `full` view adds a line naming the
columns that hold nulls, with their counts. The statistics describe the
requested table; they do not show that the computation answers the task.

### Where statistics come from

1. With `nativeProfileCollection` on (the default), every operator is compiled
   with a `profileCollection` flag. The flag is fixed once a workflow has
   operators; changing it needs a fresh agent and workflow.
2. In the amber Python worker, `_publish_table_profile`
   (`amber/src/main/python/core/runnables/data_processor.py`) feeds each
   DataFrame the operator yields to a `ProfileAccumulator`
   (`amber/src/main/python/core/util/table_profile.py`). Counts, nulls,
   ranges and distinct counts are exact over every row the worker yields, for
   up to 128 columns. A column keeps its value list (and so its frequent
   values) only while it has at most 256 distinct values of at most 192
   characters each; the top 8 are sent. The envelope (`protocol:
   "texera.table-profile"`) also carries the runtime's operation counters, is
   limited to 64 KiB, and travels under a reserved key in the worker's
   statistics.
3. The synchronous execution endpoint
   (`amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala`)
   returns the envelopes as each operator's `resultMetadata`.
4. The agent merges the workers' envelopes (`mergeTableProfiles` in
   `agent-service/src/agent/native/profiles.ts`), checks them against the
   result's row count, schema and operator revision, and keeps the profile
   with the result as `OperatorInfo.tableProfile`
   (`agent-service/src/agent/native/result-versions.ts`): in memory, and in
   the agent's SQLite trace store unless `AGENT_TRACE_DB=off`, from which a
   restored agent reloads it. Nothing writes statistics to the data lake; the
   Postgres column `operator_port_cache.result_statistics_json`
   (`sql/texera_ddl.sql`) is unused.

When the engine serves a result from its port cache, the agent takes no
profile from the response: it reuses the profile of the matching earlier
result it holds, and without one the statistics are unavailable. A profile is
partial only when a worker's envelope is missing or unfinished. With several
workers, distinct counts merge through the value lists, and duplicate-row
counts and operation counters are dropped.

The envelope still names its algorithm `bounded-exact-v1` with
`rowSelection: "prefix"`, and the agent's schema requires those values. They
are labels kept from when profiles could stop after a row prefix; profiles now
always cover the whole table, and the bound applies to value lists and payload
size, not rows. The prompt's statistics paragraph still says profiles "may
cover only a row prefix".

## Runtime stats

With `flowEvidence` on, the prompt explains `- runtime stats:` lines and
receipts carry them. They come from the operation counters in the table
profile, so they also need profile collection.

- An `## execute` or `## show result` section lists each operator that just
  ran with its own lines.
- `## show result` adds up to three summaries of the target's producing
  ancestors, as `- runtime stats (<id>): ...`. The walk follows the exact
  input result versions that produced the target, visits at most 32
  operators, and stops at depth 8. It passes through custom functions; a fact
  from before one is labeled `Before custom processing; row/column
  correspondence to this output unknown`. Stale, failed or unbound results
  contribute nothing.
- The lines share a 2,000-character budget, separate from records and
  statistics; `- note: flow facts omitted (budget).` marks the rest. Within one
  receipt a fact already printed is not printed again.

A line reports only what an operator's definition does not already say.
Matched and unmatched join counts, kept and rejected filter counts and group
sizes are recorded but not shown. What is shown:

| Operator | Runtime stats |
|---|---|
| `filter` | rows dropped by a None verdict; rejected text values that equal a literal of the condition or a kept value except for case, spacing, punctuation or leading zeros, or that contain a literal; when no row passed a test for literals, the values that reached it |
| `join` | left keys that match a right key only when written alike, with up to three pairs; a join that matched no key, with a key from each side |
| `cast` with `errors="null"` | values that could not be converted, with up to three first-encountered examples |
| `aggregate` | a group key that pools rows with different values of another column; input records repeated across sources, or repeats in a column that otherwise identifies rows; rows marked as excluded that are still counted |
| `distinct` | removed rows that differ in other columns, or that share an empty key |
| `scan` | source files without data rows; records listed in several files |
| `project` | a dropped exclusion-mark column whose marked rows stay in the table |
| `window`, `union`, `unpivot`, `pivot` | ties beyond the first, columns filled with null, retained null cells, absent cells |
| custom functions | inside the function (with cell and line): merges and `.map` lookups whose keys match only when written alike, merges or row selections that return no rows, concatenations that list records several times, `drop_duplicates` removing rows that differ; records listed in several of the files it read; a file with several same-named columns of which it read only some; repeated values in an output column that otherwise identifies rows |

Examples are first-encountered values, not top values or random samples.
Long values are clipped and labeled; clipping never changes counting or key
matching. The measurements describe what ran; they do not establish why a row
was rejected or that a fix is right.

## Settings

The retrieval and evidence settings, with their defaults
(`DEFAULT_AGENT_SETTINGS` in `agent-service/src/types/agent.ts`):

```json
{
  "retrievalViews": ["sample_stats", "full"],
  "fullResultCharLimit": 5000,
  "maxOperatorResultCharLimit": 2000,
  "maxResultRows": 3,
  "nativeProfileCollection": true,
  "dataEvidence": true,
  "flowEvidence": false,
  "tableFormat": "markdown",
  "keyValueColumns": 12,
  "fullPreviewRows": 0,
  "compactRecords": false,
  "dataHygiene": false
}
```

- `retrievalViews` is a nonempty list of unique `full` and `sample_stats`. It
  decides which views the parser accepts and which the prompt describes; a
  call naming another view is rejected before anything runs. `["full"]` turns
  data statistics off.
- `fullResultCharLimit` is an integer from 128 to 100,000.
- The statistics and runtime-stats budgets are fixed at 2,000 characters each
  (`EVIDENCE_CHAR_LIMIT` in `native/retrieval.ts`).
- `dataEvidence` is accepted and reported but changes nothing a model sees:
  statistics depend only on the view.
- `fullPreviewRows` caps a `full` view of a table that exceeds its budget at
  its first rows (0 shows as many as fit); tables read from files, previews and
  column selections are not capped. `compactRecords` drops the `columns:` line
  when the statistics list every column with its type.

Every execution fetches each result up to 100,000 characters (20,000 per cell),
whatever the view and the display caps, so switching views or raising a cap
never executes. Raising a cap cannot recover rows the engine did not send;
such results stay labeled incomplete. The view never changes the graph, the
result version or the engine's cache key.

## Experiment arms

`benchmark/bench run` runs the arms in `benchmark/src/bobbench/arms.py`. `evidence_full_flow{0,1}` offer only
`full`; `evidence_data1_flow{0,1}` offer `sample_stats` and `full`; the flow
digit sets `flowEvidence`. The runner keeps `nativeProfileCollection` on for
every arm, so the arms differ in what the model sees, not in what the engine
collects. It sets its own budgets (`--full-result-char-limit`, default 5,000;
`--sample-char-limit`, default 1,000, as `maxOperatorResultCharLimit`;
`maxResultRows` 3), so read an arm's recorded settings, not the service
defaults. The other arms in that file vary the observation format on top of
`evidence_data1_flow0`.

## Code and tests

In `agent-service/src/agent/`: `native/retrieval.ts` (views and budgets),
`native/observation-format.ts` (records), `native/evidence.ts` and
`native/evidence-lineage.ts` (statistics, runtime stats, the ancestor walk),
`native/profiles.ts` (profile merge), `native/turn-receipt.ts` (receipts).
Tests: `native/retrieval.test.ts`, `native/evidence*.test.ts`,
`native/profiles.test.ts`, `native/observation-format.test.ts`,
`native/observation-integration.test.ts`, and, in amber,
`amber/src/test/python/core/util/test_table_profile.py`.
