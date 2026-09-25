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


**Representative efficiency results: 9/9 sessions scored.**
The 25% DSGym cost premium target does not hold in every trial. Accuracy exceeds DSGym in every trial. Previous entries accuracy is not fully preserved in the matched trials. The efficiency mode remains opt-in; these measurements do not justify making it the default.

Three full LongDS v1 sessions per trial (Survey, BI, Water), 96 questions. Model: gpt-5.6-luna. Judge: GPT-5.2 with the same upstream prompt and references. Score 1 is correct. Historical controls retain their recorded results.

| Trial | Arm | Task-macro accuracy | Correct / 96 | Model calls | Model cost |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | dsgym | 59.44% | 56/96 | 206 | $0.343335 |
| 1 | react-entries | 69.44% | 64/96 | 259 | $0.495309 |
| 1 | react-efficient | 65.37% | 61/96 | 237 | $0.412522 |
| 2 | dsgym | 49.26% | 46/96 | 195 | $0.277326 |
| 2 | react-entries | 72.41% | 67/96 | 260 | $0.531901 |
| 2 | react-efficient | 70.37% | 65/96 | 240 | $0.419232 |
| 3 | dsgym | 49.63% | 46/96 | 176 | $0.256079 |
| 3 | react-efficient | 71.67% | 66/96 | 237 | $0.423101 |

Correct answers by task, showing trials 1 / 2 / 3 in each cell:

| Task | Questions per trial | DSGym | Previous entries | New efficient entries |
| --- | ---: | ---: | ---: | ---: |
| Survey | 30 | 18 / 20 / 11 | 27 / 27 / — | 20 / 27 / 28 |
| BI | 30 | 23 / 16 / 27 | 28 / 29 / — | 28 / 28 / 29 |
| Water | 36 | 15 / 10 / 8 | 9 / 11 / 10 | 13 / 10 / 9 |

A dash means no complete recorded comparison; it does not mean a zero score.

First pass by session:

| Task | Arm | Correct | Questions | Cost |
| --- | --- | ---: | ---: | ---: |
| Survey | dsgym | 18 | 30 | $0.111423 |
| Survey | react-entries | 27 | 30 | $0.169544 |
| Survey | react-efficient | 20 | 30 | $0.127779 |
| BI | dsgym | 23 | 30 | $0.037062 |
| BI | react-entries | 28 | 30 | $0.074787 |
| BI | react-efficient | 28 | 30 | $0.063293 |
| Water | dsgym | 15 | 36 | $0.194849 |
| Water | react-entries | 9 | 36 | $0.250977 |
| Water | react-efficient | 13 | 36 | $0.221450 |

| Trial | Historical control | Cost change | Accuracy change |
| --- | --- | ---: | ---: |
| 1 | dsgym | +20.15% | +5.93 pp |
| 1 | react-entries | -16.71% | -4.07 pp |
| 2 | dsgym | +51.17% | +21.11 pp |
| 2 | react-entries | -21.18% | -2.04 pp |
| 3 | dsgym | +65.22% | +22.04 pp |

First-pass recorded cost components:

| Arm | Uncached input | Cache reads | Cache writes | Output |
| --- | ---: | ---: | ---: | ---: |
| dsgym | $0.000828 | $0.120987 | $0.043058 | $0.178462 |
| react-entries | $0.000155 | $0.171219 | $0.134929 | $0.189006 |
| react-efficient | $0.000142 | $0.149633 | $0.093674 | $0.169073 |

Output includes reasoning tokens where the provider reports them as output; reasoning is not charged a second time. These are usage-based estimates at the recorded repository rates.

Costs on questions both systems answered correctly:

| Trial | Control | Both correct | Control cost | New cost | Change |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | dsgym | 44 | $0.124657 | $0.161068 | +29.21% |
| 1 | react-entries | 55 | $0.209103 | $0.190259 | -9.01% |
| 2 | dsgym | 39 | $0.092404 | $0.133828 | +44.83% |
| 2 | react-entries | 60 | $0.279968 | $0.204232 | -27.05% |
| 3 | dsgym | 42 | $0.098400 | $0.120911 | +22.88% |

This success-conditioned comparison helps separate cheaper correct work from stopping early; it is not a randomized estimate and does not replace the all-question scores and spending.

Recorded cache-shape checks: 432/432 consecutive within-question inputs preserve the entire earlier prefix, and 10047/10047 repeated history entries are byte-identical. These are recorded input checks; provider cache residency and billing remain separate.

First-pass generation categories (calls / model cost):

| Category | Previous entries | Previous selected memory | New efficient entries |
| --- | ---: | ---: | ---: |
| edit | 156 / $0.341477 | 161 / $0.354642 | 144 / $0.293747 |
| edit_and_retrieve | 0 / $0.000000 | 0 / $0.000000 | 0 / $0.000000 |
| retrieve | 0 / $0.000000 | 79 / $0.154908 | 1 / $0.002549 |
| observe | 7 / $0.011373 | 22 / $0.031699 | 2 / $0.003849 |
| other_tool | 0 / $0.000000 | 0 / $0.000000 | 0 / $0.000000 |
| no_tool | 96 / $0.142459 | 93 / $0.098823 | 90 / $0.112377 |

These categories describe what each generation requested, not the causal cost of that action. A retrieval request pays for its preceding context; later generations ingest the retrieved text. No-tool includes answer generations. Exact repeated requests ignore only reasoning text and do not count revised repairs as identical. Error counters are not a complete runtime-retry census.

Budget-stopped sessions: trial 1 Survey (25/30 turns finished before stopping). Unreached questions are scored as failures, and captured interrupted-call usage is included. Any in-flight provider usage that was not returned remains unknown.

Requests failed without returned usage at: trial 1, Survey question 6, trial 2, Water question 13. Their answers retain their scored failures, but any unreported provider charge is unknown; displayed model cost is recorded-usage cost.

Only complete three-task trials are aggregated. Missing or unfinished sessions are not silently scored as zero. Unanswered questions within a completed budget-limited session remain failures.

The [structured results](cost-r4-results.json) retain per-session usage, exact-prefix checks, paired accuracy flips and hashes. The [implementation and stable comparison](cost-r4-implementation.md) describe the changes and comparability limits. Costs use $0.20/M uncached input, $0.02/M cache reads, $0.25/M cache writes and $1.20/M output. Judge spending is recorded in each results_eval.json separately.
