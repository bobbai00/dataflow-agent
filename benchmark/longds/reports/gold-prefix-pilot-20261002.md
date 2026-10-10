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
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Gold-prefix pilot, 2026-10-02 (one repeat, Terra)

Status: COMPLETE (one repeat). All 172 dependent turns ran in all three arms and
were judged; the last section states what is and is not established.

## Question

On turns that depend on earlier analytical state, when that earlier state is
correct, does the dataflow agent use it better than the script agent, and does
the state ledger (system-verified reuse) change that? The natural-session
protocol could not answer this: 74–82% of dependent turns sat on an earlier
wrong answer, so per-turn state use was measured on a few dozen surviving
turns, confounded by each arm's own cascade.

## Protocol

Design and tools: [docs/longds-gold-prefix-and-state-ledger.md](../../../docs/longds-gold-prefix-and-state-ledger.md).

- Five sessions (Restaurants 33 turns, Kiva 37, Netflix 36, Survey-2022 30,
  NFL 42); every turn's reference solution replays exactly in our Python.
- Units: the 172 dependent turns t ≥ 2. Each is run alone from the reference
  state after turns 1..t-1: kernel variables for the script arm, executed
  operators for the dataflow arms. Both arms receive the same request text:
  the completed tasks (request, reference solution, gold answer, tables created
  or changed), the tables in force, and the current question.
- Arms: `dsgym` (paper's agent over the local persistent kernel), `baseline`
  (current dataflow agent), `ledger` (dataflow agent with `stateHistory` and
  `stateLedger`). Model `gpt-5.6-terra`, medium reasoning, 40 model calls and
  8,192 output tokens per turn, no solver retries.
- Judge: appendix E.2 prompt, `deepseek/deepseek-v4-pro` through OpenRouter;
  binary; requested fields only.
- Cost: frozen token rates (Terra $2 / $0.20 / $2.50 / $12 per M for input,
  cached input, cache write, output). The dataflow gateway reports no cache
  writes; unknown writes are priced as fresh input. Judge spend is reported
  separately from the gateway's recorded cost.
- Services: one engine (38086); `baseline` on the agent instance at 3037,
  `ledger` on an instance at 3038 started on the same build; the script arm
  through the state-repair gateway (34000). Both instances ran the same code
  for every judged turn (the baseline turns that ran before the restart used an
  earlier build whose baseline code path is identical; 85 baseline jobs failed
  before any model call because of a runner/API mismatch introduced during the
  campaign and were rerun).

## Results

Full tables: [gold-prefix-pilot-20261002-analysis.md](gold-prefix-pilot-20261002-analysis.md)
(`gold_prefix_analysis.py --root /var/tmp/texera-gold-prefix-20261002/pilot1`).

| arm | correct of 172 | $/turn | calls/turn | output tok/turn | cached share | sec/turn |
|---|---:|---:|---:|---:|---:|---:|
| dsgym (script, kernel) | 149 (86.6%) | 0.0939 | 2.35 | 1,882 | 56% | 23 |
| baseline (dataflow) | 149 (86.6%) | 0.0958 | 3.73 | 1,730 | 75% | 32 |
| ledger (dataflow + stateLedger + stateHistory) | **153 (89.0%)** | 0.0964 | 3.67 | 1,696 | 75% | 33 |

By label (a turn counts under each of its labels):

| label | n | dsgym | baseline | ledger |
|---|---:|---:|---:|---:|
| Initial | 69 | 62 | 58 | 62 |
| Update | 55 | 47 | 46 | 46 |
| Counterfactual | 50 | 44 | 45 | 45 |
| Rollback | 48 | 40 | 44 | **46** |

By session (dsgym / baseline / ledger): Restaurants 25/26/25 of 32, Kiva
30/31/32 of 36, Netflix 32/32/33 of 35, Survey-2022 27/23/27 of 28, NFL
35/37/36 of 41.

Agreement: baseline vs dsgym both 138, only baseline 11, only dsgym 11, neither
12. ledger vs dsgym both 140, only ledger 13, only dsgym 9, neither 10. ledger
vs baseline both 140, only ledger 13, only baseline 9, neither 10.

Cost per turn is equal across arms (within 3%) **as reported by the two
gateways, which do not account alike**: the script arm's gateway reports its
fresh input as cache writes (billed at $2.5/M), ours reports no writes (billed
as fresh at $2/M). Under one rule the script arm is $0.0809 per turn, 18% below
the dataflow arms; see
[gold-prefix-pilot-20261002-trace-study.md](gold-prefix-pilot-20261002-trace-study.md)
§2.1. The dataflow arms spend less on output (1,700 vs 1,900 tokens) and more
on calls (3.7 vs 2.4), each re-reading a 23k-token cached prefix; 75% of their
input is cached against 56% for the script. Solver spend as reported: $16.15 /
$16.48 / $16.58; judge spend $0.62 for all 516 judgments.

State use: both dataflow arms wired a loaded table into new operators on 169 of
172 turns and read a source file anew on 8; the baseline retrieved a loaded
table before using it on 66 turns, the ledger arm on 77. In the ledger arm the
provenance card appeared on 169 turns and execution notes on 122 (105 of those
122 turns correct). The script arm wrote 232 code blocks, 8 of which read a
file, and answered 9 turns without code.

## Reading of the traces

- The 33 turns on which the arms disagree are dominated by analysis choices,
  not by which table was used: Survey t04 built the funnel stages as
  independent filters of the base table instead of nested ones; Restaurants t05
  defined its own high-value-customer flag; Netflix t25 labelled the wrong
  component; Survey t17 and Kiva t29 differ in the fourth decimal. The script's
  misses are the same kind (membership of top-k sets, one extra pair).
- With the reference state loaded, the script agent did not recompute from
  raw: 8 file reads in 232 blocks, against 42 of 95 Terra turns re-reading a
  file in the natural sessions. The 93%-reuse habit of the dataflow agent is the
  same as in natural sessions; what changed is that the reused state was right.
- The ledger arm's gain sits on Rollback (46/48 vs 44 baseline and 40 script)
  and Initial (62 vs 58 baseline). Its losses against the baseline (9 turns)
  are analytic as well (Restaurants t09 kept "no_change" families in a report
  that asked for diluted/amplified ones). The limited-table note fires on
  report shaping too (a `project` of a final top-k, the union of two top-10
  lists); restricting it to join/filter/aggregate/map/process consumers is the
  obvious refinement before the next repeat.
- Seeding cost: Kiva's state (9 M rows across ~70 tables) takes 290–350 s to
  materialize per turn against a 16–35 s model turn; this is harness time, not
  model cost, and the runner now survives the HTTP client's timeout by polling
  the seed step.

## What is and is not established

Established (one repeat, Terra, 172 dependent turns from correct state):

- With correct earlier state available, the dataflow agent is at parity with
  the persistent-kernel script agent on accuracy (149 = 149 of 172) and ahead
  on Rollback (44 vs 40); on cost it is 18% more expensive under uniform
  accounting ($0.096 vs $0.081 per turn), the difference being 1.4 extra
  calls per turn (trace study §2).
- The state ledger adds 4 correct turns (153) at the same cost, with its gain on
  Rollback (46) and Initial (62); against both other arms it wins 13 turns and
  loses 9.
- Neither dataflow arm recomputes loaded state; the script arm does not either
  when the state is in its kernel.

Not established:

- Significance: the differences (+4 overall, +2 on Rollback) are inside
  one-repeat noise for 172 turns; three repeats are needed before any claim.
- Generalization beyond these five sessions and this model; the Luna arms were
  not run on this protocol.
- Whether the ledger's effect comes from the receipts or from the prompt
  changes that accompany them (the arm enables both `stateLedger` and
  `stateHistory`); a `history`-only arm separates them.
- Natural-session effects: this protocol removes cascades by construction, so
  it says nothing about whether the ledger prevents the wrong-producer errors
  that start cascades in natural sessions. That is the next A/B.

## Operations record

- Pilot root `/var/tmp/texera-gold-prefix-20261002/pilot1` (runs, `jobs.jsonl`,
  campaign manifests, judge logs, `analysis.json`); gold state and prefixes
  under `/var/tmp/texera-gold-state-20261002/<case>`.
- 85 baseline and 124 ledger jobs failed before any model call during the
  campaign (runner/API mismatch while jobs were launching, a 300 s client
  timeout on Kiva seeding, then `/home` reaching 100% so the engine could not
  write result tables); all were rerun. No job failed after the relaunch.
- Per-step snapshots were gzipped (6.3 GB → ~0.6 GB); the engine result store
  of a dormant stack (`task-history-dataflow`, 21 GB) was deleted to free space.
