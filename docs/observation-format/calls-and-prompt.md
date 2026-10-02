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

## A whole call

The tool message for one call is the receipts of its actions in order,
separated by blank lines, with no wrapper text (today it opens with
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
with list constants loaded as `values` tables; scalar constants stay on one
line:

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

The system prompt's "Operators" section is generated from it by
`graphCatalogText()`: for each operator, its signature without the input
tables, a `Ports:` line and the `brief`. The parser validates every edit
against the same entries, and `native/python/runtime.py` implements them, so
the prompt, the validator and the engine cannot disagree; a test fails if the
prompt does not contain the generated catalog exactly. Rendered references:
`native-mode/OPERATORS.md` (the catalog with `doc`), `native-mode/SYSTEM_PROMPT.txt`
(the full default prompt), `native-mode/SYSTEM_PROMPT_WITH_STATE.txt` (with
history and the ledger), `native-mode/TOOLS.md` (the tool schema).

## System-prompt text that changes with this format

Only the passages that describe observations change; the rest of the prompt
does not mention their format.

1. **New, under "The dataflow tool":** one paragraph on how to read a receipt.

   > Each action's receipt opens with `### <n>. <action> <target>: <status>`
   > and a summary line. An operator appears as a block, `- **id** (kind,
   > state)` followed by its definition, inputs, result and columns; a table
   > appears as a caption that says how many rows and columns it shows of how
   > many, followed by the table. Issues follow the block they concern:
   > `error <CODE>` with where and how to fix it, `note` for what the system
   > observed, `not run` for operators that did not run.

2. **"Run and read":** "Retrieval reports the returned and total rows and
   columns and whether the view is complete" becomes "Each table's caption says
   how many rows and columns it shows, of how many, and whether that is the
   whole table."
3. **Statistics** (`nativeEvidenceText`): the paragraph about "Data measurement
   lines" and "other=0" becomes a description of the statistics table: one row
   per column with nulls, distinct values and `min to max, mean` or the top
   values; `all:` means the list is exhaustive, `top: … (not exhaustive)` that it
   is not.
4. **Flow evidence:** "Flow measurement lines … flow guarantees …" becomes
   "`flow` lines".
5. **Earlier tasks:** "An answer's receipt is the task's ledger" becomes "An
   answer's receipt is the task's catalog entry", and the entry is described
   by its operator blocks.
