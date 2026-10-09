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

## Verdict

Ordinary persistent Python beat the dataflow agent on accuracy with both
models, and saved versions never decided an answer. The run is clean enough
to support both statements for these three sessions and one rep.

| Model | Paired questions | Dataflow correct | Python correct | Only dataflow | Only Python | Dataflow cost | Python cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Luna | 103 | 12 | 36 | 1 | 25 | $0.73 | $0.97 |
| Terra | 105 | 50 | 59 | 7 | 16 | $6.47 | $8.04 |

Pairs are the same session, model and question answered in both arms; Kiva
Luna Q36–37 have no Python answer and are left out of both arms. The exact
McNemar p-values are below 0.001 (Luna) and 0.093 (Terra), but questions are
not independent: an early error is inherited by most later questions, so the
real sample is a handful of early errors per session. Judge: the paper's
`deepseek/deepseek-v4-pro` through OpenRouter, upstream binary rubric, all
418 preserved answers judged once, $1.10.

| Session | Model | Dataflow correct | Python correct |
|---|---|---:|---:|
| Netflix task 2 | Luna | 2/34 | 2/34 |
| Netflix task 2 | Terra | 8/34 | 10/34 |
| Water-potability task 1 | Luna | 9/34 | 24/34 |
| Water-potability task 1 | Terra | 24/34 | 26/34 |
| Kiva task 1 | Luna | 1/35 | 10/35 |
| Kiva task 1 | Terra | 18/37 | 23/37 |

Dataflow's lower dollar cost is a cache artifact, not efficiency. Python's
first call of every question was 0.2% cached against 95% for dataflow,
because the Python catalog moves the finished request into a new catalog
message; on later calls both reuse about 90–95%. Dataflow sent more input:
11.98M tokens against 8.39M on Terra.

## Why dataflow lost

Three readers traced every question on which the two arms of the same model
disagree, reproducing key values from the raw data. Almost every loss starts
at an early question and is then inherited.

- **Misread rules at the start, never noticed.** Kiva Luna Q1 kept the right
  population (53 countries, 655,309 loans) but ranked "larger is higher"
  descending and percentile-ranked a completion gap that the rule keeps raw.
  Applying exactly those two errors reproduces its Turkey/Housing 88.884. Its
  own receipts showed a 21%-complete market with a completion-gap score of
  0.14 and a one-loan cell with loan scale 98.14; no step questioned them.
  Water Luna Q2 left the already-repaired chemicals out of the neighbour
  distance (pH 7.0634 against 7.0778); Q6 ran the count screen only on
  initially repaired rows. Netflix: all four arms missed the Q1 rule "carry
  forward up to eight ranked launch markets", which sinks most membership
  answers in both arms.
- **Wiring the wrong stage.** Dataflow splits "the five" into pool, sort,
  limit and project, and then connects the wrong one. Water Luna Q9 used the
  368-row eligible pool instead of the five-row contrast list (106 contrast
  sources per band against 2); Q18 repeated it; Terra Q11 called the whole
  328-row upper decile "the shortlist". Python keeps `.head(5)` on one line.
- **Copying an early misreading forward.** Luna dataflow read earlier
  operator bodies and retyped the wrong `initial_gap_any` filter into 11
  later operators; Luna Python re-read the CSV and re-ran its correct repair
  in 25 of 34 questions. Netflix Terra dataflow retyped a genre mapping that
  misses "Comedies" and "TV Mysteries" into 15 operators, while the correct
  explicit mapping it wrote at Q5 was never reused. Rules live inside long
  `process()` bodies, so reuse means copying code, not connecting a rule.
- **Rule changes answered but never applied to the main line.** Kiva Q12
  narrows the population and Q23 restricts to complete evidence, both "from
  here on". Each became a side table; the main `final_concentration_matches`
  stayed relaxed and Terra dataflow's Q26 and Q36 read it. Python had the same
  problem at different questions (water Q20's tail removal was dropped from
  Q27 on by both Luna arms).
- **Checking.** Calls per question were close at the root questions; the
  difference is what was checked. Luna Python printed the distance columns
  per chemical at water Q2; dataflow answered water Q9 after a receipt showed
  368 rows where five were meant, and Terra Q6 after a receipt showed 0 rows.

Small calculation drift also flips near-ties late in Kiva: Terra dataflow's
Q16 dropped incomplete rows before ranking (81 of 86 countries), which moves
scores by about 0.03–0.2 and decides Q29, Q31–Q33 and Q37.

The judge errs in both directions about equally across arms: none of 12
sampled Netflix zeros is format-only, while several water 1s pass on one
checked field (e.g. Luna dataflow Q6, Terra Python Q15).

## Saved versions

Across the six dataflow sessions, 535 accesses read the data of a saved
version: 533 returned exactly the current table, and two could not be
checked. No rule was ever changed in place in a later task, there was no
`update … from …@N` restore in 62 Rollback questions, and every Update became
a new operator. Old states therefore always existed under their own names,
and `name@N` was an alias. No counterfactual leaked into a later answer in
any arm, and on Rollback questions no arm chose the wrong earlier rule. Where
saved tables did help, it was reuse, not versioning: Terra dataflow answered
water Q13 straight from `hardness_band_contrast_summary@9` and got the exact
Q18 ranks from `conductivity_reduced_severity@15`, which both Python arms
lacked. These Lite sessions never require an overwritten state, so they
cannot show a versioning benefit.

## What to change

1. **One current version per rule, with changes propagating.** The benefit
   worth building is not history but propagation: when a request changes a
   rule from here on, editing the operator that defines it should recompute
   everything built on it. That would have prevented the stale main line.
   It needs rules as small operators (a genre mapping, an eligibility filter,
   a weight table) rather than code inside `process()` bodies, so that a
   change is an in-place edit and reuse is an edge, not a copy.
2. **Flag a rule change that never reaches the main line.** When a new
   operator takes over an existing operator's role, the receipt should name
   the tables that still read the old one.
3. **Make "the selection" explicit.** Wrong-stage wiring of pool versus top-N
   happened in both models; a receipt that states the row count against the
   requested count ("368 rows; the question asks for five") is a cheap check.
4. **Test versioning on sessions that overwrite state,** after 1 makes
   in-place edits normal; until then Rollbacks never need `@N`.
5. **Equalize the context layout before any cost claim.** Give Python the
   same append-only request and boundary frames, and verify cache reuse.

## Is the run clean?

Yes, for this comparison.

- 7 of 12 sessions ran end to end. Five were interrupted by model-API
  timeouts or one connection error (Netflix and water Luna dataflow at Q23
  and Q26; Kiva and water Terra Python at Q6; Kiva Luna Python at Q26),
  rebuilt from their completed answers, and continued.
- The rebuild did not change what the model saw. For both dataflow sessions
  the prior-task catalog after replay equals the original in every visible
  field; for the three Python sessions the first continued context is
  byte-identical to the interrupted attempt's. Settings, system prompt and
  tools are identical, and the rebuilt tables were value-checked.
- Five interrupted questions were rerun from a clean checkpoint, never chosen
  by score. No infrastructure error appears in any authoritative trace.
- Solver code did not change after the freeze at ce9ec8a2f. The harness
  changes were the Python kernel's data path and a longer model timeout for
  the continuations (180 s to 900 s for Python; a 900 s service for dataflow).
- Kiva Luna Python Q36–37 were never answered; its 35 answers live in the
  preserved prefix that the evaluator now reads.

## Operational record from the stop

The rest of this report was written when the run was stopped on 2026-10-06
at 21:04 UTC, before judging. Its costs, recovery details and resume
instructions still apply; its statements that judging is pending do not.

### Stopped status

Stopped at the user's request on 2026-10-06 at 21:04 UTC. The campaign
runner, its Python executor and kernel, and the private completion
agent-service on port 3073 are stopped. Shared services and unrelated
older runs were left alone. No automatic continuation or judging is running.

**418 of 420 answers are preserved; 11 of 12 sessions are complete.** All
six Dataflow sessions and all Terra sessions finished. The only missing
answers are **Kiva task 1, ordinary Python with catalog, Luna, Q36–37**.
DeepSeek judging has not started: **0 judged answers, $0 judge spend**.
There is no final accuracy comparison yet.

The last restart was rebuilding the saved Python kernel. It replayed
Q1–8 of the 35-question checkpoint before being stopped, with zero new
model calls. Its current run directory does not contain the authoritative
35-answer prefix. That prefix is preserved in:

```text
/var/tmp/versions-lite-run-20261006/pilot/runs/
social_good__data_science_for_good_kiva_crowdfunding__task1__luna__python__catalog.failed-20261006T205546Z/
```

This is one path split across lines for readability. `pilot/stopped.json`
records the full path. The interrupted directory's
`replay-verification.json` names it as `source` and explicitly says
`verified: false`; a future resume must replay and verify the checkpoint
before any new model call.

### Costs at the stop

Costs below are configured token-rate estimates for preserved answers,
including cached input discounts. They exclude abandoned attempts and
unknown charges; the physical-attempt ledger is reported separately.

| Model | Solver | Saved answers | Cost (USD) | Model calls | Input tokens | Cached input | Output tokens |
|---|---|---:|---:|---:|---:|---:|---:|
| Terra | Dataflow | 105/105 | 6.467387 | 365 | 11,983,502 | 11,176,676 | 218,200 |
| Terra | Python + catalog | 105/105 | 8.041384 | 409 | 8,390,916 | 6,088,011 | 184,831 |
| Luna | Dataflow | 105/105 | 0.746765 | 421 | 13,587,621 | 12,696,311 | 262,147 |
| Luna | Python + catalog | 103/105 | 0.965847 | 540 | 12,418,343 | 10,018,988 | 237,997 |

Terra's completed-answer cost is 19.6% lower with Dataflow across the
same 105 questions. Luna's aggregate totals cover different numbers of
questions and are not a completed-session comparison.

| Conversation | Model | Dataflow answers | Dataflow cost | Python answers | Python cost |
|---|---|---:|---:|---:|---:|
| Netflix task 2 | Terra | 34/34 | 2.337351 | 34/34 | 2.996787 |
| Netflix task 2 | Luna | 34/34 | 0.224032 | 34/34 | 0.344758 |
| Water-potability task 1 | Terra | 34/34 | 1.706213 | 34/34 | 1.882262 |
| Water-potability task 1 | Luna | 34/34 | 0.210014 | 34/34 | 0.243586 |
| Kiva task 1 | Terra | 37/37 | 2.423824 | 37/37 | 3.162335 |
| Kiva task 1 | Luna | 37/37 | 0.312718 | 35/37 | 0.377503 |

| Physical solver attempts | Known cost | Requests with unknown usage | Budget reserve |
|---|---:|---:|---:|
| Terra Dataflow | 6.467387 | 0 | 0.00 |
| Terra Python | 8.266941 | 2 | 5.00 |
| Luna Dataflow | 0.753868 | 2 | 0.50 |
| Luna Python | 1.008861 | 3 | 0.75 |
| Total | **16.497057** | **7** | **6.25** |

Preserved-answer costs total **$16.221383**. Known costs across all physical
attempts total **$16.497057**, including **$0.275674** of additional known
attempt costs. Seven interrupted requests lack provider usage. The
$6.25 reserve ($2.50 per unknown Terra request, $0.25 per unknown Luna
request) is conservative budget accounting, **not a bill**. Known cost
plus reserve is **$22.747057** against the $25 solver guard. The actual
total charge cannot be established from the available usage alone.

“Retries” here means additional attempts after infrastructure or API
failures, including earlier partial starts. Completed answers were kept,
including potentially incorrect ones. There were no judge-selected
solver retries. Replaying scripts and repairing exports made no model
calls, so their setup time adds no model-token charge.

### What was run

Three whole LongDS v1.1 Lite sessions, chosen on 2026-10-06 before any run
for their state labels: Netflix task 2 (34 turns: 15 Update, 14 Rollback, 10
Counterfactual), Kiva task 1 (37 turns: 11 Update, 12 Rollback, 13
Counterfactual) and water-potability task 1 (34 turns: 13 Update, 5
Rollback, 6 Counterfactual). Two solvers on the same task text and the
same broad catalog context policy: the dataflow agent with saved versions
(`stateHistory`, `taskContext: dependencies`, catalog statistics and
records off, no input-context budget, no compaction, 40 calls per question)
and the ordinary persistent-Python
agent with its script catalog. Two models, Terra and Luna, one rep each:
twelve planned sessions, 420 planned questions. The configured judge for
all arms is `deepseek/deepseek-v4-pro` through OpenRouter with the upstream
binary rubric; that judging is still pending. A transport failure is not
a verdict. These are comparisons of
the two local implementations, not published DSGym scores.

The catalog settings must be distinguished from explicit result retrieval:

- `catalogStatistics: false`, `catalogRecords: 0`: no statistics or sample
  records automatically included in the prior-task catalog. Definitions,
  inputs, result shapes and columns remain visible.
- `nativeProfileCollection: true`, `dataEvidence: true`,
  `retrievalViews: ["sample_stats", "full"]`: statistics were still
  available when the model explicitly requested that result view.
- `flowEvidence: false`, `stateLedger: false`, `thoughtReplay: false`.
- `contextWindowTokens: 0`: no input-context token ceiling. Observations
  still have formatting budgets: `fullResultCharLimit: 5000`,
  `maxOperatorResultCharLimit: 2000`, `dataEvidenceCharLimit: 2000`,
  `maxResultRows: 0`. “No input cap” does not mean unbounded tool outputs.
- The Python output ceiling is 8,192 tokens per call; native output uses
  the frozen service configuration. Both solvers allow 40 model calls per
  question. File inventories contain paths only, without automatic headers
  or samples.

The Python baseline is a local persistent Python executor with tools to
run code, inspect previous executed scripts, and submit an answer with
current variable sources. It can freely retain copies, versioned names
and files. Its catalog contains prior questions, answers, script IDs,
written bindings, table summaries, answer sources and observed task
dependencies; full script bodies are retrieved on demand. It is not an
unmodified upstream DSGym run.

The dataflow solver ran at commit ce9ec8a2f, after the fixes of the same
day's audit (see the design doc's "2026-10-06 audit" section): the retired
fork and restore commands are refused with the `@N` form, result handles
cannot be deleted and do not linger, retention failures reach the boundary
receipt, `diff` rejects a key listed as a value column, batched reads keep
each table's columns, and the boundary receipt lists what the task saved.
The solver's model-facing source, settings, input files and task text stay
frozen. Harness repairs fix the Python kernel's data root, checkpoint
recovery, cumulative spending, malformed-call scoring and judge retries.
The protocol records changed harness hashes under `resumes`. Python
prompt, tools and solve-loop syntax are compared against the frozen source
archive; permitting a kernel startup repair does not permit prompt changes.

Two stacks share this worktree's ports. The run uses the 5432 stack (web
38080, engine 38085, computing-unit manager 8888) through a non-watch
agent-service instance on 3072, then a private completion instance on 3073
with the same solver source and a longer transport timeout. The first two smoke attempts mixed it
with the 35432 stack and failed every execute with a foreign-key error.
The Python baseline's three first jobs failed at their first request
because the kernel resolved the data directory against the current
directory; they were rerun with `run --resume` from the repository root.

The predeclared primary questions were how many `@N` references actually
retrieve a different historical state, and the wrong-version rate on
Rollback turns. Successful accesses are compared with the live state
immediately before that action. Different materialization IDs alone do
not prove different values. Complete table values establish equality or
difference; definition inspections and copies are reported separately.
Unavailable observations remain unknown. Annotated Rollback labels and
a wrong final answer do not, by themselves, establish a wrong-version
error. That rate remains unmeasured without audited state adapters.

### Recovery and accounting

Completed answers are retained, including incorrect ones. Only incomplete
questions stopped by infrastructure are continued. The harness rebuilds
each completed prefix from the agent's recorded scripts or graph actions,
never from reference code, and verifies the checkpoint before new model
calls. Native verification compares visible table values, excluding
internal saved-result handles whose IDs can change on replay. Python
verification compares exported table versions. This verifies captured
working tables, not every hidden scalar or mutable Python object.

Replay uses no model calls and its elapsed time is reported separately.
Luna's Kiva Q35 completed before copying its observer tables filled the
root disk. The complete private export survived. Its binding versions
matched Q35's write receipts, so the export was repaired and the original
answer and usage retained. Q36–37 were not attempted before the user
stopped the subsequent checkpoint replay. Byte comparisons
of previously copied prefix tables recovered about 63 GiB by sharing
identical files. Recovery now shares immutable observer tables while
keeping mutable records and judge files independent.

Per-arm costs retain the original cost of each reused answer exactly once.
The physical-attempt ledger also includes abandoned and interrupted
attempts. Missing provider usage is shown as unknown, with a conservative
reserve against the $25 solver budget; the reserve is not a claimed bill.
Judge spending is separate. The evaluator supports a cost comparison on
exactly the questions both solvers got right; that comparison remains
pending until judging.

The Python baseline freely retains copies, variables and files in its
persistent kernel. Neither arm receives reference answers, benchmark
dependency labels or benchmark state-type labels. One run per arm and
three selected conversations provide a small comparison; they do not
establish a general accuracy or cost advantage.

### Why the recorded costs differ

The completed Netflix and water conversations expose a large cache
difference at task boundaries. On each task's first call, Dataflow reused
93–96% of input tokens, while Python reused approximately 0%. On later
calls within the same task, both reused about 90–95%.

| Conversation/model | First call: Dataflow cached | First call: Python cached | Later calls: Dataflow cached | Later calls: Python cached |
|---|---:|---:|---:|---:|
| Netflix/Terra | 95.4% | 0.2% | 90.3% | 92.4% |
| Netflix/Luna | 93.4% | 0.2% | 91.5% | 93.3% |
| Water/Terra | 95.5% | 0.0% | 93.7% | 92.2% |
| Water/Luna | 92.8% | 0.0% | 94.6% | 92.9% |

Each first-call observation covers all 34 questions of its conversation.

The Python baseline rewrites the completed request as a new user catalog
message. Dataflow preserves the original request frame and appends an
immutable answer boundary. The Python requests do retain identical earlier
catalog messages, so the catalog contents are not being rewritten each
turn; the current request-to-catalog transition changes the layout. This
is a concrete context difference consistent with the observed boundary
cache loss, not a controlled causal test of the provider's cache policy.

For Netflix/Terra, Dataflow sent 3.62 million input tokens against Python's
2.89 million. Cache-aware costs were $2.337 and $2.997 respectively. Pricing
the same observed tokens with every input token uncached would give $8.31
and $6.67. That is a diagnostic repricing, not another model run or a
prediction of how the agents would behave without caching.

Across all 105 Terra questions, Dataflow sent 11.98 million input tokens
and Python sent 8.39 million. Pricing those same observed tokens without
an input-cache discount gives **$26.585404 versus $18.999804**, while the
recorded cache-aware estimates are **$6.467387 versus $8.041384**.
Dataflow's lower recorded cost does not mean it used fewer total tokens.

The frozen rates per million tokens are:

| Model | Fresh input | Cached input | Output |
|---|---:|---:|---:|
| Terra | 2.00 | 0.20 | 12.00 |
| Luna | 0.20 | 0.02 | 1.20 |

These are the campaign's configured rates, not a claim about current
public model pricing or an invoice.

Netflix/Luna also used fewer calls (126 versus 196). The other completed
pairs have much smaller call gaps. These savings cannot yet be attributed
to historical state recovery. Before the next paid comparison, give the
Python catalog the same append-only request/boundary policy and verify
cache reuse. The present campaign retains its frozen layout.

### Historical state actually used

Across the six Dataflow sessions (210 turns), 160 turns successfully
referenced a historical operator. The audit found 535 historical data
accesses: 533 had the same values as the corresponding current table,
and two lacked complete value observations. All 439 historical definition
accesses had the same definition and logical inputs as the current
operator. The three apparent definition differences before normalization
were replayed internal handle IDs, not different code or logical inputs.

The table comparison checks row values as a multiset and ignores row
order. It does not establish semantic correctness against a reference
answer. The two unknown accesses are Luna/Netflix reads of
`cleaned_catalogue@1` in Q24 and Q31. Different execution IDs without
complete values were not counted as different historical data.

There were 551 successful operator creations, 40 updates to operators
that existed before the current turn, and four copies of saved definitions.
An update count alone does not show recovery from an overwritten value:
the historical source may still be an unchanged, separately named table.
No observed historical data access in these runs proves retrieval of a
different overwritten state. The two unknown accesses remain unknown.

These traces show historical addresses being used, but do not isolate an
automatic-versioning advantage over a Python agent that keeps named
copies. Any accuracy or cost difference must be explained separately.

State labels overlap. The 210 Dataflow turns include 104 Initial labels,
78 Update, 62 Rollback and 58 Counterfactual; these are evaluator labels,
not information supplied to the agents. The audit found no proved
different historical data access under any of these labels. This is a
coverage finding, not proof that saved-version semantics are broken or
that historical data can never help.

### Code and verification saved

Two commits contain the completed implementation work from this session:

- `9dc9f0d8a` — `fix(longds): resume and audit frozen benchmark runs`.
  Resume from agent-authored checkpoints; cumulative accounting includes
  archived attempts and unknown usage; frozen Python prompt/tool/loop
  logic is checked separately from allowed startup repairs. Native
  verification compares visible values instead of internal replay IDs.
  Malformed tool arguments become evaluator errors rather than crashes.
  Judge infrastructure failures can be retried while successful verdicts
  are cached. Cost reports separate preserved answers from physical
  attempts and support matched-correct questions. Historical-data auditing
  distinguishes table values from definition reads and compares state at
  the time of access; saved-input handles are normalized before definition
  comparisons. First-call cache usage is measured separately.
- `73d22a3eb` — `fix(longds): preserve answers across export failures`.
  A completed per-turn answer is retained even if observer export fails
  before the aggregate records file is updated. Resumed immutable pickle
  tables share bytes on the same volume, while mutable records remain
  independent. Cross-volume copies fall back to copying.

The latest focused verification passed **81 tests** across nine Python
test files. The export-failure and immutable-file regressions failed
before their fixes and passed afterward. A live filesystem check also
passed the cross-volume copy path. `git diff --check` passed for the code
commits. No new paid validation cases were launched.

The focused test command was:

```bash
PYTHONPATH=benchmark/longds .venv/bin/python -m pytest -q \
  benchmark/longds/test_context_state_pilot.py \
  benchmark/longds/test_context_state_score.py \
  benchmark/longds/test_versions_reference_study.py \
  benchmark/longds/test_versions_run_report.py \
  benchmark/longds/test_state_oracle.py \
  benchmark/longds/test_state_pilot_score.py \
  benchmark/longds/test_state_comparison.py \
  benchmark/longds/test_script_catalog.py \
  benchmark/longds/test_partial_score.py
```

The stopped-run documentation is separate from the original frozen solver
source. `source.zip` and its hashes preserve what the solver ran, even
when harness repairs were committed later. `evaluation-source.zip` and
`evaluation-protocol.json` capture the 90 Python source files prepared
for evaluation at `73d22a3eb`; prepared does not mean judging started.

### Remaining work and limitations

The work is paused. Nothing below is scheduled or running.

1. Resume only Luna/Python Kiva Q36–37 from the preserved 35-answer
   source. Keep original answers, prompts, tools, settings and input files.
   Replay and verify the checkpoint before calling the model. Do not
   interpret the interrupted empty run folder as loss of the answers.
2. Judge all 420 answers with the configured DeepSeek/OpenRouter model
   and upstream rubric. Successful verdicts stay fixed; an API failure
   remains unjudged. Judge cost is separate from the solver guard.
3. Generate `metrics.json` and `summary.json`, then report binary accuracy,
   state-label breakdowns, all-attempt costs and cost on exactly the
   questions both solvers answered correctly. Join the scores into the
   existing reference study after checking its source hashes.
4. Partial components and dependency agreement are implemented diagnostics
   with explicit unknown coverage. They are not another official accuracy
   score. Wrong-version errors, stale-rule rates, cascade attribution and
   oracle working-table correctness remain unmeasured without audited
   semantic adapters. Do not relabel every incorrect Rollback answer a
   state-management failure.
5. Before a fresh cost comparison, give Python the same preserved request
   frames and append-only answer/catalog boundaries. Verify actual cache
   reuse instead of assuming the layout change will fix it. Keep no
   input-context cap and no compaction, as requested. Do not change this
   campaign's frozen layout midway.
6. For a future state-management claim, audit a Lite case in which a
   requested historical value really differs from the current value or
   is absent. Both agents may freely retain named copies. Do not force
   Python to discard them merely to create a versioning win. The present
   535-access audit did not isolate that situation.

The final restart replayed eight turns in approximately eight minutes
before the stop. This is harness recovery time with zero model calls.
`Kernel.code` repeats passive fingerprinting and opcode-read tracing on
replayed scripts; large retained frames make that expensive. A possible
future optimization is to execute the agent's recorded scripts without
repeating that audit, restore the recorded audit metadata, and then check
freshly computed table-value hashes. **It is not implemented.** Restoring
metadata alone must never make a checkpoint pass by trusting its old
version labels; actual values need independent verification.

An earlier review also raised retention-warning visibility in the sealed
catalog: a warning can appear in the action receipt without appearing in
the saved catalog entry. This was not fixed or reverified in this session.
The historical-reference audit likewise does not settle eviction behavior
under a storage cap.

### Resume instructions, only after an explicit resume request

Run from this worktree. The final two questions need the existing Python
executor and model gateway; the stopped private native agent is not
needed for this Python-only continuation. If frozen model-facing sources
or inputs have since changed, restore the recorded source before resuming
instead of silently weakening the freeze checks.

```bash
TEXERA_DASHBOARD_SERVICE_ENDPOINT=http://localhost:38080 \
TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:8888 \
WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:38085 \
PYTHONPATH=benchmark/longds .venv/bin/python \
  benchmark/longds/context_state_pilot.py run \
  --root /var/tmp/versions-lite-run-20261006 --resume \
  --only-jobs social_good__data_science_for_good_kiva_crowdfunding__task1__luna__python__catalog
```

The resume runner follows the interrupted folder's recorded `source`
back to the 35-answer archive. After both questions finish, confirm all
12 authoritative sessions contain 420 completed answers before judging:

```bash
PYTHONPATH=benchmark/longds .venv/bin/python \
  benchmark/longds/context_state_score.py evaluate \
  --root /var/tmp/versions-lite-run-20261006 --judge-workers 8

PYTHONPATH=benchmark/longds .venv/bin/python \
  benchmark/longds/versions_run_report.py \
  --root /var/tmp/versions-lite-run-20261006
```

Successful verdicts are cached. If evaluation is interrupted, inspect the
judge's intent files before restarting; do not blindly resubmit uncertain
in-flight calls. The resulting summary must have 420 scored answers before
claiming a finished accuracy comparison.

### Artifacts

- Protocol, jobs, runs and preserved checkpoints:
  `/var/tmp/versions-lite-run-20261006/pilot/`.
- Stop markers and inventory: `pilot/stopped.json`,
  `pilot/stopped-summary.json`, `pilot/cost-study-at-stop.json`.
- Frozen solver source: `pilot/source.zip`; prepared evaluator source:
  `pilot/evaluation-source.zip`, `pilot/evaluation-protocol.json`.
- The `judge-cache`, `metrics.json` and `summary.json` are evaluation
  outputs that have not been produced yet.
- Reference study: `pilot/reference-study.json` (one row per `@N`
  reference) and `pilot/turn-study.json` (one row per dataflow turn with
  its edits, references and labels), from
  `benchmark/longds/versions_reference_study.py`.
- Tables: `benchmark/longds/versions_run_report.py --root …`.
- Recovery logs: `/var/tmp/versions-completion-run.log`,
  `/var/tmp/versions-completion-resume-2.log`,
  `/var/tmp/versions-completion-resume-3.log`.
- A local core handoff bundle and its file hashes are saved under
  `benchmark/longds/system_scratch/stopped_versions_lite_20261006/`.
  `handoff.zip` includes protocols, source archives, prepared tasks and
  gold for evaluator use, records for physical attempts, model traces and
  checkpoint metadata. It excludes the large observer table files and
  full native observer captures; those remain in the original run root
  and are needed to repeat the full historical-value audit. The bundle
  is a separate copy of the evidence, not a complete standalone kernel
  or data snapshot.
- Smoke session (Netflix task 2, three turns, Luna):
  `/var/tmp/versions-lite-smoke-20261006/`, with the two failed stack
  attempts kept beside it.