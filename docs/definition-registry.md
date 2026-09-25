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

# The definition registry: a multi-task session as versioned definitions

**Status (2026-09-25).** Implemented behind the opt-in `nativeDefinitionRegistry`
setting (requires `nativeTaskEfficiency`, hence task history, task context and
analysis state). The LongDS arm `react-registry` enables it. The results section
at the end records the representative campaign.

## Why

Two findings from the saved LongDS sessions (see the memory notes and the
per-turn analysis of 2,531 turns across the isolated and cost-r4 campaigns):

- Every arm is 73–90% accurate when its dependency turns were right and 13–27%
  when one was wrong; 80–93% of failures sit downstream of a root failure in the
  first few turns, and no arm ever repairs a root. The loss is cascade, not
  memory.
- The requests are written in a vocabulary of versioned definitions ("the
  equal-weight form introduced earlier, not the currently active weighted form";
  "roll back only the adopter side to the AutoML-only view"). Over 465 turns of
  14 tasks, 77% ask to compare or relate to another state, 51% name an earlier or
  currently active version, 42% say to keep something unchanged. The saved graphs
  already hold every version the requests name, as an id reassigned in place or
  as a new name beside an old one, but nothing names them as versions of one
  definition: 74–83% of operators are dead-end leaves, restore and `at()` were
  used about zero times, and the model rebuilt earlier versions in new
  functions or copied numbers from old observations.

The catalog of operators is therefore an implementation detail. The state the
model needs is the graph read as definitions with versions.

## What it does

- **Versions are runtime facts.** An id reassigned in a later task is one
  definition with two versions (the earlier version's saved values stay readable
  with `at(name, task=N)`; its saved definition can be rebuilt). A table
  declared with `supersede={"new_table": "old_table"}` is the next version of
  the old table's definition and the active one. `definition-registry.ts`
  derives everything else from task provenance, the graph and the entries.
- **The task starts from `# Definitions`.** One line per versioned definition
  with each version's task, doc, saved values and the ACTIVE marker; the
  remaining current tables with their docs and how many tables read them; the
  probe tables no table reads, by name only. Entries show each function by its
  `def` signature line, since shared functions persist and `inspect` returns a
  body on demand. This replaces the `# Tables now` index and the function
  bodies in entries.
- **`bind`** evaluates an existing table under chosen versions of the
  definitions it reads, as a new table: Rollback binds an earlier version,
  Counterfactual a new parameter version, Composition several definitions at
  once. It is realized by the existing planners: an earlier in-place revision is
  restored from its saved definition as `<name>__v<k>`, and the target is forked
  with its version tables replaced. The receipt states what was bound.
- **`explain`** prints a table's lineage with the version of every definition
  it read and flags ancestors that read a superseded version.
- **`compare(A, B, keys=[...])`** is a typed operator: one row per key with
  `in_a`, `in_b`, `<col>_a`, `<col>_b` and `<col>_delta`, with flow evidence
  counting rows in both, only in A, only in B and changed values per column.
- **Receipt hints** on new custom code: a process that fits a model without
  keeping row-level output, and a process with several numeric literals and no
  parameters-table input.

The prompt paragraph (`DEFINITION_REGISTRY_METHOD` in `prompts.ts`) teaches the
vocabulary and the four gestures; the tool description and schema add the
fields only when the setting is on, so older arms keep their recorded prompts
except for the `compare` operator, which is part of the shared catalog.

## Verification

- `agent-service/src/agent/native/definition-registry.test.ts`: versions from
  provenance and supersede, the task-start index, bind planning into restore and
  fork, explain, signature-only entries, the tool fields, receipt hints, the
  prompt, settings validation, and the compare operator executed by the Python
  runtime.
- `agent-service/benchmark/multiturn/registry-smoke.ts` on the real engine
  behind the LongDS isolation wrapper: an in-place revision and a supersede
  become versions in the index; a bind rebuilds the earlier revision and binds
  the superseded table while the default stays untouched; explain reports the
  lineage; compare produces the row-level deltas. The isolation smoke also
  passes on the same engine.
- Full suites: 1,166 Bun tests, TypeScript, 22 Python tests.

## Campaign

Arm `react-registry`, model gpt-5.6-luna, the frozen cost-r4 selection (Survey,
BI, Water; 96 questions per trial), one-hour session budget, two concurrent
sessions, judged with GPT-5.2 and the upstream prompt. Controls: the saved
isolated DSGym and entries sessions and the saved cost-r4 efficient sessions on
the same tasks. Reproduce the tables with
`python logs/registry/report.py` in the worktree (no model calls).

Results are appended below when each trial completes.
