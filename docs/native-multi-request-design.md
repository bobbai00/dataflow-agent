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

# Several requests in one session

A native agent can serve a session of several requests, for example a LongDS
session of 32 or 42 dependent questions. Every request shares one Dataflow and
its registered functions. The setting `multiRequest` is decided before the
first request and kept for the session:

| `multiRequest` | earlier requests in the context | multi-request features |
|---|---|---|
| `off` (default) | their calls and observations, as one transcript | none: single-request prompt and receipts are unchanged |
| `transcript` | their calls and observations, as one transcript | yes |
| `catalog` | each earlier request's text, then one catalog entry | yes |

The features are prompt section 5 (working across requests), function
signatures in edit receipts, and notes on constant columns. `catalog` needs the
delta context with the native message layout; other combinations are refused.

## Why a catalog and not versions

An audit of the 24 Lite gold programs (777 cells) and of four NFL agent
traces found:

- **Versions are not needed.** Of 213 Rollback and Counterfactual turns in the
  gold, 150 (70%) build the alternative under a new name from state that still
  exists. Agents re-set a table from an earlier question once in 430 `set`
  statements. Rollbacks are compositional: 62 of the 89 that name an earlier
  state keep current parts too, so restoring a whole table's earlier version
  would revert what the question keeps.
- **Long-span reads are.** 82% of revisit turns read a named table from at
  least 10 questions back, and 52% from at least 20. A transcript keeps that
  table's columns hundreds of messages away; a catalog lists them in one entry.
- **Rule reuse is the gap.** 16% of the gold's Update, Rollback and
  Counterfactual turns call an earlier rule function with new settings, for
  example Netflix `country_credit('primary')`, then
  `('lead', lead_weight=0.6)`, then `0.8`. Agents called an earlier
  question's function 0 times and wrote 2.6 to 3.05 new functions per question.

## The catalog entry

An entry is what a request left in the Dataflow, read from two saved
snapshots: the state it inherited and the state it left. A finished request's
entry therefore never changes, and the context only grows at its end. In a
three-request Luna session, request 3's first call read 6,360 of its 7,521
input tokens from the cache: everything through request 2's text.

Request 2 of that Netflix session, as request 3 saw it (code shortened):

````text
## Task 2 (answered)
functions:
- `shared_market_opportunity(raw)` — Clean titles, assign equal fractional credit to each listed production country, and rank markets using the first-pass opportunity score.
```python
def shared_market_opportunity(raw):
    """Clean titles, assign equal fractional credit to ..."""
    ...
```
operators:
- **shared_market_top** (shared_market_opportunity, created)
  - definition: `set shared_market_top: shared_market_opportunity(raw_titles)`
  - inputs: `raw_titles` (task 1)
  - result: 5 rows × 7 columns
  - columns: market str, rank int64, score float64, scale_percentile float64, balance_percentile float64, expansion_percentile float64, title_credits float64
shown: `shared_market_top`
answer: {"markets":[{"market":"UK","score":0.7200, ...}],"entered":[],"fell_out":[]}
````

- **Functions**: one API line per public function the request registered or
  changed (signature and the docstring's first line), then the source of every
  binding it changed, in definition order. An operator block omits a
  signature listed in an earlier entry.
- **Operators**: the canonical blocks of `show operator`, in first-edit order,
  each with every column. A later step in a chain states its columns relative
  to its first input (`same as units; plus score float64`). An input the
  request did not touch names the earliest task that left it
  (`raw_titles (task 1)`).
- **State of an update**: `updated: min_orders 5 → 10` when only settings
  changed, `updated: restored task 1's version` when an earlier definition
  returns, and `updated: the definitions its function uses changed`.
- **Notes**: `empty table`, `limited table; its input has 8 rows`, `one-row aggregate`.
- `deleted:`, `shown:` (results it displayed), and `answer:`. A request that
  failed or was stopped is `incomplete`, with `answer: No completed answer.`;
  its last step carries `endReason`.

Entries carry no records: the model uses `show result` on an earlier table to
read its values.

## Receipts and checks

With several requests, an edit receipt names what a later call can vary:

```text
## edits applied
functions:
- eligible_units(orders, *, min_orders=5) registered
- tidy(table) updated (no settings)
```

An executed Python step whose whole-table profile shows a column it added that
holds one value in every row, or no value at all, gets a note:

```text
note: column "gap" has the same value, 0, in all 12 rows.
```

On 2026-10-09 an NFL session ranked "largest gaps" that were all 0, and nearly
every later score inherited them. Filters, built-ins, one-row results and partial
profiles get no note.

## Prompt

Section 5 says how to work across requests: write each rule as a small
function with its choices as keyword settings. To change a rule from now on,
set its operator again; to compare, give the variant a new ID. Keep earlier
tables. It shows one example in general terms (`eligible_units`, `unit_scores`). The full
catalog-mode prompt is generated as
[native-mode/SYSTEM_PROMPT_CATALOG.txt](../native-mode/SYSTEM_PROMPT_CATALOG.txt).

## Code

- `agent-service/src/agent/request-catalog.ts`: requests on the visible path
  and their entries, cached per snapshot storage.
- `agent-service/src/agent/util/context-utils.ts` (`catalogContext`): request
  1 under its heading, later requests as plain turns, then the current
  request's own transcript.
- `agent-service/src/agent/native/turn-receipt.ts`, `tools/dataflow-action-runtime.ts`:
  signatures in receipts.
- `agent-service/src/agent/native/checks.ts` (`constantColumnLines`): constant-column notes.
- `agent-service/src/agent/prompts/native-multi-request.md`: section 5.
- `benchmark/longds/`: the LongDS session runner, judge, behavior and report.

Tests: `request-catalog.test.ts` (a scripted three-request session: entry
text, byte-identical prefixes across requests, restores, changed functions,
failed requests, transcript mode, the setting guard), `checks.test.ts`,
`turn-receipt.test.ts`, `evidence-settings.test.ts`, and
`benchmark/longds/test_longds.py`.
