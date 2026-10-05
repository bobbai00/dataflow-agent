# Terra LongDS pilot: accuracy gains with incomplete sessions

Stop at the four planned attempts. Terra dataflow records **24 correct
answers**, compared with DSGym's **19**, but both dataflow sessions terminate
before Q19. This pilot exposes a context-handling failure and does not establish
a complete-session accuracy or cost advantage.

On the **31 questions completed by both systems before those stops**, dataflow
gets **24/31** right versus DSGym's **14/31**, at **$2.52968 versus $2.22999**
estimated solver cost: **13.4% more**. This is an encouraging diagnostic result
on two selected prefixes, with one attempt each; it is not a benchmark-wide
estimate or an isolated measurement of the benefit of saved dataflow state.

The [portable results and audit](terra-pilot-results-20261005.json) preserve
all 71 recorded outcomes, provider usage, missing-question lists, original
grades, context-loss evidence and provenance. Raw traces, wire captures,
service log and frozen source remain at
`/var/tmp/dataflow-terra-pilot-20261005`. The
[predeclared plan](terra-pilot-plan-20261005.md) limits this experiment to four
attempts. There were no solver reruns, additional arms or scope expansion.

## Completion and results

Both systems start from clean raw inputs and run the natural Q1–Q19 prefix
for `community/kaggle-survey-2021/task2` and
`business/netflix_movies_and_tv_shows/task3`.

| Measure | DSGym Python | Dataflow full/history |
| --- | ---: | ---: |
| Planned questions | 38 | 38 |
| Completed turns | 38 | 31 |
| Recorded outcomes, including terminal errors | 38 | 33 |
| Correct answers recorded | 19 | 24 |
| Official full-prefix accuracy | 50.0% | Incomplete |
| Unattempted later questions | 0 | 5 |
| Local input-budget failures | 0 | 2 |
| Valid finite JSON-object results | 36 | 31 |
| Provider calls, including summaries | 151 | 194 |
| Paid summary calls | 24 | 0 |
| Uniform estimated solver cost, all work | $3.02140 | $2.54255 |
| Sum of per-turn elapsed seconds | 1,188.256 | 1,424.943 |

| Prefix | DSGym correct / completed | Dataflow correct / completed | Dataflow stop |
| --- | ---: | ---: | --- |
| Survey | 12 / 19 | 14 / 17 | Q18 blocked; Q19 unattempted |
| Netflix | 7 / 19 | 10 / 14 | Q15 blocked; Q16–Q19 unattempted |

The two terminal budget errors have recorded official grades of zero. The
five later questions have no answers or judgments; they are not silently
assigned zero. Dataflow's full-prefix accuracy therefore remains unknown.
Its 31 completed turns include Netflix Q14's deliberate limitation answer,
which correctly receives grade zero.

Sessions run concurrently with one worker per system. Elapsed-time totals
describe these attempts; they are not controlled standalone latency figures.

## Cost and failure bias

Total estimated solver spend is **$5.56394**, plus **$0.18861 reported for new
judge calls**. All 345 captured solver requests have known usage. The solver
estimate uses the same frozen rates for both routes: $2/M fresh input,
$0.20/M cached input and $12/M output, without a route-specific cache-write
surcharge. It includes paid summaries and work preceding terminal failures.
These estimates are not invoices; judge usage cost is reported separately.

The raw total makes dataflow appear 15.8% cheaper, but it stops early and
skips five later questions. That is not evidence of a full-session saving.
Turn-level statistics also omit the paid work immediately before the two
native error records. The portable report uses captured wire usage to include
that work rather than treating it as free.

The common completed prefixes are Survey Q1–Q17 and Netflix Q1–Q14:

| Aligned diagnostic scope | DSGym | Dataflow |
| --- | ---: | ---: |
| Questions | 31 | 31 |
| Correct | 14 | 24 |
| Provider calls | 124 | 192 |
| Estimated solver cost | $2.22999 | $2.52968 |

This cohort is chosen after observing stop boundaries, not by selecting
correct answers. It still conditions on session completion and is not a
causal adjustment. A separate behavior-conditioned subset where both systems
submit computation contains 29 questions: DSGym gets 12 right at $2.13572;
dataflow gets 23 right at $2.25017, or 5.4% more cost. That subset excludes
some legitimate reuse without new execution and should remain secondary.

Across all recorded work, cached input is 89.0% for dataflow and 74.6% for
DSGym. DSGym emits 133,262 output tokens versus dataflow's 69,688, including
its paid summaries. Output cost explains why fewer Python calls do not
necessarily produce a lower raw total at these model prices.

## What the traces reveal

**Compaction can erase the result the model just requested.** Netflix Q14
asks to revisit the earlier maturity treatment while preserving other score
adjustments. The first task inspection succeeds. After a larger implementation
inspection, the budget assembler reduces estimated input from 40,639 to
23,920 tokens, but removes all current tool frames. The next request has 28
messages instead of 30; it contains historical question/answer cards and the
current question, without the current inspection or its result.

Steps 3 and 4 receive identical assembled message arrays. Across the turn,
34 of 40 model calls receive no tool frame. The agent makes 40 successful
Inspect actions, no Edit or Execute, and no tool-error receipts, then submits
a limitation rather than the requested markets and score recoveries. This
costs $0.25583. Repeated successful retrievals do not help when compaction
removes the evidence before the next model call. This is direct evidence of
a framework problem; fixing visibility may improve the outcome, but that
counterfactual has not been tested.

**Historical retrieval is selective but still too large.** The two terminal
failures follow successful inspections:

| Failure | Inspected saved task | Local / full upstream operators | Raw JSON receipt | Main contributor |
| --- | ---: | ---: | ---: | --- |
| Survey Q18 | Task 1, implementation off | 4 / 4 | 18,653 characters | Encoded original request: 10,900 characters |
| Netflix Q15 | Task 13, implementation on, `sample_stats` | 18 / 18 | 98,794 characters | Encoded dataflow block: 87,900 characters |

Sizes use Python's default JSON serialization, including escaping. They are
raw receipt sizes, not provider token counts or a claim that every raw byte
was sent unchanged. Survey's request replays setup instructions and the raw
file inventory. Netflix's dataflow includes definitions in both operator
objects and rendered operator blocks. The latter contain 44,661 and 38,060
encoded characters respectively. Both branches have zero upstream boundary
inputs. These are actual returned saved sub-DAGs, not whole-session graph
queries or evidence that every task requires 71 operators.

Task 13's Answer already declares the single root
`task13_uncertainty_analysis`. Answer anchoring alone does not bound that
root's transitive upstream implementation text. It also emits a report-oriented
subset; a later question with a different comparison set may need the
upstream table and a new computation rather than the previous answer table.

The next inputs cannot fit even after compaction: **32,266 estimated tokens
at Survey Q18** and **36,330 at Netflix Q15**, against the 32,000 cap. Those
requests are rejected locally before reaching the provider. All sent
requests stay below the cap in both the frozen estimate and reported input
usage. There are **zero captured provider error responses**. This is not a
provider outage or evidence that Terra's native context window is 32k.

**Semantic mistakes remain.** Selected recorded examples include Survey
Q4's Nigeria rank of 46 rather than 45, and Q7's male Software Engineer count
of 2,124 rather than 2,045. Q8 repeats the latter count and also selects a
much smaller subgroup than required. Netflix Q1 counts 2,676 missing movie
durations rather than zero, including rows for which movie duration is
inapplicable. Q2's France maturity component error is repeated in Q3.
These examples show surviving numerical and selection errors and downstream
reuse of wrong values; they do not establish saved-state corruption or a
complete causal error taxonomy.

## Model comparison, scoring and integrity

The native prompt, settings, prepared question hashes and all native source
hashes match the preceding clean-input Luna full arm. On the same 31 completed
prefix questions, Luna dataflow had 19 correct and Terra has 24; Luna DSGym
had 15 and Terra has 14. Across the full planned prefixes, Luna dataflow
completed all 38 with 22 correct, whereas Terra records 24 correct with five
unattempted. DSGym's full-prefix result stays at 19/38. The model change
helps some answers in this diagnostic trial but does not by itself solve
completion or prove a general accuracy improvement.

Both systems use `gpt-5.6-terra`, medium reasoning, a calibrated complete-input
32k cap, at most 40 model calls per turn and 8,192 output tokens per call.
Dataflow uses ordinary native ReAct, DELTA, dependency cards, saved task
versions, full prompt and `sample_stats`/`full` retrieval. Samples and
statistics each have a 2,000-character budget; full results have a 5,000
character limit. Automatic flow evidence and the state ledger are disabled.
DSGym retains its persistent Python kernel and pays the same model to compact
complete older messages together with kernel inventory; it never resets the
kernel. No solver is seeded with correct historical answers.

Official grades use the existing LongDS binary judge prompt and
`deepseek/deepseek-v4-pro`. Exact question/reference/answer identity reuses
two cached judgments. The other 69 verdicts require 68 judge API calls;
one empty answer receives the established zero score without a call. No
additional model is called to explain errors. Both native Q19 targets are
unattempted, so their component scores remain unknown. DSGym's two Q19
answers pass the binary judge; their unfamiliar field layouts remain
unscored by the frozen automatic component rubric.

All 77 raw input files, totaling 148,072,777 bytes, match pinned dataset
revision `6b448459c333ecc050a2e89fcc65c0e044d763ac` before and after execution.
Prepared input hashes match Luna. The reused published-reference gates
reproduce all 38 expected prefix answers on separate writable raw copies.
References and gold answers remain outside solver input directories. Python
uses a read-only raw mount; the native engine has broader host access, so
input inventory is equal without claiming identical filesystem isolation.

The frozen source archive contains 196 files at `4af7fb5b1`, all verified
against recorded hashes. The harness model/accounting changes pass **135
targeted LongDS tests**. Both owned agents, workflows and computing units
are removed; the private agent service at port 3070 is stopped. Shared
backend services remain running. All failed attempts remain preserved.

## Next change before spending again

Fix context handling offline first: preserve a bounded representation of
the latest tool result, make omitted content and retrieval continuation
explicit, remove duplicate setup text, and return operator implementations
once with focused or paged access to the rest of the saved branch. Compact
older task cards before discarding the evidence needed for the current
decision. Add regression coverage for a large successful inspection under
the complete-input cap, including the repeated-inspection sequence above.

Then review whether another small paid pilot is warranted. This experiment
is finished; no further solver runs or scaling are started.
