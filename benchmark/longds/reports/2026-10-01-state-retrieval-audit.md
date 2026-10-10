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

# LongDS state retrieval and correctness audit

The remaining accuracy gap is mostly real. Of the 18 failed Terra answers
after repairs, **17 contain concrete errors in requested results**. Kiva
Task 1 is a convincing disputed rejection: its alternative explanatory
components are correct. Binary scoring also hides substantial partial success.
Separately, the error classifier can locate a failure too late, and a passing
answer can carry an incorrect computation into later tasks.

Keep **after repairs** as the baseline: agent revision
`8fab7431b3f56cfef39d5b97db1ee3850d2fa0c7`, engine revision
`638e2b80f3f2c19e03faa5a0ff6bb88d0ca88408`. This audit covers all 46 recorded
answers in that follow-up: 38 Terra and eight Luna. It adds manual findings and
deterministic diagnostic credit. Original DeepSeek V4 Pro correctness grades
and Codex Appendix E.3 classifications remain unchanged.

The [audit data](2026-10-01-state-retrieval-audit.json) contains all question
scores, manual findings for all 22 failed answers, original classifications,
source paths and hashes, independent reference checks, and saved execution
profiles. The [previous report](2026-10-01-state-history.md) describes the
campaign, costs, and original protocol.

## What the judges miss

**Kiva Task 1 is a question interpretation problem.** The answer reports loan
scale, completion gap, wait burden and term burden; the reference reports the
underlying counts, completion and time values. The question asks for component
values and does not explicitly require those raw fields. Re-executing reference
Task 1 with the same input files reproduces all five ranked identities and
**35 of 35 reported values**. Both the correctness judge and Codex classifier
penalize the missing raw fields. I would accept this answer under the question's
wording; the official zero is preserved. Accepting this one disputed case would
change Terra from 20/38 to 21/38, still below saved DSGym's 31/38.

**A passing grade does not validate the stored state.** Kiva Tasks 14, 15, 18,
21 and 23 answer their requested quantities correctly but include wrong extra
scores inherited from Task 13. The original correctness prompt explicitly
ignores unrequested fields. These passes are consistent with its contract, but
the wrong scores remain a problem for future tasks.

**The classifier can misidentify the first divergence.** Restaurants Task 4 is
labeled a new coding error. Its faulty decision predicate already exists in
the passing Task 3:

```python
# Saved predicate
(commercial and pressure_count <= 2) or quality_clear
# Required predicate
commercial and (pressure_count <= 2 or quality_clear)
```

Applying the saved predicate to reference intermediates changes zero labels
among Task 3's 30 units. Under Task 4's new quality assumption, it produces
exactly the observed **13 movers instead of 10**, including the same three
extra units. The temporary 4.0 quality threshold is correct. Reusing that
saved definition without checking the instruction would preserve the bug.

## Where the real errors come from

| Case | Direct trace evidence | What retrieval can help with |
|---|---|---|
| Luna Restaurants 5–8 | Task 5 selects all Task 3 decisions while `advance_filter_t3` still exists. Task 7 uses a limited report as the full subsidy pool. | Locate the actual eligible population and distinguish a full table from its report. |
| Terra Restaurants 6 and 8 | An optional join carries the global customer baseline only for two of 17 units. It is null for all eight reported units, causing eight wrong shortfall labels and then a false boundary-change conclusion. | Inspect Task 5 and reuse its independent one-row `all_order_hv_share` anchor. Verify fields after rewiring. |
| Kiva 2 | `early_top10` limits the unsorted `early_pressure_view`. The preserved sorted node is named `early_top5`. | Inspect definitions and edges instead of inferring behavior from operator names. |
| Kiva 9 | Partner records are filtered to selected countries before percentile ranking. The reference ranks the full kept partner table first. | Inspect the population on which the score was computed; preserve it when producing a report subset. |
| Kiva 25–26 | Current complete-evidence population is retained, but the agent sorts raw country-sector demand scores instead of applying the earlier partner-match blend. | Retrieve the full formula from Task 10: `0.55 * demand + 0.45 * specialized_partner_score`. |
| Kiva 13, cascading into 16, 17, 19, 20, 22 and 24 | `country_poverty_scores` percentile-ranks the high-MPI-region share, which should enter the formula as a raw percentage. | Inspection exposes the error, but recovery requires checking the new formula against the instruction. There is no earlier correct version of this new calculation. |
| Netflix 1–3 | Missing movie durations are counted over all titles. `UR` is classified as adult, changing France's score and its later decomposition. | These are initial computation errors. Preserving or retrieving the same state alone cannot correct them. |

For Restaurants Task 6, a repair deletes a failed cross join to
`overall_order_rates` and rewires the downstream calculation. That join was
not the missing high-value-customer anchor. The real problem is sourcing a
global constant through the advance-only coverage table. The saved execution
profile proves 15/17 null global baselines and customer gaps; the correct
one-row anchor remains in the graph. The counterfactual is to supply that
anchor independently to every pool row, while zero-filling unproven coverage
as instructed.

These mechanisms cross State, Context, Coding and Statistical labels. Report
the root mechanism and downstream affected questions alongside the original
category counts. Dataflow preserves the evidence needed to diagnose them;
it does not guarantee that the agent selects or validates the right state.

## Partial credit alongside official accuracy

| Model and prefix | Official correct | Diagnostic partial credit |
|---|---:|---:|
| Luna Restaurants 1–8 | 4/8 | 61.5% |
| Terra Restaurants 1–8, Kiva 1–26, Netflix 1–4 | 20/38 | 76.9% |

The diagnostic compares explicit requested fields against the saved reference,
without another LLM. For each table it averages identity F1, requested-value
accuracy, and positional accuracy when ordering is requested. Missing rows
receive no value credit; extra and duplicate rows are penalized. Answer groups
and then questions receive equal weight. Numeric equality is exact, ignoring
trailing zeros. Field aliases, sign conventions and count complements are
recorded explicitly. Wrong additional reported scores are audited separately.

Examples:

- Netflix Task 1: nine of ten requested counts correct; **90.0%** diagnostic.
- Netflix Task 2: all five markets and 28/30 numeric values correct;
  **97.8%** diagnostic.
- Netflix Task 3: all five component names and four of five numeric
  contributions correct; **95.0%** diagnostic.
- Restaurants Task 6: all eight identities and their order correct, all eight
  shortfall labels wrong; **66.7%** diagnostic.

These weights are a **post-hoc diagnostic**, not a new benchmark accuracy
claim. Kiva Task 1 retains the strict raw-reference-field contract in this
score; its correct alternative components are documented separately. The
adapter supports these reviewed JSON answers. Saved DSGym prose requires
explicit canonicalization before a comparable partial score can be reported.

To reproduce the field-level comparisons:

```bash
.venv/bin/python benchmark/longds/audit_after_repairs.py \
  --campaign logs/longds-state-history-20261001/followup/campaign.json \
  --output logs/longds-state-retrieval-20261001/partial-scores.json
```

## Implemented retrieval changes

Implementation commit: `0bb89138e`.

The existing ReAct action schema and shared workflow remain the interface.

1. **Task inspection identifies relevant activity.** A task overview derives
   changed and retrieved operators from successful action receipts. It returns
   descriptions, input IDs, row counts, result availability and incoming edges.
   Other operators remain accessible by ID. Old traces without receipts fall
   back to the full graph.
2. **Operator inspection includes immediate input definitions.** Expressions,
   optional Python implementation, saved row counts and dependency hashes all
   resolve against the requested historical task. Follow input IDs for deeper
   dependencies. Duplicate callback code is omitted when already present in
   the function definitions.
3. **Read identity stays explicit.** Task-end definitions are distinguished
   from earlier retrieval receipts, including reads of older tasks and reads
   superseded in the same action list. Activity is a navigation aid, not proof
   that a retrieved value caused the final answer.
4. **The opt-in history prompt asks for inspection before reusing an earlier
   stage or changing a baseline.** It asks the agent to check population,
   eligibility, rank domain, complete score formulas and global anchors. A
   relevant definition already visible and unchanged can be reused directly.

All navigation comes from existing snapshots and append-only receipts.
Task overviews are returned only when requested. No new catalog, tool,
separate task graph, or persistent registry is introduced.

## Validation and cost limits

Frozen replay retrieves the Task 10 Kiva blend with its two inputs (183 partner
rows and 658 demand rows), the Restaurant decision predicate, and the Task 5
global anchor. Historical graphs remain unchanged. Compact task overviews show
12/88, 25/63 and 18/92 operators in these three cases; their serialized responses
are **34–69% smaller** than the previous whole-graph overview.

That reduction compares inspection responses. The baseline made **zero**
historical inspection, retrieval or fork calls, so adding useful inspections
can still increase total cost. Savings must come from avoiding reconstruction
and repair. A fresh solver experiment is needed to measure that tradeoff.

Validation: **1,164 Bun tests**, TypeScript typecheck, generated native
references, and **23 Python diagnostic/annotation tests** pass. Tests cover
historical version binding, immediate inputs, failed/skipped receipts,
historical read identity, fork immutability, partial-score handling and stable
request prefixes with history enabled. The prefix test now mocks compilation
to avoid contacting a developer's stack; the full suite uses closed local
service endpoints.

The baseline anomaly scan finds a maximum of 11 model calls per question
against the 40-call cap and no three consecutive identical action lists.
There are 59 error receipts, including failed downstream reads; this is not a
count of distinct engine faults. No confirmed infinite loop was found.
The saved wire audit reports no changed historical prefixes and 96.45% cached
Terra input. Existing Terra solver cost is $1.6763–1.7354 versus saved DSGym's
$1.8915 on the same 38 questions. This audit made no new solver or judge calls
and started no services.

## Next focused experiment

Start with Luna Restaurants 1–8 to verify that the agent actually inspects and
selects earlier state. Then run Terra Restaurants 1–8 and Kiva 1–26, with
Netflix 1–4 as a control for errors that retrieval alone should not fix.
Keep engine, inputs, result budgets and correctness/classification prompts
fixed at the after-repairs baseline; change only retrieval support.

Compare official accuracy, the frozen diagnostic rubric, manually confirmed
state-selection failures, downstream cascades, tool use and total solver cost.
Inspect each trace as it completes, including passing tasks that create state.
Check selected input edges and formulas, null anchors, limited-report reuse,
repair loops and request-prefix stability. The clearest Terra targets are
Restaurants 6/8 and Kiva 2/25/26; improvement there is a hypothesis to test.

Use the saved baseline for the first diagnostic comparison. Any stronger
claim of an accuracy or cost advantage needs fresh matched runs and repeated
trials, since the current evidence has one stochastic run per configuration.
