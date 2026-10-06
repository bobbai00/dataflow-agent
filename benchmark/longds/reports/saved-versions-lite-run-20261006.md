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

# Saved versions on whole Lite sessions, 2026-10-06

RESULTS_PLACEHOLDER

## What was run

Three whole LongDS v1.1 Lite sessions, chosen on 2026-10-06 before any run
for their state labels: Netflix task 2 (34 turns: 15 Update, 14 Rollback, 10
Counterfactual), Kiva task 1 (37 turns: 11 Update, 12 Rollback, 13
Counterfactual) and water-potability task 1 (34 turns: 13 Update, 5
Rollback, 6 Counterfactual). Two solvers on the same task text and the
same catalog policy: the dataflow agent with saved versions (`stateHistory`,
`taskContext: dependencies`, no statistics, no records, no input budget, no
compaction, 40 calls per question) and the ordinary persistent-Python
agent with its script catalog. Two models, Terra and Luna, one rep each:
twelve sessions, 420 questions. The judge is the paper's own model,
`deepseek/deepseek-v4-pro` through OpenRouter, with the upstream binary
rubric; a transport failure is never cached as a verdict.

The dataflow solver ran at commit ce9ec8a2f, after the fixes of the same
day's audit (see the design doc's "2026-10-06 audit" section): the retired
fork and restore commands are refused with the `@N` form, result handles
cannot be deleted and do not linger, retention failures reach the boundary
receipt, `diff` rejects a key listed as a value column, batched reads keep
each table's columns, and the boundary receipt lists what the task saved.
The harness changed after the freeze in three files only (the runner's
resume mode, the Python kernel's data root, the scorer's judge caching);
the protocol records their hashes under `resumes`.

Two stacks share this worktree's ports. The run uses the 5432 stack (web
38080, engine 38085, computing-unit manager 8888) through a non-watch
agent-service instance on 3072; the first two smoke attempts mixed it
with the 35432 stack and failed every execute with a foreign-key error.
The Python baseline's three first jobs failed at their first request
because the kernel resolved the data directory against the current
directory; they were rerun with `run --resume` from the repository root.

The predeclared primary numbers, written before the run: how many `@N`
references point at a version that differs from the current table at the
time of use (the reference study), and the wrong-version rate on Rollback
turns; accuracy by label and cost per arm follow.

## Artifacts

- Protocol, jobs, runs, judge cache, metrics and summary:
  `/var/tmp/versions-lite-run-20261006/pilot/`.
- Reference study: `pilot/reference-study.json` (one row per `@N`
  reference) and `pilot/turn-study.json` (one row per dataflow turn with
  its edits, references and labels), from
  `benchmark/longds/versions_reference_study.py`.
- Tables: `benchmark/longds/versions_run_report.py --root …`.
- Smoke session (Netflix task 2, three turns, Luna):
  `/var/tmp/versions-lite-smoke-20261006/`, with the two failed stack
  attempts kept beside it.
