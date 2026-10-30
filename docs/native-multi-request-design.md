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
its registered functions, and a later request follows the whole earlier
transcript. The setting `multiRequest` is decided before the first request and
kept for the session:

| `multiRequest` | multi-request features |
|---|---|
| `off` (default) | none: the single-request prompt and receipts are unchanged |
| `transcript` | prompt section 5 (working across requests), function signatures in edit receipts, and notes on constant columns |

A request can instead see the task catalog in place of the earlier requests
(below). The catalog entries of 2026-10-11 (`multiRequest: "catalog"`) and
the study that compared them with the transcript are in
[archived/native-multi-request-design.md](archived/native-multi-request-design.md).

## Receipts and checks

With several requests, an edit receipt names what a later call can vary:

```text
## edits applied
functions:
- eligible_units(orders, *, min_orders=5) registered
- tidy(table) updated (no settings)
```

An executed Python step that adds a column which is 0, or null, in every row of
a working table (at least 10 rows, profiled in full) gets a note:

```text
note: column "player_move" is 0 in all 86 rows.
```

On 2026-10-09 an NFL session ranked "largest gaps" that were all 0, and nearly
every later score inherited them. Constant labels, broadcast thresholds, small
answer tables, filters, built-ins and partial profiles get no note. The first
version took any single value and flagged 157 columns in the 2026-10-11 Luna
campaign, two thirds of them in tables of five rows or fewer; under the current
rule about 3 of those remain.

## Prompt

Section 5 says how to work across requests: write each rule as a small
function with its choices as keyword settings. To change a rule from now on,
set its operator again; to compare, give the variant a new ID. Keep earlier
tables. It shows one example in general terms (`eligible_units`, `unit_scores`).

## The task catalog

A request sent with `contextTasks`, the earlier tasks it builds on (numbered
from 1 in the order they were asked), sees one block instead of the earlier
requests. It is rendered from the graph as the request starts and shown with
that request only; the request's stored text stays as it was sent. The block
holds:

- the session's instructions (the first request's text);
- every earlier task in order: what it asked, how it changed the dataflow
  (operators it created, set again or deleted) and what it answered;
- the tasks the request builds on in detail: each changed table's statement
  and columns, what the task saw of it when it displayed it (its own
  `show result`, up to 2,500 characters) or else its rows (12 rows whole, a
  larger table 3), its function's source, the earlier tables the task read,
  and its whole answer (up to 3,000 characters);
- the tables those are built from, back to the files: each one's statement,
  task and shape, and its function's source when it is not shown above.

A table counts as set again when its statement or the source of a definition
its function reaches changed; a rewritten import line is not a change. The
request's own calls follow the block as in any transcript. LongDS's
`catalog-gold` arm sends each request's annotated dependencies.

## Code

- `agent-service/src/agent/task-catalog.ts`: the session's requests and the
  task catalog (`renderTaskCatalog`). `TexeraAgent.sendMessage` renders it,
  and `contextSteps` puts it before the request in place of the earlier ones.
- `agent-service/src/agent/native/turn-receipt.ts`, `tools/dataflow-action-runtime.ts`:
  signatures in receipts.
- `agent-service/src/agent/native/checks.ts` (`constantColumnLines`): constant-column notes.
- `agent-service/src/agent/prompts/native-multi-request.md`: section 5.
- `benchmark/longds/`: the LongDS session runners, judge, behavior and report.

Tests: `multi-request.test.ts` (a scripted session: the transcript layout,
signatures in receipts, the prompt section, the setting guard, the task
catalog), `checks.test.ts`, `turn-receipt.test.ts`,
`evidence-settings.test.ts`, and `benchmark/longds/test_longds.py`.
