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

**Stable comparison and efficiency implementation.** A fresh `git fetch origin
stable` resolved local stable and origin/stable to `862e0eeb1`. This branch at
`3a8a9b995` already contains that commit: 52 commits ahead, zero behind. `git merge
origin/stable` confirmed it is up to date. No unrelated worktree was changed.
The 102 pre-existing changed/untracked files are preserved in a checksummed
archive under `/tmp/texera-cost-r4/pre-fix-worktree.tar.gz`.

Stable already includes per-statement syntax isolation, explicit no-nesting and
call-order rules, the single dataflow tool, required filter/map/process docs,
orthogonal/additive data and flow evidence, and optional dataflow reasoning.
These are retained. This branch additionally has task entries, historical
materializations, cache boundaries, and the local reusable-function/analysis-state
experiment. The historical controls predate some local correctness fixes;
new measurements must carry their own runtime hash.

Two fixes apply to native observations generally:

- A task-only event path obtains its baseline from the user event's immutable
  parent snapshot. Old unchanged outputs and failures are no longer rendered as
  newly re-executed at the first action of each question. Newly changed results
  and explicitly requested observations remain visible.
- The native observation scope survives a rejected request or thrown tool
  error. An absent structured receipt no longer falls back to showing every
  successful table. Valid receipt selections still take precedence.

The new, opt-in `nativeTaskEfficiency` configuration requires task history,
task context and analysis state. It cannot change after a user task starts.
The `react-efficient` benchmark arm enables it; existing arm names retain their
recorded configuration. Old results still belong to their recorded revisions.

The configuration combines full immutable task entries with reusable functions;
it does not use the unsuccessful candidate's selected-memory projection. The
compact entry renderer retains the full archived request and answer, available
function source, statements, row counts, version/replacement facts and action
rationale. It shares exactly identical function bodies and column lists within
an entry, removes a doc only when its exact literal is already in the statement,
and references exactly matching displayed rows. It never claims that matching
samples prove equal full tables. Profile facts are omitted only when all the
entry's small-table values are visible without truncation and literal null-like
strings do not make them ambiguous. Existing archive
limits (such as 80 function lines) are unchanged and remain labeled.

Repeated inspection/recall responses reference the exact earlier response only
within the current visible task. Changed definition text is shown in full.
The visible ancestor path is consulted so checkout cannot refer to a response
from an abandoned branch. Deduplication is disabled when context-window or
static or manually invoked compaction can remove the earlier response.

The engine fetch budget increases up to twice the normal result budget, capped
at 5,000 characters, without reducing a larger explicitly configured budget.
The model receives that slack only if an entirely held
table has at most 20 rows and fits in full; large/incomplete observations retain
the normal budget and their truncation labels. This addresses the saved Survey
case in which the fetch itself retained only 14 of 15 required industry rows.
Captured observation frames remain immutable for subsequent cache reuse.

Behavior guidance makes table populations, function revisions and component
reuse explicit. It asks for diagnostic input checks after two unsuccessful
repairs, preserves useful analytical verification, distinguishes infrastructure
failure from formula errors, projects needed columns before reading wide answer
tables, and checks final fields against the current question. It does not impose
a blanket retry cap or silently change the agent's requested computation.

Regression tests first reproduced seven failures, then passed. The complete
Bun suite after the final guards passes 1,156 tests and TypeScript passes. The dedicated evaluation
engine is launched through `bin/local-dev.sh` with isolated workers; the agent's
program parser retains its normal Python interpreter. The enclosing service is
capped at 16 GiB, with at most two evaluation sessions admitted concurrently.

The [frozen evaluation selection](../benchmark/longds/cost-r4-selection.json)
contains three full sessions, 96 questions per trial: Survey, BI and Water.
Report the first pass separately from two repetitions; use existing DSGym and
entries results as historical controls, and the same upstream judge prompt with
GPT-5.2 for new answers. This is development evidence for a representative
subset, not a claim of generalization to all 68 benchmark tasks.

The real-service smoke also checked the API settings path, all 15 rows of a
small answer table, a second-task observation without false re-execution, and
observation scope after a rejected recall. The runner verifies the applied
settings before requesting the first model response. Python isolation/budget/
report tests pass (22 tests) in the benchmark environment. The initial test
attempt used the engine environment, which lacks the baseline's Jupyter
package; no benchmark run used that environment for the baseline.

[Runtime provenance](cost-r4-runtime-provenance.json) records the exact dirty
source hash and a source archive. The external wall-budget supervisor was
adapted to recognize the new arm's analysis-state flag when matching its agent.
That adaptation changes only which matching agent is stopped at the existing
one-hour limit; it does not change solver inputs, evaluation settings or scores.

Reproduce the result tables without model calls from the repository root:

```bash
python agent-service/benchmark/multiturn/analyze-cost-r4.py
```

The measured arm remains opt-in while accuracy and the 25% DSGym cost target are
assessed across repetitions. Remaining trace-grounded directions are:

- Materialize small metadata views before repeatedly inspecting a wide source.
  For example, a `limit(raw, 1)` header table can feed several header diagnostics
  without sending every respondent row through each process. This addresses
  runtime and repeat-action overhead; it does not itself compress model history.
- Bind comparisons to explicit population/version identities. Water's second
  run reuses a working function whose output compares the wrong two top-decile
  sets. Shared functions need semantic checks as well as syntax checks.
- Serialize final answers from selected computed fields. Survey 10 copies an
  adjacent result field incorrectly even though the complete table is visible.
  A deterministic answer projection could avoid that transcription step.

These are follow-up proposals, not claims about features included in this arm.
The [trace audit](cost-r4-trace-audit.md) preserves both supporting and contrary
cases, including correct work that requires an additional verification call.

Each run's `judge_protocol.json` records the actual scoring model, prompt hash,
and generation settings. The solver's `protocol.json` also contains a generic
CLI suggestion naming DeepSeek; that suggestion is not the model used by this
campaign. Actual new judgments use GPT-5.2, matching the retained
historical comparison protocol, without rejudging old outputs.

To opt in through the API, create a fresh native agent with
`nativeTaskHistory`, `nativeTaskContext`, `nativeAnalysisState` and
`nativeTaskEfficiency` all set to `true`. The measured `react-efficient` arm
also fixes its sampling, cache, evidence and step-limit settings in
`agent-service/benchmark/multiturn/run-longds-turns.ts`; using the API defaults
alone does not reproduce that arm. The official-protocol runner accepts
`--arm react-efficient` through `benchmark/longds/run_official.py`.

The nine-session campaign is complete; see the [result report](cost-r4-results.md).
After the campaign, compatibility guards were applied for manual compaction,
explicit result budgets above 5,000 characters, and literal `NULL`/`NaN` strings
that can make missing-value counts nonredundant. They were developed in a separate
copy, with four failing regression tests first, to keep the measured source
unchanged. The [guard audit](cost-r4-guard-impact.json) checked all nine saved
configurations and 284 output files; none of these guard conditions occurs in
the measured contexts. The recorded evaluation hash is preserved separately
from the final source hash in [provenance](cost-r4-runtime-provenance.json).

The session-budget supervisor now matches the new arm, pauses only its selected
runner, publishes captured usage/results before letting the controller observe
runner exit, and protects against reused process IDs. Three new Python regression
tests cover those cases. The external wrapper used during evaluation implemented
the same recording-order correction without changing the frozen solver source.
The dedicated evaluation service was stopped and its temporary runtime-limit
override was removed after the campaign; shared development services were left
running.
