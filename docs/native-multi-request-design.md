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

A native agent can serve a session of dependent requests, such as a LongDS
Lite session of 15 to 42 requests over one dataset
([benchmark/longds](../benchmark/longds/README.md)). The requests share one
Dataflow and its registered functions, so a later request builds on the
tables and functions earlier ones left. Two things decide how such a session
runs: the `multiRequest` setting, and whether a request is sent with
`contextTasks`. Without `contextTasks`, every request's context is the whole
earlier transcript, whatever `multiRequest` says.

## `multiRequest`

`multiRequest` takes `"off"` (the default) or `"transcript"`. It is decided
before the first request: once a request was asked, changing it is refused,
because the system prompt depends on it. `"transcript"` changes four things:

- **Prompt.** Section 5, working across requests
  ([`prompts/native-multi-request.md`](../agent-service/src/agent/prompts/native-multi-request.md)),
  tells the model to write each rule a request states as a small function with
  its choices as keyword settings. To change a rule from now on, set its
  operator again so everything built on it follows; to compare a variant, run
  the same function under new IDs; keep earlier tables and build on them. Its
  example uses `eligible_units` and `unit_scores`.
- **Edit receipts.** Each registered or updated function is listed with its
  signature, so a later call sees what it can vary:

  ```text
  ## edits applied
  functions:
  - eligible_units(orders, *, min_orders=5) registered
  - tidy(table) updated (no settings)
  ```

- **Constant columns.** An execute receipt notes a column that a custom
  function or a `map` added and left 0, or null, in every row
  (`constantColumnLines` in `agent-service/src/agent/native/checks.ts`):

  ```text
  - note: column "gap" is 0 in all 86 rows.
  ```

  Only custom functions and `map` are checked. The note needs a table of at
  least 10 rows and a profile of all of it, skips columns the step's inputs
  already had, and names at most three columns. Such a column flows silently
  into every later result built on it: a LongDS session once ranked "largest
  gaps" that were all 0. A first version flagged any single-valued column and
  fired mostly on small answer tables, where equal values are often the
  answer; hence the row minimum and the restriction to 0 and null.
- **Answers.** A reply without a tool call counts as the answer only after a
  `show result` in the same request succeeded. With `"off"`, a successful
  `show result` anywhere on the conversation's branch is enough.

## The task catalog

A request sent with `contextTasks` (`POST /api/agents/:id/message`; task
numbers from 1, in the order the requests were asked) does not see the earlier
requests. In their place its context opens with one block, the task catalog,
rendered from the graph as the request starts (`renderTaskCatalog` in
`agent-service/src/agent/task-catalog.ts`). `TexeraAgent.contextSteps` puts the
block before the request's own text, in that request's context only; the
stored request text stays as sent, and the request's own calls follow as in
any transcript. An empty list still replaces the earlier requests, with no
task in detail. The block holds:

- the session's instructions: the first request's text;
- every earlier task in order: what it asked, how it changed the dataflow
  (operators created, set again or deleted, with their shapes) and what it
  answered, clipped at 300 characters;
- the tasks named in `contextTasks`, in detail: each table the task created or
  set again, with its statement and columns; what the task saw of it in its
  own `show result` (up to 2,500 characters), or else its rows (a table of up
  to 12 rows whole, a larger one 3 rows); its function's source; the earlier
  tables the task read; and its whole answer (up to 3,000 characters);
- the tables those are built from, back to the files: each one's statement,
  task and shape, and its function's source when it is not shown above.

A table counts as set again when its statement, or the source of a definition
its function reaches, changed. Imports are left out of that comparison, so
rewriting an import line is not a change. The block tells the model to build
on any table by name, to read what is not shown with `show result`,
`show schema` and `show function`, and to recompute a result a named task
needs when it is no longer in the graph.

## LongDS

`benchmark/longds/run_session.py` runs one session with one agent, workflow
and computing unit. Both of its arms set `multiRequest: "transcript"` and end
every request with a line naming the earlier tasks it builds on (the
benchmark's annotated `depends_tasks`):

- `transcript-depnote`: each request sees the whole earlier transcript;
- `catalog-gold`: every request after the first is sent with `contextTasks`
  set to those annotated tasks.

The smolagents baseline (`benchmark/longds/smolagents_session.py`, arm
`smolagents-depnote`) gets the same requests and the whole transcript.

## Code and tests

- `agent-service/src/agent/task-catalog.ts`: the session's requests and the
  task catalog; `TexeraAgent.sendMessage` renders it.
- `agent-service/src/agent/tools/dataflow-action-runtime.ts` and
  `agent-service/src/agent/native/turn-receipt.ts`: signatures in edit
  receipts, constant-column notes in execute receipts.
- `agent-service/src/agent/native/checks.ts`: `constantColumnLines`.
- `agent-service/src/agent/prompts/native-multi-request.md`: section 5.
- `benchmark/longds/`: the session runners, the judge, the behavior analysis
  (reuse of functions and tables across requests) and the report.

Tests: `agent-service/src/agent/multi-request.test.ts` (a scripted session:
signatures in receipts, the prompt section, the setting guard, the transcript
layout, the task catalog), `agent-service/src/agent/native/checks.test.ts`,
`agent-service/src/agent/native/turn-receipt.test.ts`,
`agent-service/src/agent/native/evidence-settings.test.ts`, and
`benchmark/longds/test_longds.py`.
