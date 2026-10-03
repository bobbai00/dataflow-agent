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

# Calls, the request listing, and the system prompt

Building blocks and settings: [README.md](README.md).

The [approved system prompt](system-prompt.md) shows the restructured
shared core, its full operator catalog, examples using enabled data and flow
statistics, and a separate multi-task extension. The
[operator-definition reference](operator-definitions.md) also shows every
catalog entry and how an authored definition appears in a receipt. Complete
sample layouts are in [retrieve.md](retrieve.md#sample).

## A whole call

The tool message for one call is the receipts of its actions in order,
separated by blank lines, with no wrapper text (previously it opened with
`dataflow-actions: completed` and `Observation:`).

A call that fails validation runs nothing and has a single receipt:

```
### dataflow call rejected
- error CALL_REJECTED: action 2: "create" is a graph command; put it inside an edit: {"type": "edit", "changes": "create operator <id>: <expression>"}. No actions ran.
```

Other validation causes: `actions` sent as a string, an unknown action type, an
invalid field, a view the session does not offer, repeated `operator_ids`, an
answer that is not the last action, or an answer with `content` beside other
actions.

When an action fails, the actions after it are skipped, except `inspect` and
`retrieve` after a failed `execute`, which still read independent results:

```
### 2. execute: error
…

### 3. retrieve over_budget: skipped (action 2 failed)

### 4. retrieve spending: ok
…
```

## The request listing (gold-prefix protocol)

The "tables in force" section of a gold-prefix request is the operator index,
with list constants loaded as one-column tables (parquet scans); scalar
constants stay on one line:

```
Tables in force after task 4:
| operator | kind | inputs | result | task | columns |
|---|---|---|---|---|---|
| adult_ratings | values |  | 3 × 1 | 1 | rating |
| titles | scan |  | 8,807 × 21 | 1 | show_id, type, title, director, … +17 more |
| full_candidates | scan |  | 15 × 25 | 4 | country, content_credit, rank, … +22 more |
Constants in force: DECIMALS = 4; col = 'listed_in'
```

## How operators are defined in the system prompt

There is one catalog of operators, `NATIVE_OPERATORS` in
`agent-service/src/agent/native/catalog.ts`, and it is the specification for
everything else. Each entry gives:

| field | role |
|---|---|
| `name`, `type` | the name the model writes (`join`) and the runtime type (`Join`) |
| `inputs`, `rowEffect` | arity (0, 1, 2 or many) and what it does to rows (create, drop, add, collapse, multiply, none, unknown) |
| `signature` | the call with defaults, e.g. `join(L, R, on=None, how="inner", …)` |
| `brief` | the contract the system prompt shows |
| `doc` | a longer contract with an example, used by the reference document |
| `schema` | JSON Schema of the normalized parameters |
| `normalize` | turns the parsed arguments into those parameters, with the error messages the model sees |

The system prompt's operator catalog is generated from it by
`graphCatalogText()`: for each operator, its signature without the input
tables, a `Ports:` line and the `brief`. The parser validates every edit
against the same entries, and `native/python/runtime.py` implements them, so
the prompt, the validator and the engine cannot disagree; a test fails if the
prompt does not contain the generated catalog exactly. Rendered references:
`native-mode/OPERATORS.md` (the catalog with `doc`), `native-mode/SYSTEM_PROMPT.txt`
(the full default prompt), `native-mode/SYSTEM_PROMPT_WITH_STATE.txt` (with
history and the ledger), `native-mode/TOOLS.md` (the tool schema).

## System-prompt text that changes with this format

The prompt follows the structure agreed on 2026-10-03: the role and the
dataflow tool (actions, editing, the operator catalog, Python, reading
observations), then solving a task (with earlier tasks in a multi-task
session), then examples for a single task, reading statistics, several tasks
and earlier versions. Its observation passages describe exactly the blocks in
this specification, and every example receipt is real renderer output adapted
to the session's settings. [system-prompt.md](system-prompt.md) describes what
each setting adds; the generated variants are in [native-mode](../../native-mode).
