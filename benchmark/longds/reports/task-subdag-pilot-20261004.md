# Saved task sub-DAG pilot — 2026-10-04

The mechanism is implemented and works in the small live pilot. Both context
policies answered all five questions correctly. Thin context substantially
reduced history size, but required additional retrieval calls. This run does
not establish an accuracy or cost improvement.

## Implementation

Checkpoint `c5efaaafb` saved the earlier dependency census. Implementation
`110ce5ec3` adds:

- A thin prior-task index containing questions, answer excerpts and parent task
  IDs. Detailed operator references remain in stored provenance.
- One-call task inspection returning the answer roots and their complete
  upstream sub-DAG from the saved snapshot. Python and saved root results are
  optional; named roots select a saved intermediate branch. It never executes
  or substitutes the current graph, and shared ancestors appear once per
  snapshot.
- Optional `operator_ids` on free-text Answer when saved-state tools are
  enabled. Every declared source must exist and have a completed result before
  any declaration is recorded. Answer `from` records its sources automatically.
  Explicit roots override exploratory reads; undeclared sources are labelled
  `observed_reads` candidates. Unknown roots remain unknown.
- Immutable read-time snapshot receipts, so later edits/deletion do not bind
  earlier reads to a different computation. Different saved versions are
  returned as separate sub-DAGs.
- Generic prompt guidance to inspect relevant tasks, check rules and input
  coverage, reuse useful intermediates, repair faulty steps, recompute
  downstream results and preserve historical comparison branches. Dependencies
  and source declarations establish provenance, not semantic correctness.

This remains ordinary ReAct with history actions on the existing tool. The
feature is opt-in; there is no model ledger, new semantic-check API, or
benchmark-specific solver guidance. The default single-task prompt and tool
schema remain unchanged. The complete history prompt without a ledger is
[generated here](../../../native-mode/SYSTEM_PROMPT_WITH_HISTORY.txt); the
[enabled schemas](../../../native-mode/TOOLS.md) and
[mechanism documentation](../../../docs/observation-format/task-dependency-context.md)
are also saved.

## Verification

All 1,354 Bun tests passed, along with type checking and the generated-reference
check. Regression cases cover historical upstream closure, multi-root
deduplication, unrelated branches, later edits/deletion, missing roots, cycles,
incomplete inputs, explicit answer roots, candidate/superseded reads, invalid
source declarations, unavailable views and immutable context frames containing
Markdown headings inside saved Python. Existing first-task parity and prefix
tests also pass.

The five-task live fixture passed with zero model calls. It exercised cached
results, changed inputs, one-call historical task retrieval, forks, restores,
deletion and unknown-task errors through the real engine. Its allocated agent,
workflow and computing unit were removed after terminal execution.

The selected five reference answers reproduced exactly in the repository
Python environment. The raw numeric-gate CLI failed on notebook-only
`%matplotlib inline`; the recorded preflight removed that directive and
resolved the original relative data paths, without changing analytical logic.
The original failure and normalized preflight are retained. Reference code and
benchmark dependency annotations were never included in solver prompts.

## Frozen pilot

One LongDS session prefix:
`community/github_programming_languages_data/task1`, questions 1–5, one attempt
per arm. Question 5 depends on question 1, skipping the immediately preceding
task. Selection and source/input hashes were frozen before solver calls.

Both arms used implementation `110ce5ec3`, `gpt-5.6-luna` at medium reasoning,
native DELTA, saved-state tools, the same new prompt/tool schemas, the same data,
40 model calls per question, 8,192 output tokens per call and no input budget or
automatic compaction. Views were `sample`/`full`, with 2,000/5,000 character
budgets; profile collection was enabled, statistics exposure and flow evidence
were disabled. Only `taskContext` differed. The first model-call messages were
byte-identical across arms.

Official LongDS binary judgment used `deepseek/deepseek-v4-pro`. Identical
question/reference/answer triples shared judgments. There was no selective
solver replay; every call, failure, repair, answer and cost remains included.

| Measure | Full-history ReAct | Thin task context |
|---|---:|---:|
| Correct / judged | 5 / 5 | 5 / 5 |
| Model calls | 16 | 19 |
| Mean dynamic context characters / call | 34,977 | 11,004 |
| Mean provider input tokens / call | 20,468 | 13,950 |
| Total provider input tokens | 327,483 | 265,047 |
| Cached input fraction | 93.0% | 87.3% |
| Estimated solver cost | $0.017747 | $0.017736 |
| Solver wall time, sum over questions | 152.2 s | 109.2 s |
| Executed / cached operator visits | 62 / 42 | 23 / 20 |
| Failed action receipts | 6 | 1 |
| Within-task prefix changes / checks | 0 / 11 | 0 / 14 |

Dynamic context excludes the shared system prompt and tool definitions. Thus
the 68.5% reduction in dynamic context corresponds to a 31.8% reduction in
mean provider input tokens, and 19.1% fewer input tokens in total after the
additional calls. The solver-cost difference is negligible. These are
cache-aware estimates using the same frozen fallback rates, not invoices;
judge spend is separate. Parallel arms share provider prefixes, making costs
sensitive to cache timing.

## Trace findings

Thin context retrieved task 1's saved branch in questions 2–5. Each request
returned the relevant final branch and its upstream definitions in one call.
The model also inspected the live graph each time, showing that task retrieval
has not eliminated current-state discovery. Questions 2 and 3 consequently
required four and three calls, versus two each with full history.

Thin task 1 omitted Answer `operator_ids`, so later inspection correctly
labelled its roots as candidates and returned the earlier preview plus the
six-operator final branch as two saved components. Thin tasks 2–5 and every
full-history task declared their answer tables. This supports the requested
Answer parameter: explicit roots remove exploratory reads from future task
retrieval. The runtime cannot require that those declared computations are
semantically right; the prompt makes that distinction explicit.

Full-history question 4 initially left `language_issues_2011.in` unconnected.
Execution and three subsequent retrievals failed before repair. Thin question
4 had one rejected Edit with mismatched brackets; three later actions were
skipped and the next call corrected it. Both answers were correct.

Full-history question 5 initially expected `second_half_avg` before that column
was present in the joined result. The engine returned `MISSING_COLUMN`; the
model corrected the definition and answered correctly. Thin question 5 read
task 1 and computed the period averages successfully. Its five-language
selection, inclusion of 2011 and final quantities match the reproduced
reference. These are graph-wiring, syntax and schema-assumption errors; the
evidence does not establish a historical-state or cascading semantic failure.

The faster thin run includes fewer executed operator visits and different
repair behavior. It cannot be attributed solely to context reduction. No
solver fork or restore occurred in this prefix; those primitives were verified
by the live fixture. Cascading-failure reduction is unmeasured, and there is no
new comparison against DSGym.

## Next decision

Keep the mechanism opt-in. Before expanding the campaign, the main opportunity
is to reduce repeated whole-graph inspection after a task branch has already
been retrieved, while still making live-versus-saved changes clear. Consistent
answer-source declarations can also avoid fetching exploratory previews. This
pilot verifies the implementation and actual retrieval use; a broader accuracy
or efficiency conclusion needs more evidence.

Machine-readable metrics, roots, action errors, manual audit notes and hashes:
[pilot JSON](task-subdag-pilot-20261004.json).
Frozen protocol, source archive, reference preflight, live receipts, all ten
solver traces, official judgments, cleanup and logs:
`/var/tmp/dataflow-task-branch-pilot-20261004`.
The owned pilot service on port 3066 was stopped; shared backends stayed running.
