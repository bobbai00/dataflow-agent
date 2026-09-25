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

**Offline estimate of cache-preserving context reductions, 2026-09-24.**
The proposed changes can retain the existing stable-prefix structure. Saved
traces support a planning estimate of approximately **12–19% lower model cost**
for the strongest `react-entries` arm, assuming the same actions, outputs and
cache reuse. This is not a measured new benchmark result or a guarantee of
accuracy. No models, workflows, services or evaluation judges were run.

The [structured estimate](analysis-state-cache-savings-estimate.json) records
calculations and evidence hashes. Its context decomposition comes from the
[two-level audit](analysis-state-two-level-memory-audit.md) and the earlier
[cache-aware cost breakdown](analysis-state-context-cost-audit.md).

**Cache behavior that must be preserved.** In the existing entries traces:

- All **357/357 consecutive model-input pairs within a question** retain the
  entire previous message list as an exact prefix.
- All **171 distinct historical entries** are identical whenever they recur.
- All **357 tool frames examined** are identical on subsequent appearances.
- Recorded cache reads account for **94.52% of input tokens**.

The newer arm also preserves the prefix within questions (686/686 pairs), but
its history selection changes between questions and its total read share is
84.65%. This illustrates why retaining stable history matters independently of
making a single prompt shorter.

The frozen transport marks the system prefix and the last two completed history
messages for caching. The proposed renderer should retain this message structure
and metadata. For a given session:

1. Select a fixed formatter version. Write each compact entry once when its
   question finishes and retain its rendered text without later rewriting.
2. Pin the task-start snapshot once. Build each observation against the correct
   preceding snapshot, and retain that observation as immutable event content.
3. Preserve the order: system/tools, completed entries, current task-start state,
   current question, then the growing action/observation sequence.
4. Preserve tool-call/result pairing and IDs even when an error response or an
   observation becomes shorter. Avoid moving changing selections ahead of the
   stable history.
5. Scope schema/sample references to immutable objects or versions. A later
   operator revision must not change the meaning or text of an older entry.

A deterministic transformation applied once to each new message preserves an
append-only sequence. Retroactively compacting earlier messages based on a new
question would not. A format migration in a running session can invalidate the
changed suffix once; adopting a fixed version for new sessions avoids repeated
cross-version churn. The provider's exact cache behavior still needs future
measurement; the trace checks establish message stability, not a contractual
guarantee of cache hits. A lower count of cached tokens can also result from
removing redundant cached content, without breaking reuse of retained content.

**Estimation method.** The calculations use locally cached `o200k_base` token
counting on saved text. The proxy model's actual tokenizer has not been verified,
so these are estimated tokens, not provider usage. No tokenizer download or
model inference was performed. Prices are the recorded repository assumptions:
$0.25/M cache writes and $0.02/M reads, not current public price claims.

The marginal cost model is:

```text
saving = removed tokens on their first appearance × cache-write rate
       + removed tokens on later appearances × cache-read rate
```

This assumes the stable prefix continues to be reused. It holds the action
sequence, output tokens and number of calls fixed. It credits no improvement
from fewer repairs, fewer observations requested, faster completion or better
accuracy. Results are scenario estimates rather than confidence intervals.

**Change 1: task-start observation baseline.** The estimator conservatively
removes only first-action operator blocks that are unrequested, unmodified by
the action, and whose entire result object is identical before and after the
question. It leaves requested tables, changed results and relevant errors. It
also retains a short list of unchanged existing failures. Missing final
snapshots and operators revised later in the question are excluded from this
reduction even if their first-action display may be redundant.

For entries, this identifies 14,906 blocks across 170 observations. The removed
text corresponds to an estimated **421,812 first-appearance tokens** and
**435,684 later-appearance tokens**. Estimated saving:

```text
421,812 × $0.25/M + 435,684 × $0.02/M = $0.11417
```

That is approximately **8.4% of the current $1.36132 model cost**. The larger
effect comes from fewer new cache-write tokens, even though the removed text is
only a small fraction of all input replayed throughout long histories.

**Change 2: output-selection scope on errors.** No saving from this correction
is assigned to the entries arm: its recorded dataflow responses are structured
and respect output selection. In the newer arm, twelve rejected calls expand to
685 successful table bodies despite an empty or omitted observation request.
Removing those bodies while retaining errors yields an estimated **$0.08611**
saving, approximately **4.7% of that arm's $1.83719 cost**. Its separate normal
baseline correction estimates another $0.08882; the two sets of removed blocks
are disjoint, so the estimate does not count them twice.

The optional policy of observing only a sufficient final table is not included
in any savings total. A static trace cannot establish which intermediate checks
a future model can safely skip or how many follow-up reads that policy creates.

**Change 3: compact completed entries.** The concrete Survey example drops from
3,918 to 2,688 characters, and from **1,050 to 747 estimated tokens (28.9%)**.
Its request, operator statements, Python, precise answer rows and complete answer
are preserved. This does not establish the same reduction for every entry.

Across the entries arm, historical entry text accounts for an estimated
20,733,466 token appearances: 358,744 when first introduced and 20,374,722 later
appearances. Its modeled marginal input cost is $0.49718. Applying different
history-reduction assumptions gives:

| History-token reduction assumption | Entry-format saving | Baseline-fix saving | Combined model cost | Reduction from current cost |
| --- | ---: | ---: | ---: | ---: |
| 10% | $0.04972 | $0.11417 | $1.19743 | 12.0% |
| 20% | $0.09944 | $0.11417 | $1.14772 | 15.7% |
| 30% | $0.14915 | $0.11417 | $1.09800 | 19.3% |

The 10/20/30% values are planning scenarios. No general entry-compaction
implementation was applied to the corpus. The approximately 29% token reduction
in one reviewed example makes the upper scenario worth considering, but is not
evidence that it is attainable everywhere without losing information.

Cache disruption is material: one million tokens changing from cache reads to
writes adds **$0.23** under these rates. That alone would erase the middle
scenario's $0.21360 saving. The implementation must preserve stable prefixes;
shrinking prompts while repeatedly rewriting them would undermine the estimate.

**Accuracy assessment.** The lowest-risk changes correct misleading re-execution
labels and remove duplicate presentation while preserving the dataflow, exact
source, full stored tables, request constraints, historical versions and numeric
precision. Holding the actions fixed leaves the calculations unchanged. Future
model decisions are not held fixed in a real rollout, so an unchanged aggregate
score cannot be guaranteed from these traces.

Less distracting status/error text could improve the model's decisions. That is
a plausible mechanism, not an observed score increase. Earlier formulas and
cohorts remain important for rollbacks and should stay available. Unique action
rationale should only be removed when its constraints are preserved elsewhere.
Error-scope correction may also remove accidentally useful unrequested tables
in the newer arm; its behavioral effect needs particular care. The successful
Survey normalization, partial-rollback and exact-arithmetic cases remain the
right preservation checks for later validation.

The observed entries accuracy remains **40.15% task-macro**. The estimate assumes
that accuracy is preserved and awards zero hypothetical accuracy gain. The
user's 25%-above-DSGym target is $0.96126 against the recorded $0.76901 baseline.
The scenarios remain approximately **43–56% above DSGym**, so these changes alone
do not establish that the target can be met. The middle scenario would need a
further 16.2% reduction from its estimated new cost.
