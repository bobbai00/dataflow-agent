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

# Observation format: specification

> This folder records the 2026-10-03 observation design. Its expression syntax,
> operator catalog, and history actions are historical. The current
> [registered-Python contract](../native-registered-python-design.md) retains
> Markdown reporting and coverage labels, with batched result retrieval and
> function registration receipts. Read the generated prompt below for the
> active interface.

Status: implemented, 2026-10-03. The approved format is used by native action
receipts, retrieved results, task catalogs and gold-prefix request listings.
See [validation.md](validation.md) for regression coverage and real Luna
benchmark results.

This specification fixes one format for every text the native agent reads
about its dataflow: the receipt of each action, the task entry in the catalog
(the ledger), and the table listing in a request. The samples use real values
from the gold-prefix pilot (Netflix, task 5) where one exists and the system
prompt's `orders`/`totals` example otherwise.

To see the format directly:

- [Sample records](retrieve.md#sample): complete Markdown, TSV and wide
  key-value receipts, plus quoted values and an announced text-cell cut.
- [System prompt](system-prompt.md): the complete shared prompt, with data
  and flow statistics enabled for review, four examples of using them, and a
  separate multi-task section with optional history, catalog and tools.
- [Operator definitions](operator-definitions.md): all 16 catalog entries,
  followed by the exact definitions in edit calls and inspection receipts,
  including attached Python functions.

The generated [default prompt](../../native-mode/SYSTEM_PROMPT.txt),
[prompt with statistics](../../native-mode/SYSTEM_PROMPT_WITH_EVIDENCE.txt),
[multi-task prompt](../../native-mode/SYSTEM_PROMPT_WITH_STATE.txt) and
[tool schema](../../native-mode/TOOLS.md) reflect the runtime implementation.
Regenerate them with `bun run render:native-reference` in `agent-service`;
the test suite checks that they stay in sync.

| file | covers |
|---|---|
| this file | requirements, building blocks, value rules, settings, decisions |
| [inspect.md](inspect.md) | `inspect` of the graph, of one operator, of a saved version |
| [edit.md](edit.md) | `edit` with each statement: create or replace an operator, rewire its inputs, delete it, restore or copy an earlier task's version |
| [execute.md](execute.md) | `execute` of the whole graph or a selection |
| [retrieve.md](retrieve.md) | `retrieve` in every view, with statistics and flow evidence |
| [answer-and-catalog.md](answer-and-catalog.md) | `answer` with `content` or `from`, and the catalog task entry |
| [calls-and-prompt.md](calls-and-prompt.md) | rejected calls, skipped actions, the request listing, and the system-prompt text that changes |
| [system-prompt.md](system-prompt.md) | restructured shared system prompt, statistics examples and multi-task extensions |
| [operator-definitions.md](operator-definitions.md) | complete prompt catalog and authored/inspected operator definitions |
| [validation.md](validation.md) | fixes, test coverage and Luna runs, including the fork-and-restore run against DSGym |
| [findings-and-plan-2026-10-03.md](findings-and-plan-2026-10-03.md) | why the dataflow agent lost to DSGym on later turns, and the change plan (working table, compacted history) |

Before this change the model read five styles: JSON from `inspect`, tab-separated
`Sample record:` lines from `retrieve`, pipe tables mixed with prose lines for
statistics, bracketed codes for errors (`[MISSING_COLUMN; execute; revision …]`),
and compact arrow lines in the ledger (`name 10,012×23 join ← a, b · …`).

## Requirements

1. **One syntax.** Every observation is Markdown: one `key: value` line per
   field, nested bullets for structure, and tables for records, statistics and
   operator lists. The table syntax is a setting (Markdown by default, TSV as
   the alternative). JSON stays only in the call, where the tool schema needs it.
2. **Mirror the edit language.** Definitions appear as assignments with their
   current inputs (`selected = project(orders, keep=["region"])`); edges as
   `orders -> selected`, with the port only when there are several; each change
   is one line (`operator x created (filter)`, `edge a -> x removed`).
   (Graph commands were the edit language until 2026-10-06.)
3. **Five building blocks.** Receipts, catalog entries and the request listing
   are composed only from the operator block, the operator index, the edge line,
   the table block and the issue line.
4. **Fixed fields in a fixed order.** A field is left out for one of two reasons
   only: it is empty, or it repeats what the same call already contains.
5. **One vocabulary.** Shapes, types, statuses, changes and states use the words
   listed under "Vocabulary" and no others.
6. **Exact values, announced cuts.** Records show integers exactly and
   fractions with 15 significant digits, which drops float64 rounding noise
   (`63.154`, not `63.153999999999996`); non-integer statistics round to 4
   significant digits, while integer bounds and counts stay exact. Every limit is a setting, and every cut says what was
   left out.
7. **Inputs before consumers.** Every list of operators is ordered so an
   operator appears after its inputs; ties keep creation order.
8. **Written once.** Nothing shown is rewritten later; a catalog entry is
   assembled from the same blocks when its task is answered.

## Vocabulary

| item | words |
|---|---|
| shape | `10,012 rows × 23 columns` in a block, `10,012 × 23` in an index row |
| column type | `str`, `int64`, `float64`, `bool`, `datetime` (the `cast` types) |
| action status | `ok`, `error`, `skipped` |
| change, in an edit or a catalog entry | `created`, `updated`, `deleted`, `reconnected` (edges only), `recomputed` (new result only), `stale` (result invalidated, not recomputed; catalog only), `restored from task N`, `forked from task N` |
| change, in a versions list | `created`, `updated`, `inputs changed`, `recomputed`, `restored from task N`, `deleted` |
| state, outside an edit | `executed`, `cached`, `stale`, `failed`, `not run`, `saved` (a copy showing an earlier task's result), `saved by task N` (an operator as an earlier task saved it) |
| issue kind | `error <CODE>`, `check`, `note`, `flow`, `not run` |

## Building blocks

### Operator block

```
- **fractional_title_join** (join, created)
  - definition: `join(on="show_id", how="inner", validate="many_to_one")`
  - inputs: left `fractional_credit`, right `titles`
  - result: 10,012 rows × 23 columns
  - columns: show_id str, country str, credit float64, title str, type str, release_year int64, date_added datetime, added_year float64, … +15 more
```

Fields, in this order:

| field | content | when present |
|---|---|---|
| header | `**<id>** (<kind>, <change or state>)` | always |
| definition | the assignment with its current inputs, `<id> = <operator>(<inputs>, …)`; a process shows `process(<inputs>, fn=…, doc="…")` | when the call does not already hold it |
| functions | the attached Python, in a fenced block | `inspect` with implementation only |
| inputs | names; ports only where there are several: `left`/`right`, `in[0]`/`in[1]` | operators with inputs |
| origin | `task N` (the task that last defined it) or `loaded` (unchanged since loaded state) | operators defined before the current task |
| result | shape, `shape (saved by task N)` for a copy not yet executed, or the state when there is no current result: `stale (execute to recompute)`, `not run`, `failed` | always after an edit has been executed once |
| columns | `name type` pairs, capped by `columnsShown` | completed results |
| used by | the operators that read it | `inspect` and provenance |
| issues | issue lines | when any |

### Operator index

The list form of the operator block: one row per operator, the block's header
fields as columns. Used in exactly two places, both of which list many
operators at once: the `inspect graph` receipt and the "tables in force"
listing in a gold-prefix request.

```
| operator | kind | inputs | result | task | columns |
|---|---|---|---|---|---|
| country_long | scan |  | 10,012 × 5 | loaded | show_id, country, country_position, country_count, country_credit_equal |
| fractional_credit | map | fractional_assignment | 10,012 × 3 | 5 | show_id, country, credit |
| fractional_title_join | join | left fractional_credit, right titles | 10,012 × 23 | 5 | show_id, country, credit, title, … +19 more |
```

Column names only; types appear in operator blocks and statistics.

### Edge line

```
- created edge: orders.out -> selected.in
- deleted edge: selected.out -> totals.in
```

### Table block

A table block is a one-line caption followed by the table. The caption says
what the rows are and what was cut.

Records, Markdown (default):

```
records: full; 5 of 5 rows, 3 of 3 columns (complete)
| country | fractional_rank | opportunity_score |
|---|---|---|
| Thailand | 1 | 56.75779857397504 |
| Turkey | 2 | 53.29955947136563 |
| Spain | 3 | 49.21670702179177 |
| Egypt | 4 | 44.11137868753762 |
| Taiwan | 5 | 38.2051282051282 |
```

The same records with `tableFormat: "tsv"`:

```
records: full; 5 of 5 rows, 3 of 3 columns (complete)
country	fractional_rank	opportunity_score
Thailand	1	56.75779857397504
Turkey	2	53.29955947136563
Spain	3	49.21670702179177
Egypt	4	44.11137868753762
Taiwan	5	38.2051282051282
```

A table wider than `keyValueColumns` (12) prints one key-value line per record
in either format, so no cell has to be matched to its header by position:

```
records: sample; 2 of 15 rows (retained records, not a random sample), 25 of 25 columns
- country: Thailand, content_credit: 61.25, rank: 1, opportunity_score: 56.75779857397504, …
- country: Turkey, content_credit: 48.5, rank: 2, opportunity_score: 53.29955947136563, …
```

The wide-record excerpt above is abbreviated for documentation. See
[the complete wide sample](retrieve.md#wide-sample-records-as-key-value-lines)
for a receipt with every displayed field written out. Every records caption
names the requested view before its coverage counts.

Statistics, one row per column:

```
statistics: full table, 10,012 of 10,012 rows
| column | type | nulls | distinct | values |
|---|---|---|---|---|
| show_id | str | 0 | unknown |  |
| country | str | 0 | 122 | top: United States 3,690; India 1,046; United Kingdom 806; Canada 445 (not exhaustive) |
| country_position | int64 | 0 | 12 | 1 to 12, mean 1.321 |
| country_count | int64 | 0 | 10 | 1 to 12, mean 1.643 |
| country_credit_equal | float64 | 0 | 10 | 0.08333 to 1, mean 0.7966 |
```

The `values` column reads `all: …` when the list is exhaustive, `top: … (not
exhaustive)` otherwise, and `min to max` for numbers and datetimes. A partial profile
says so in the caption: `statistics: first 2,000 of 10,012 rows`.

### Value rules

| value | printed as |
|---|---|
| missing | `null` |
| text | bare, except JSON-quoted when it is empty, could be read as another type (`"null"`, `"12"`, `"true"`), or contains the format's separator (`\|` in Markdown, a tab in TSV, `, ` or `: ` in key-value lines) |
| integer, float | exact, as stored; no thousands separators inside records |
| bool | `true`, `false` |
| datetime | ISO 8601 in UTC: `2019-12-31T00:00:00Z` |
| long text | sample views cut at `cellChars` with `…` and announce the clipped cells; full preserves retained cell contents |

Quotes preserve a text value's type; separators also need the layout's
escaping. Markdown cells escape a literal pipe as `\|`; JSON escapes preserve
tabs and newlines inside quoted text. A view with clipped cell contents is
incomplete even if it shows every row and column. See
[quoted values and clipped text](retrieve.md#quoted-values-and-clipped-text)
for complete examples.

### Issue line

```
- error MISSING_COLUMN: the function reads `added_year`, which input `fractional_genre_titles` does not have (its columns: show_id, country, credit, index, genre).
  - at: line 2 `return row["added_year"] is not None and row["added_year"] >= 2010 and …`
  - fix: read an existing column, or bring `added_year` in upstream.
- note: input `fractional_top_five` is a top-5 table; its unlimited parent `fractional_ranked` has 15 rows.
- flow: inner join of 10,012 left and 8,807 right rows produced 10,012 rows; all left rows matched.
- check: the header of `orders.csv` reads as data ("2019", "4.5"); skip_lines=1 gives the header region, amount.
- not run: fractional_country_genres, fractional_genre_counts (upstream `fractional_genre_period` failed)
```

| kind | source | previous format |
|---|---|---|
| `error <CODE>` | a failed operator or action; `at` and `fix` follow when known | `[ERROR] … [CODE; stage; revision] …` plus `Hint:`, `Field:`, `Diagnostic:` lines |
| `note` | what the system observed about the state: empty or top-k inputs, current pools, retyped literals, a replaced column, a renamed join column, booleans reduced as 1/0 | `note:` lines, ledger only, plus the adjustment lines |
| `flow` | measurements of how the result was produced: join matching, filter retention, cast failures, reducer denominators, window boundaries, scan sources | `Flow measurement:` and `Flow guarantee:` lines, `flowEvidence` only |
| `check` | a violated assumption found by `nativeChecks` | `check:` lines |
| `not run` | operators that did not run, grouped by cause | one `[ERROR] … not executed` line per operator |

The diagnostic identifier and the revision hash stay in the trace and leave the
model's text.

## Settings

| setting | governs | default |
|---|---|---|
| `tableFormat` | syntax of every table: records, statistics, operator index | `"markdown"`; `"tsv"` |
| `keyValueColumns` | widest table printed as a table; wider records print as key-value lines (0 never switches) | 12 |
| `columnsShown` | column entries in a block or index row; numbered runs compressed (`Q6_1..Q6_12`) | 16 |
| `definitionChars` | definition length in catalog entries and provenance blocks (`inspect` shows it whole) | 200 |
| `cellChars` | longest sample text cell before `…`; full does not apply sample clipping | 160 |
| `maxResultRows`, `maxOperatorResultCharLimit`, `fullResultCharLimit` | records per view (existing settings) | 50 rows; 2,000 and 5,000 characters |
| `dataEvidenceCharLimit`, `topValues` | statistics budget and top values per column | 2,000; 4 |
| `flowEvidenceCharLimit` | flow lines per retrieve (existing setting) | 2,000 |
| `catalogRecords` | rows of each table retrieved in a task, repeated in its catalog entry (0 = off) | 0 |
| `answerEcho` | repeat an answer's `content` in its receipt | false |
| `multiTask` | include the separate session section from the first request; also enabled by history/catalog capabilities or subsequent requests | false |

For format limits, 0 means unlimited, except `catalogRecords: 0`, which
disables catalog records, and `keyValueColumns: 0`, which keeps records in
tables. Format settings can be patched atomically; earlier receipts and
catalog entries retain their original representation.

## Decisions

Implemented decisions:

1. Markdown is the default syntax; `tableFormat` switches tables to TSV.
2. The operator index appears only in `inspect graph` and the request listing.

3. **Edit receipts leave definitions out,** because the call directly above
   holds them. A restore is the exception, since its definition is not in the
   call.
4. **Execute lists only operators with an issue;** the rest are counted.
5. **Catalog records are off by default:** with full history, the retrieve
   receipts already hold them.
6. **Wide records switch to key-value lines past 12 columns.** In the one
   controlled comparison found (GPT-4.1-nano, 1,000 records × 8 attributes),
   key-value records scored 60.7%, Markdown tables 51.9%, CSV 44.3%; not yet
   tested on our models and tables.
7. **Earlier versions are edit statements.** The `fork` action left the tool
   schema (2026-10-03, replacing `rollback`); since 2026-10-06
   `new_name = at(name, task=N)` copies a saved version and `name = at(name, task=N)`
   restores it in place.
