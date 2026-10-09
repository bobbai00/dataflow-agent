# Saved task retrieval follow-up — 2026-10-04

The two selected LongDS prefixes finished: Restaurants questions 1–8 and
Goodreads questions 1–5, with one Luna run per context policy. Thin task context
scored slightly higher, but required more calls and did not establish a clear
benefit from historical state management. The traces expose semantic mistakes,
overly large saved-branch retrievals, and evaluation ambiguities worth fixing
before expanding the experiment.

## Matched protocol and verification

Runtime revision `c402225ca` contains the saved-branch implementation from
`110ce5ec3`. This follow-up changes no runtime code or solver prompt. Both arms
use `gpt-5.6-luna` at medium reasoning, native DELTA, the same history tools and
system prompt, identical task prompts/data, 40 calls per question, 8,192 output
tokens per call, and no input truncation or automatic compaction. Profile
collection is enabled; statistics exposure and flow evidence are disabled.
Retrieval views are `sample`/`full`, with 2,000/5,000 character budgets. Only
`taskContext` differs: `trajectory` versus `dependencies`.

Selection, source/input hashes, strict reference-JSON diagnostics and semantic
audit criteria were frozen before solver calls. Every preceding question is
included. Reference code and benchmark dependency annotations stay outside
solver prompts. All thirteen reference answers reproduced exactly in the same
Python environment; only relative paths and notebook display directives were
normalized.

An infrastructure abort preceded the completed comparison. The isolated
service ended when its launcher exec session was collected: both Restaurants
arms lost transport during Q1 and both Goodreads jobs failed before setup.
All four aborted job directories remain intact. A recorded amendment repeats
the entire matched cohort after holding the supported launcher session open;
there is no selection of successful solver attempts. Four completed model
calls and two additional started requests were observed before the abort, but
their full usage was lost with the in-memory trace. **Aborted spend is unknown,
not zero**, and is separate from the completed-run estimates below.

All 26 completed-run answers were collected and judged. First-call messages
were byte-identical between policies for each dataset; within-task prefix
changes were zero in 24 full-history checks and 52 thin-context checks. Frozen
source hashes still match. All four agents, workflows and computing units were
removed, and the isolated service was stopped. Shared backend processes remain
running. The implementation's earlier 1,354 passing unit tests, typecheck,
reference generation check and live fork/restore fixture are recorded in the
[preceding pilot](task-subdag-pilot-20261004.md); this experiment does not repeat
that unchanged test suite.

## Results

Official LongDS binary judgment uses `deepseek/deepseek-v4-pro`. All required
answer content must be correct; numeric equality is strict. Identical
question/reference/answer triples share judgments. Scores below are retained
without manual replacement.

| Prefix / measure | Full-history ReAct | Thin task context |
|---|---:|---:|
| Restaurants correct / judged | 2 / 8 | 3 / 8 |
| Restaurants model calls | 21 | 41 |
| Restaurants estimated solver cost | $0.033231 | $0.081888 |
| Restaurants mean dynamic context characters | 72,913 | 63,530 |
| Restaurants mean provider input tokens / call | 28,163 | 26,784 |
| Restaurants total input tokens | 591,429 | 1,098,157 |
| Restaurants cached input fraction | 94.7% | 83.0% |
| Restaurants summed question wall time | 174.9 s | 374.1 s |
| Goodreads correct / judged | 0 / 5 | 1 / 5 |
| Goodreads model calls | 16 | 24 |
| Goodreads estimated solver cost | $0.030857 | $0.031423 |
| Goodreads mean dynamic context characters | 44,359 | 26,213 |
| Goodreads mean provider input tokens / call | 22,158 | 17,406 |
| Goodreads total input tokens | 354,525 | 417,755 |
| Goodreads cached input fraction | 93.1% | 89.2% |
| Goodreads summed question wall time | 168.4 s | 151.5 s |

Dynamic context excludes the shared system prompt and tool schemas. Thin
reduces that mean by 12.9% on Restaurants and 40.9% on Goodreads, but its extra
calls increase total input tokens by 85.7% and 17.8%, respectively. Completed
solver cost totals are $0.064088 for full history and $0.113311 for thin, across
37 and 65 calls. These cache-aware estimates use the same frozen repository
fallback rates and include all solver errors/repairs. They exclude judge spend
and the unquantified abort. Parallel arms share provider prefixes, so cost and
latency remain sensitive to scheduling and cache warmth.

Both policies attempted and answered every selected question. Lower full-history
cost here does not come from unattempted questions. One run per arm over two
selected prefixes cannot support a statistical accuracy or latency claim.

| Dataset | Full-history correct questions | Thin-context correct questions |
|---|---|---|
| Restaurants | 1, 2 | 1, 3, 5 |
| Goodreads | none | 1 |

## What the traces show

**Saved retrieval works, but its size can erase the context reduction.** Thin
uses thirteen task inspections; full uses none. Restaurants retrievals return
16–71 operator entries per action, with full Python requested each time. Q6
retrieves Task 3 and Task 5 separately, returning 45 and 54 entries with shared
ancestry. Thin also performs six live graph inspections. Its larger graph
requires more edits and repairs: sixteen failed action receipts versus five
for full. Failed receipts include unavailable reads following a failed
execution, so they are not sixteen independent analytical mistakes.

**Explicit answer sources are useful but adoption is low.** Full declares
answer roots in twelve of thirteen tasks; thin does so in five. Without a
declaration, successful historical result reads remain labelled candidate
roots alongside the current result reads. Restaurants Task 3 therefore stores
ten candidate roots, including previously inspected Task 1/2 results, and
later retrievals include those branches. This is conservative provenance
fallback; it does not establish that each candidate contributed to the answer.

**Retrieval preserves versions; it does not validate their meaning.** Full
Restaurants Q3 joins pressure flags from the filtered watch list and fills
absent flags with zero/empty text. Non-watch units become falsely clear of
experience pressures, producing eight advances instead of three. That wrong
state propagates into Q4–6. Thin retains the complete pressure lookup and gets
Q3's 3/15/12 groups right, then correctly returns to the original advance
group for Q5 after Q4's temporary sensitivity.

However, thin's Q3 code contains a latent Boolean grouping error:
`(commercial AND pressure_count <= 2) OR quality` rather than
`commercial AND (pressure_count <= 2 OR quality)`. Q3's values hide the error;
copying it into the different Q4 quality gate produces thirteen moves instead
of ten. Both policies preserve the main valid-rating baseline. This failure
is semantic propagation, not a corrupt historical snapshot or failed restore.

**Complete upstreams are available, but the model can choose the wrong table.**
Thin Restaurants Q6 loses the global customer-share scalar through an optional
coverage join, filling unmatched units' benchmark with zero. In Q7 it retrieves
the saved Q6 DAG, then connects its new calculation to `subsidy_top8_t6` rather
than the complete `subsidy_scored_t6`. The report contains only eight of the
seventeen working units, so relevant units disappear from Q7/8. Full also
reuses its limited report. A returned upstream DAG does not guarantee correct
population selection or scalar propagation.

**Opaque process operators limit reuse.** Goodreads full Q1 omits the initial
15-book market-lift selection and materializes only its wrong final top five.
Thin selects the correct top five but its misleadingly named
`books_catalogue` returns only the finalized lifted slice. Q2 creates a new
`full_catalogue` by rereading the CSV and rebuilding all scores. Full repeatedly
rebuilds similar calculations in later process operators. Neither policy uses
a historical fork or restore. New separate branches preserve the language
sensitivity, but these runs do not demonstrate fork/restore superiority.

**Some failures are population or answer-coverage errors rather than rollback.**
Goodreads full Q4 ranks only reviewed survivors instead of the complete stricter
catalogue, producing ranks around 25 rather than 5,759. Thin uses the proper
rank universe and returns the correct top-five drift cases and magnitudes, but
includes the early-contrast set in the reviewed population: 36 retained versus
26. Full Q3 computes exactly the reference stability cases, rank shifts and
0.8 overlap; its official failure is omitting the explicit yes/no conclusion.
The manual audit records each question's cause and propagation separately.

## Evaluation caveats

Restaurants Q2 has inconsistent judge coverage. Both arms return the same
three requested units and pressure labels, and both have incorrect extra
uncertainty values. The full-history judgment ignores those values because
the question does not request them; the thin judgment treats them as required.
The official 1-versus-0 labels remain unchanged. This pair cannot substantiate
a history-policy accuracy difference without a symmetric output contract.

Goodreads has a reproducible CSV-parser ambiguity. With the same pandas 2.2.3
and `on_bad_lines="skip"`, the reference/default C parser loads 11,123 rows,
whereas thin's explicitly selected Python parser loads 11,119. Four additional
records disappear. Catalogue mean rating changes from 3.9340753394 to
3.9341352640, and the reader-count 90th percentile from 24,753.4 to 24,761.6.
Those differences propagate into global percentiles, scores and competition
ranks. The task specifies skipping malformed rows without choosing a parser;
this is input interpretation sensitivity, not library-version drift or proof
of state corruption. Other thin errors, including Q2 percentile scope and Q4's
review population, remain independent of that parser difference.

The frozen strict reference-JSON leaf diagnostic is also retained. It scores
nearly zero because the agents use different field names and structures,
including officially correct answers. It measures reference-schema agreement
and is unsuitable as semantic partial accuracy. The report therefore uses
official scores plus evidence-backed, question-level observations, without
inventing a favorable aggregate partial score after seeing answers.

## Direction to review before more runs

The thin index and saved-branch API are useful, but the current experiment does
not justify scaling the campaign yet. The next changes should be generic:

1. Return compact saved-branch topology first; fetch selected code/results on
   demand, and deduplicate identical operator versions across task inspections.
2. Improve explicit Answer source adoption while keeping unknown/candidate
   provenance visibly uncertain.
3. Encourage full named working tables, complete Boolean feature lookups and
   independent scalar benchmark nodes; inspect coverage before reusing a ranked
   report as a working population.
4. Freeze symmetric question-level output requirements and parser contracts;
   report output coverage and semantic errors separately from exact accuracy.
5. Use a shared initial graph in the next controlled context comparison. The
   Goodreads accuracy gain occurs on Q1, and Restaurants' graph granularity
   differs on Q1 despite identical inputs. Neither difference can be attributed
   causally to historical context handling.

The machine-readable
[report and complete manual audit](task-subdag-followup-20261004.json) retain
per-turn scores, costs, contexts, roots, retrieval selections and error receipts.
Raw protocol/source archives, all aborted/completed attempts, official judge
responses, parser audit and cleanup evidence are in
`/var/tmp/dataflow-task-subdag-followup-20261004`.
