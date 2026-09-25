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


**First-pass mechanism audit.** Scores below are the recorded GPT-5.2 verdicts; no old answer was rejudged. Cases include accuracy gains, a regression, correct cheaper work, correct more expensive work, and cheaper failures. These explain observed mechanisms, not isolated causal effects of each change.

| Case | Old → new score | Calls | Model cost | Mechanism |
| --- | ---: | ---: | ---: | --- |
| Water 9 | 1 → 1 | 4 → 2 | $0.009892 → $0.004594 | The old run needed two repairs: restore blank flags, then resend a function lost at the call boundary. The new run reused five persistent functions for panel, flags, narrowing, severity and model fitting, and added only the changed fill and comparison. One action batch plus the answer replaced three batches plus the answer. |
| Water 10 | 1 → 1 | 2 → 4 | $0.003786 → $0.008159 | The new run initially bound a raw-value calculation to a transformed table, then repaired missing columns twice. Both runs ultimately passed. |
| Water 8 | 0 → 1 | 2 → 2 | $0.004401 → $0.004593 | The old code computed the severity threshold on all screened rows. The new code narrowed first and then computed both top deciles, matching the required active population. |
| Water 16 | 0 → 1 | 2 → 2 | $0.003364 → $0.003288 | The new risk-penalty calculation retained the narrowed population established earlier; the old calculation used the wider screened population. |
| Water 28 | 0 → 0 | 8 → 4 | $0.024417 → $0.012012 | Old: five nullable-value repair attempts, then an answer to the preceding question. New: fewer attempts and an answer to the current question, but it changed the requested tail definition after finding an empty group. |
| BI 22 | 1 → 1 | 2 → 2 | $0.003085 → $0.002270 | Both used one computation action and the answer. The new run has lower input/cache-write cost with no reduction in calls. |
| BI 25 | 1 → 0 | 2 → 2 | $0.002910 → $0.002391 | Both reported the same ordering and leader behavior. The new answer used 18-25 for the <=25 category and the judge rejected that label as a different interval. |

Water 9 is the clearest reuse example: the new batch calls `build_chemistry_panel`, `add_pressure_flags`, `make_narrowed`, `build_severity_table` and `narrowed_model_precision` without resending their bodies. It observes the final comparison table. The underlying functions and tables persist separately from the compact context entries.

Water 28 remains a failure: an empty requested subgroup should trigger an upstream population/formula check, not a new definition of the subgroup. The stored score remains zero even though this path is cheaper.

BI 7 also remained a failure: the judge demanded an ordered ranking and rejected the correctly valued JSON object as unordered. BI 25 was newly rejected for the interval label. These format-sensitive verdicts are retained without manual score changes.

[Structured case evidence](cost-r4-trace-audit.json) includes exact trace paths and interpretation limits. The [full report](cost-r4-results.md) includes repetitions and the combined cost target; this audit does not substitute selected cases for aggregate results.

The first Survey run exposes additional cost mechanisms. Question 4 performs
11 metadata/counting actions before the answer, and question 7 performs 12;
many feed all 23,998 rows of the wide source into functions that only inspect
the header. A materialized small header table would avoid that repeated
transfer. This is an execution-volume issue as well as an action-count issue.
The raw CSV uses empty strings for missing values in Q36 but literal `nan`
strings in Q40 (23,869 of 23,997 Q40_1 respondent cells). Native scan preserves
those strings; the agent initially interpreted them as answered monitoring
questions, then inspected frequencies and repaired its selection masks. This
is a source-format/missing-value contract problem, not an engine corruption
claim. Later repairs also had to preserve the genuine `None` opt-out category.
These observations motivate explicit source-contract guidance and reusable
metadata projections, without hard-coding task-specific column numbers.

Survey 5 is a recorded failure with an apparent judging error: the serialized
answer actually orders Data Analyst (12.8801) before ML/MLops Engineer (9.6601),
while the judge says it did the reverse. The descending-share sequence can be
checked deterministically. The score remains zero in all comparisons.
Survey 10 is different: all 14 result rows were visibly complete, and the
Statistician row showed 0.8928571428571429 for adopter share and 0.657 for lift.
The final JSON copied the lift into the share field. This is a transcription
error despite sufficient evidence, not a sampling failure. A future answer
format tied directly to computed fields could address it.

The second repetition makes the reuse limitation concrete. Water 9 costs
$0.003442 with two model calls but fails: the reused helper computes overlap
between severity and pressure-count top deciles (41.1371%), while the question
requires overlap between mean-fill severity and active severity (100%). The
function executed as defined. The agent selected the wrong semantic comparison.
This contrasts with the correct first-pass reuse case and argues for checking
population identities and comparison direction before reusing an answer table.
Water 2 also reintroduces the post-fill versus screened-center mistake corrected
in the first pass. These are analytical errors, not evidence of broken caching.

Survey 15 demonstrates useful extra work. The old entries run uses a CSV about
usage scenarios as if it described adoption plans and sums incompatible
percentages to 113%. The new run notices the source mismatch, reads the supplied
introduction, materializes the four planning shares, and answers 51% correctly.
It uses five generations ($0.006519), versus four ($0.005828) previously. This
verification is worth retaining even though it increases the question's cost.

In the third Water run, the missing materialization is explicit. Question 7
filters to the narrowed population inside `narrowed_review`, but returns only a
one-row report; it does not preserve the narrowed rows as a table. Question 8
then computes both top-decile thresholds on the full `model_panel` before
narrowing only the disagreement groups. Question 16 carries the wider population
forward and reports 315 top-risk rows instead of 299. The filtering code and
request remain in the history, so this does not establish compression loss.
It shows that the agent did not use the key Dataflow property: materializing
the population at the phase boundary so later operators consume that exact
state. The general prompt asks for this, but does not enforce it.

Water 9 succeeds in the third run (two generations, $0.005403), so the reusable
function mechanism succeeds twice and fails once across the repetitions. Water
as a whole scores 13, 10 and 9, versus DSGym's 15, 10 and 8: the overall subset
advantage should not be described as an accuracy gain on every task.
