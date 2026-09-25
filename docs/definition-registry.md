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

### Results (2026-09-25)

Three complete trials of `react-registry` (full function code in entries) with
the trial-1 code (fe3bdc6d6), plus one trial of the signature-only ablation
(`registry-sig`, the first prefix) and one trial of the compact-index and
bind-fallback revision (aa256a789, `registry-compact`, appended when done).

| Arm | Correct / 96 per trial | Task macro (mean) | Model cost per trial | Mean cost |
| --- | ---: | ---: | ---: | ---: |
| DSGym (isolated) | 56, 46, 46 | 0.528 | $0.343, $0.277, $0.256 | $0.292 |
| react-efficient (cost-r4) | 61, 65, 66 | 0.691 | $0.411, $0.419, $0.423 | $0.418 |
| react-entries (isolated, t3 incomplete) | 64, 67 | 0.709 | $0.495, $0.532 | $0.514 |
| **react-registry** | **67, 64, 69** | **0.717** | $0.474, $0.426, $0.488 | $0.463 |
| registry-sig (ablation) | 48 | 0.513 | $0.481 | $0.481 |

Per task, correct answers by trial:

| Task | DSGym | react-efficient | react-registry |
| --- | --- | --- | --- |
| Survey (30) | 18 / 20 / 11 | 20 / 27 / 28 | 26 / 26 / 25 |
| BI (30) | 23 / 16 / 27 | 28 / 28 / 29 | 28 / 27 / 30 |
| Water (36) | 15 / 10 / 8 | 13 / 10 / 9 | 13 / 11 / 14 |

What the trials say:

- **Accuracy.** The registry arm is the most accurate arm in every trial
  (+2.7 correct per trial over the efficient arm, +17.4 over DSGym), with the
  first perfect BI session and the best three Water sessions of any dataflow
  arm. By state pattern over the three trials: Rollback 0.50 (efficient 0.44,
  DSGym 0.17), Counterfactual 0.58 (0.45, 0.52), Update 0.63 (0.63, 0.67),
  Initial 0.78 (0.77, 0.54). Conditional on correct dependency turns 0.87
  (0.89, 0.73); after a wrong one 0.31 (0.25, 0.37). The gain sits where the
  design aimed, the version-addressed patterns; roots and cascades are unchanged.
- **Cost.** $0.463 per trial: 11% above the efficient arm and 1.58x DSGym, so
  the 1.25x-DSGym target is not met. The premium is structural: the task-start
  index grew from 0.6–1.8k to 3–8k characters (a doc for every current table)
  and is rewritten each task, and Survey used about ten more calls per session.
  Per-turn cost still rises from early to late thirds ($0.0044 to $0.0056,
  efficient $0.0042 to $0.0051); late-third accuracy is 0.61 versus 0.56.
- **The verbs.** `bind` was used 2–4 times per BI session (every call bound
  an earlier version correctly after the restore fix; the two-definition
  rollback of turn 30 became one call), `compare` 1–4 times on BI and Survey,
  none on Water. Two failure modes were found in traces: hiding function bodies
  (the signature ablation) cost 21 inspect calls on Water and led the model to
  re-derive an established population rule on Survey (48/96); and the model
  builds successor tables without `supersede`, then asks `bind` for them, which
  the trial-1 code refused (Survey turn 14 in two trials, six calls instead of
  two). The compact-index revision binds such a table as a plain replacement.
- **Judge.** GPT-5.2 with the upstream prompt on all arms; the same
  format-sensitive verdicts recur (BI turn 7's unordered ranking, turn 25's
  interval label).
