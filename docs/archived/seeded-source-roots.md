<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Cutting the dataflow agent's cost: where the money goes, and seeded source roots

Session of 2026-09-20 on `feat/evidence-compaction`. Model held fixed at
`gpt-5.6-terra` (medium reasoning), Python V2 catalog, batch + explicit
`observe`, Data-only evidence, DELTA context, the 2026-09-16 campaign's frozen
protocol. Everything ran on a private stack (docker project `texera-evcomp`,
ports offset +40000, agent services on 3061–3063) so the stack already running
on the machine was not touched.

In one sentence: **half of the bill is steps that carry no modelling decision,
the largest single class is the opening "scan the files" step that appears in
93–101 of 104 tasks, and a dataflow can perform that step itself because its
roots do not depend on the model — seeding them removed the class entirely and
cut cost per task by the amount the analysis predicted.**

Contents:

1. [What the traces say](#1-what-the-traces-say)
2. [The improvement space, priced](#2-the-improvement-space-priced)
3. [Finishing the LATEST / opBlock experiment](#3-finishing-the-latest--opblock-experiment)
4. [Seeded source roots](#4-seeded-source-roots)
5. [Single-pass evaluation](#5-single-pass-evaluation)
6. [What did not make the cut, and why](#6-what-did-not-make-the-cut-and-why)
7. [Reproduction](#7-reproduction)

## 1. What the traces say

Corpus: the 312 first-pass traces of the 2026-09-16 compact-evidence campaign
(Data-only, Flow-only, Data+flow; 104 tasks each; archived `_attempts/*/first`
where a retry later overwrote the task directory), plus the 104-task historical
V1 Native arm. Every trace carries per-step usage (`inputTokens`,
`cachedInputTokens`, `outputTokens`, `reasoningTokens`) and the exact model
input messages of every step, so the numbers below are measured, not modelled.
Prices are the campaign's frozen rates ($2/M uncached input, $0.20/M cached
input, $12/M output). Exact passes use each task's official primary metric
(`success`, `llm_paraphrase`, `rae_score`, `f1`, `f1_approximate`), which
reproduces the published 75 / 71 / 72 / 68.

### 1.1 Where a dollar goes

| Arm | Cost | Cached prefix | Uncached input | Visible output | Reasoning output |
| --- | ---: | ---: | ---: | ---: | ---: |
| Data-only | $3.474 | 32.1% | 20.8% | 32.0% | 15.1% |
| Flow-only | $3.563 | 31.2% | 22.1% | 31.9% | 14.9% |
| Data + flow | $3.576 | 31.1% | 21.4% | 30.5% | 17.1% |
| V1 Native (historical) | $2.901 | 23.0% | 31.6% | 29.4% | 16.0% |

Two facts follow. Output is about 47% of the bill, and 45% of everything the
model types is Python callback source (`func` bodies) in the V2 arms against
17% in V1. The cached prefix is a third of the bill because every step re-reads
the whole transcript: the V2 arms pay ~10.8k cached tokens per step, V1 ~6.9k.

### 1.2 Where a step goes

Each model step was classified from what it did and what the previous step's
result said: `build` (adds or edits non-scan operators), `explore_scan` (a batch
containing only `scan` operators), `repair` (the previous result carried an
error or a blocked dependent), `answer`, plus rare `observe_only`,
`refine_after_empty`, `inspect_error`, `delete`.

| Arm | Steps / task | build | explore_scan | answer | repair | other |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Data-only | 4.97 | 229 (63.2% of $) | 149 (16.2%) | 103 (12.9%) | 26 (5.8%) | 10 |
| Flow-only | 4.98 | 230 (62.5%) | 145 (16.8%) | 103 (12.9%) | 28 (6.1%) | 12 |
| Data + flow | 4.95 | 223 (61.5%) | 152 (17.8%) | 103 (13.6%) | 33 (6.5%) | 4 |

The opening move is a scan-only step in 100 / 93 / 93 of the 104 tasks (286 of
312). Tasks average 1.43 scan-only steps: 176 tasks take one, 93 take two, 30
take three or more. Of the 190 later scan-only steps, 105 re-scan a file the
model had already scanned (raw `preview` first, parsed scan second, or a change
of `header` / `skipLines`), 21 open a file it had not looked at yet, and ~50
follow an error (`SCAN_HEADER` 11, `SCAN_PARSE` 9, `UNION_TYPE` 7,
`EDIT_REJECTED` 13). A first scan step costs about 100 output tokens plus one
full prefix read; its observation lands in the next step's uncached input
either way.

The tasks list 1 file (120), 2 (111), 3 (30), 4 (15), 5 (6), 7–9 (15) or 21–24
(12); 36 use a glob. Extensions: csv 762, xlsx 63, txt 24, gpkg 12, dat 9, and
a tail of tle/sp3/lst/html/json/npz/cdf. The model's own first scan covered
every listed file in 232 of the 286 scan-first tasks.

### 1.3 Errors

Per arm (Data-only / Flow-only / Data+flow): `EXECUTION_TIMEOUT` 18 / 15 / 31 —
infrastructure, not the model; `EDIT_REJECTED` 17 / 34 / 23, of which ~70 of
~75 are `Unknown op '…'` (the model put the operator id or an invented name in
`op`, although the tool schema already constrains `op` with `anyOf`/`const`);
`CALLBACK_SIGNATURE` 10 / 6 / 10 (removed since by the positional-binding fix,
`a013fdd10`); `CALLBACK_RUNTIME` 11 / 12 / 10; `MISSING_COLUMN` 7 / 11 / 2;
`SCAN_HEADER` 9 / 8 / 8. Repair steps are 26–33 per arm, 6% of cost.

## 2. The improvement space, priced

For every task, price the trajectory "its most expensive build step + its
answer step" — the two model calls no dataflow task can avoid. That ideal costs
46.9% of the actual bill across the 312 traces (43.8% archeology … 58.1% legal;
53.7% easy, 44.1% hard). The other 53% is the price of not knowing the data
before the first call (scans), of building the DAG in 2.2 rounds instead of one,
and of repairs.

| Group | Tasks | Pass % | Steps / task | Scan / task | Build / task | Repair / task | $ / task | Scan share of $ | Ideal share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ALL | 312 | 69.9 | 4.97 | 1.43 | 2.23 | 0.28 | 0.0340 | 16.9% | 46.9% |
| easy | 126 | 81.7 | 4.39 | 1.27 | 1.83 | 0.24 | 0.0243 | 17.5% | 53.7% |
| hard | 186 | 61.8 | 5.36 | 1.54 | 2.50 | 0.31 | 0.0406 | 16.7% | 44.1% |
| archeology | 36 | 41.7 | 5.00 | 1.39 | 2.17 | 0.44 | 0.0300 | 16.4% | 43.8% |
| astronomy | 36 | 44.4 | 5.42 | 1.17 | 2.83 | 0.44 | 0.0496 | 12.7% | 41.3% |
| biomedical | 27 | 74.1 | 6.41 | 2.11 | 2.96 | 0.33 | 0.0366 | 25.2% | 34.7% |
| environment | 60 | 80.0 | 5.05 | 1.43 | 2.22 | 0.38 | 0.0381 | 14.7% | 48.1% |
| legal | 90 | 84.4 | 4.18 | 1.36 | 1.63 | 0.09 | 0.0263 | 19.4% | 58.1% |
| wildfire | 63 | 68.3 | 5.13 | 1.41 | 2.46 | 0.24 | 0.0334 | 16.6% | 45.0% |

Pass % is the exact-pass rate on each task's official primary metric, pooled
over the three arms.

Ranked by size and by how far a dataflow property reaches them:

1. **Scan-only steps — 16–18% of cost, present in 92% of tasks.** A scan's
   output is a function of the file alone. The system can run it before the
   first model call. This is the lever built and measured below.
2. **Extra build rounds — 2.2 build steps per task.** Partly the same root
   cause (the model builds incrementally because it has not seen the data), so
   seeding should move this too; partly genuine iteration on values.
3. **Prefix cost — 31%.** Every step re-reads ~10.8k cached tokens. The V2
   system prompt is 4k tokens larger than V1's per step. Bounded: even a free
   prefix would save 31%, and the offline probes already showed layout changes
   move single-digit percent (§3 confirms this on real traces).
4. **Repairs — 6%.** `Unknown op` rejections (~70 of ~75 validate errors) are
   a schema-following failure the `anyOf` schema does not prevent; the
   positional-binding fix already removed `CALLBACK_SIGNATURE`.
5. **Python source in tool calls — ~13% of the bill.** A declarative
   expression form for filter/derive would shrink it, but that changes the
   operator algebra and the model's failure modes; not attempted tonight.

## 3. Finishing the LATEST / opBlock experiment

The 2x2 probe committed in `fa22f4213` (DELTA vs `opBlock`, evidence off/on, 5
tasks each) had never produced a valid run. It ran tonight on the pristine
frozen agent (port 3062), all 20 tasks executing normally.

| Arm | Pass | Steps / task | $ / task | Cached input | Uncached-input share of $ |
| --- | ---: | ---: | ---: | ---: | ---: |
| DELTA, no evidence | 3 / 5 | 4.20 | 0.0241 | 94.4% | 20.5% |
| opBlock, no evidence | 4 / 5 | 4.40 | 0.0322 | 85.1% | 42.8% |
| DELTA, Data+flow | 3 / 5 | 4.80 | 0.0295 | 93.4% | 25.3% |
| opBlock, Data+flow | 3 / 5 | 5.60 | 0.0414 | 84.9% | 36.5% |

Five tasks cannot support an accuracy claim (one flip each way is noise). The
cost mechanism, however, is unambiguous in the per-step usage. Under DELTA the
cache credit at step N equals the *entire* input of step N-1 — the transcript
is append-only, so only the new tool call and result are uncached
(archeology-easy-3: cached 9,186 → 9,804 → 10,507 tokens, uncached 3 / 621 /
706 / 341). Under opBlock the credit is 9,346 tokens at every step — the system
prompt plus the task message — and nothing else, although the operator blocks
above the insertion point were byte-identical (uncached 570 / 1,094 / 1,350).
The rendered contexts diverge exactly where the new operator's block is inserted
*before* the `# Last Action` tail, and in practice the provider credited none of
the stable blocks past the task message. LATEST/opBlock therefore sends 30–40%
less context per step and pays more for it. The offline probe's bound
("single-digit percent at best") holds; the retained-observation layout does not
turn it into a saving at these trajectory lengths. Recommendation: keep DELTA as
the campaign layout; if LATEST is pursued further, the moving tail has to go
first, and the provider's credit for stable non-prefix blocks has to be
demonstrated on real usage before betting on it.

## 4. Seeded source roots

### 4.1 Mechanism

A dataflow's root operators are the scans of the task's input files. Their
result is the one part of the graph the model cannot decide differently, so
the service runs them before the first model call:

- The client sends the task's file list with the message (`sources` on the
  WebSocket / HTTP message) when the arm carries `seedSources: true`.
- `TexeraAgent.sendMessage` plans one `scan` per listed path
  (`planSeedSources`): tabular extensions rely on the scan's own `auto`
  detection, other text files are read as raw `lines` (the model keeps the
  parsing decision), binary pointers (`gpkg`, `npz`, `cdf`, …) are skipped and
  reported, duplicates are folded, ids are the file stem as an identifier
  (`roman_cities`, `State_MSA_Fraud_and_Other_Data` for `dir/*.csv`).
- The plan is executed through the ordinary `dataflow` batch tool and
  recorded as an ordinary agent step (tool call, tool result, snapshot,
  post-step execution, captured observations), so every context layout renders
  it through the existing code path — byte-for-byte what the model's own
  opening scan step produces. The step is `synthetic: "seed"`, stepId 1, with
  zero usage; the model's first step is stepId 2.
- Budget: the seeded observations share four results' worth of characters
  (`4 × maxOperatorResultCharLimit`), never more than one result's limit per
  source and never less than 400 characters; tasks listing more than six
  sources are not seeded, because choosing the files is then part of the task
  and seeding them all would cost more context than the scan steps it removes.
  With the campaign's 2,000-character limit, 1–4 sources get the full 2,000
  each (identical to what the model would have received), 5–6 sources 1,600 /
  1,333.
- Off by default; the system prompt is unchanged, so control and seeded arms
  differ only in the presence of the seed step.

Files: `agent-service/src/agent/native/seed-sources.ts` (planning),
`TexeraAgent.seedSourceRoots` and the `sources` option of `sendMessage`,
`runPostStepExecution(…, { maxChars })`, `server.ts` (setting, message
fields), `types/agent.ts` (`seedSources`, `ReActStep.synthetic`). Client:
`seed_sources` on `AgentSettings` / `DataflowSystem` / the session's `run`,
arms in `systems/seed_probe_system.py`.

### 4.2 Verification

- Unit tests (`seed-sources.test.ts`, 8 tests): id derivation and collision
  handling, valid V2 batch for mixed extensions with binaries skipped, budget
  sharing, source cap, and full-turn tests with a stub driver: the seed step
  exists with zero usage and `synthetic: "seed"`, its scans are real operators
  of the DAG, the model's first request already carries the seed as a prior
  tool call and tool result, seeding is inert unless the arm opts in and the
  message names sources, and it requires the native batch V2 catalog. Full
  suite: 1,085 pass, 0 fail; `tsc` clean.
- Live smoke on the private stack, archeology-easy-3: the model's first
  request contained the scan's tool call and its observation (1,388 rows, 12
  typed columns, sample rows, column counts); it built filter → derive →
  aggregate and observed the sink in one step and answered 3.1333 in the
  next: 2 model steps against 3 for the control on the same stack.

## 5. Single-pass evaluation

Three arms, 104 tasks each, one original attempt per task, no reruns of any
kind; the campaign's frozen protocol (Terra-medium, Python V2, batch + observe,
profiling on, 25 steps, 2,000-character results, Data-only evidence):

- `DataflowSystemTerraSeedControlDeltaDataOnly20260920` — DELTA, no seeding.
- `DataflowSystemTerraSeedDeltaDataOnly20260920` — DELTA, seeded roots.
- `DataflowSystemTerraSeedOpBlockDataOnly20260920` — LATEST `opBlock`, seeded.

Concurrency two workloads per arm, tasks sequential within a workload (at most
one task per arm and domain, six machine-wide), agent = frozen patched copy on
port 3063, backend = the private stack. Scores by the repository's official
scorer; per-task cost from `stats.json` at the frozen rates; model steps
exclude the synthetic seed step.

### 5.1 Headline

| Arm | Official score (/104) | Tasks with a trace | Total $ | $ / task | Model steps / task |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control (DELTA) | 71.9% (74.8) | 99 | 3.23 | 0.0326 | 4.82 |
| Seeded (DELTA) | 69.0% (71.7) | 101 | 2.98 | 0.0295 | 3.73 |
| Seeded (opBlock) | 70.4% (73.2) | 101 | 3.94 | 0.0391 | 3.60 |

Missing tasks are watchdog stalls (8 minutes without progress, killed, scored
zero): control 5 (astronomy-hard-11, biomedical-hard-1, environment-easy-6,
environment-hard-16, environment-hard-19), seeded 3 (astronomy-hard-11,
environment-hard-16, wildfire-hard-19), opBlock 3 (astronomy-hard-11,
environment-easy-2, environment-hard-16). `EXECUTION_TIMEOUT` appeared 8 times
in the control traces and 11 in the seeded ones; available memory on the shared
machine dipped to 1–2 GB around 01:15 with six tasks in flight, which is the
likeliest cause of the stalls. No seeded scan ever timed out.

### 5.2 Paired: control vs seeded DELTA (98 tasks both arms ran)

| Metric | Control | Seeded | Δ |
| --- | ---: | ---: | ---: |
| Exact passes | 72 | 67 | −5 |
| Cost | $3.162 | $2.869 | **−9.3%** |
| Model steps / task (mean / median) | 4.80 / 4 | 3.68 / 3 | −1.11 (−23%) |
| Opening model step | scan 92, build 6 | build 69, scan 28, observe 1 | |
| Scan-only steps | 148 | 47 | −101 |
| Cached-prefix $ | 0.985 | 0.787 | −0.198 |
| Uncached-input $ | 0.686 | 0.679 | −0.007 |
| Visible-output $ | 0.943 | 0.899 | −0.044 |
| Reasoning $ | 0.548 | 0.503 | −0.045 |
| explore_scan $ / build $ | 0.615 / 1.998 | 0.232 / 2.051 | −0.382 / +0.053 |
| Cached input fraction | 93.5% | 92.1% | |
| Wall time / task | 46.0 s | 45.1 s | |

The saving is where the analysis said it would be: 101 of 148 scan-only steps
disappeared, and with them one prefix read per task; the seed's observation
costs exactly the uncached tokens the model's own scan would have (uncached
input is flat). Build steps got slightly dearer (more context and more code per
step, Python 42.5% → 49.6% of tool-call characters), which is why −23% steps
becomes −9% dollars: the removed steps were the cheap ones.

By what the seed did:

| Subgroup | Tasks | Steps ctrl → seeded | $ / task ctrl → seeded | Passes ctrl → seeded |
| --- | ---: | ---: | ---: | ---: |
| Seed replaced the opening scan | 68 | 4.75 → 3.40 | 0.0328 → 0.0288 (**−12.2%**) | 47 → 45 |
| Seeded, model re-scanned first anyway | 22 | 4.68 → 4.00 | 0.0275 → 0.0272 (−1.1%) | 18 → 18 |
| Not seeded (> 6 sources or binary only) | 8 | 5.50 → 5.25 | 0.0413 → 0.0394 | 7 → 4 |

Where the seed actually replaced the opening step the saving is 12%; the
re-scans are option corrections the default parse cannot know: `skipLines` /
`header:false` + `names` for files with preamble rows, `sheet` for multi-sheet
workbooks, raw `preview` on `.xlsx`, glob + `fileColumn` for multi-file unions.
Seed observations carried `SCAN_NOT_FOUND` 8 times (astronomy files the task
lists under stale names — the control hits the same error), `SCAN_HEADER` 4,
`SCAN_PARSE` 3.

### 5.3 Accuracy: inside the noise, and the losses are not on seeded tasks

Two same-protocol Data-only runs (2026-09-16 and tonight's control) score 72
and 72 exact passes on their 99 common tasks and still disagree on 12 of them (6
flips each way). Against that floor the seeded arm's 7-vs-2 flips are ordinary
volume. Gating on the 77 tasks whose outcome is identical across all four
non-seeded reference runs (the three 2026-09-16 arms and the control):

- Seeded DELTA loses 2 stable tasks — environment-hard-12 (9 sources) and
  environment-hard-18 (8 sources), **neither of which was seeded** — and gains
  0. On stable tasks that were actually seeded: 0 flips in either direction.
- Every other flip (archeology-hard-7, legal-hard-18, wildfire-easy-3,
  wildfire-hard-17, wildfire-hard-18 against; astronomy-hard-9, legal-easy-19
  for) lies on the 21 chronic flippers, tasks the reference runs already
  disagree on.

So at one replicate the data say: same accuracy, 23% fewer model steps, 9%
lower cost (12% where the seed applies). A second replicate of both arms is the
right next spend before quoting the accuracy number in a paper.

### 5.4 Seeded opBlock (98 paired tasks)

Passes 71 → 68 (2 stable losses, one of them unseeded), model steps 4.82 →
3.56, but cost $0.0326 → $0.0384 (**+17.7%**): cached fraction 93.5% → 79.7%,
uncached-input dollars 0.69 → 1.64, and the answer step alone costs 0.43 →
0.83 because it re-sends the whole dataflow uncached. The 104-task run
confirms §3: the LATEST family loses on caching what it saves on context size,
seeded or not.

(The step classifier is partially blind on this arm: LATEST renders results
inside operator blocks rather than tool messages, so error codes and `repair`
steps are not detected there; opening-step and step-count columns are exact.)

## 6. What did not make the cut, and why

- **Next for seeding: option corrections.** The 22 seeded tasks that still
  re-scanned did so to fix `skipLines`/`header`/`names` on preamble files, to
  pick a `sheet`, or to raw-`preview` a workbook. A seed that adds a raw
  `preview` next to the parsed scan whenever the parse yields unnamed or
  title-like columns, and that lists workbook sheets, would convert most of
  those; the traces above are the specification. Lifting the six-source cap
  needs a grouping rule (one glob scan per directory + extension), not more
  scans.
- **Strict `op` enum.** The batch schema already constrains `op` via
  `anyOf`/`const`; the ~70 `Unknown op` rejections are the model ignoring it.
  Fixing that needs provider-side strict schemas (19-variant `anyOf` is not
  supported) or a repair heuristic, which would be ad hoc.
- **Declarative predicates instead of Python callbacks.** ~13% of cost, but a
  change of algebra with unknown accuracy effects; a separate campaign.
- **Static schema propagation before execution.** Would catch
  `MISSING_COLUMN` and blocked dependents in one round, but the traces show
  only 2–11 `MISSING_COLUMN` per arm; repairs are 6% of cost in total.
- **Execution timeouts** (15–31 per arm) are the largest error class and are
  the backend's, not the model's; the private stack had none in the smokes and
  the probe, which is worth a comparison of its own.

## 7. Reproduction

```bash
# private stack (see /tmp/texera-evcomp/profile.sh; ports = default + 40000)
TEXERA_LOCAL_DEV_PROFILE=/tmp/texera-evcomp/profile.sh bin/local-dev.sh up --skip=frontend
# client endpoints
export TEXERA_API_ENDPOINT=http://localhost:48080 TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:48888
export TEXERA_WORKFLOW_EXECUTION_ENDPOINT=http://localhost:48085 SEED_PROBE_AGENT_ENDPOINT=http://localhost:3063
cd benchmark/Kramabench
.venv/bin/python kb.py tasks --sut DataflowSystemTerraSeedDeltaDataOnly20260920 --ids archeology-easy-3 --isolate
.venv/bin/python kb.py scores --sut DataflowSystemTerraSeedDeltaDataOnly20260920
```

The analysis scripts of this session (`analyze_traces.py`, `mine_scans.py`,
`compare_arms.py`, `breakdown.py`, `step_cache.py`, `prefix_diff.py`) read only
`react_steps.json`, `stats.json` and `evaluation.json` under `system_scratch/`.
