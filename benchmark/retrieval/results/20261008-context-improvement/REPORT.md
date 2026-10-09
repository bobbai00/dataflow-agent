# Markdown iteration history — implementation and model comparison

**The approved 24-attempt comparison finished: 23 correct answers.** Native
history passed 12/12; Markdown passed 11/12. Both layouts preserved execution,
retrieval, evidence, and immutable context correctly in the audited requests.
DeepSeek's failed Markdown case repeatedly executed an empty graph. This starts
before any iteration history exists and is confounded by a different serving
provider. The format improves readability, but this pilot does **not** establish
a general accuracy or cost improvement.

The comparison ran agent revision `84e93fcae`, engine `e031c69df`, gateway
`57ee38a28`, and harness `be9c5fbae252158e2590ff41cf5093f3900a2dd5`.
Trace-driven agent fixes (`1160d3ab3`) were applied **after** the comparison and verified
with deterministic tests and a live engine probe. No extra paid attempts or
outcome-selected reruns replaced the original results.

## Implemented behavior

- Each iteration pairs decoded Python and graph declarations with saved
  outcomes: function registration/update, operator/edge changes, execution,
  retrieved tables, errors, and skipped actions. Submitted source is fenced
  and shown once per edit. [Task-general live examples](EXAMPLES.md).
- Reports match immutable requests and receipts by tool-call ID. They never
  infer success from submitted code or substitute current graph state for
  historical evidence. Malformed or unknown receipts retain raw repair context.
- Actual user tasks and final answers keep their roles; intermediate reports
  are labeled environment records. The system prompt still requires real
  `dataflow` calls. Original calls and receipts remain in saved traces.
- Existing budget rules select iterations/checkpoints. Checkpoints retain
  namespace cells in order, including unused functions, and preserve earned
  observations across verified cached executions. Changed or unrequested newer
  results never inherit old observations; loaded hidden definitions stay hidden.
- Flat native DELTA defaults to `messageLayout: "markdown"`; explicit `native`
  preserves the prior transcript. PATCH changes layout and prompt together and
  rejects incompatible settings atomically. Advanced historical context policies
  retain their earlier defaults.

## Controlled setup

Two prespecified tasks (`legal-easy-3`, `biomedical-hard-3`) × six configured
models × two layouts × one repetition = **24 attempts**, at most three workers.
Jobs were shuffled. Both arms used registered Python, DELTA history, full native
profiling, statistics and flow evidence, `sample_stats`/`full` retrieval, no
thought replay, and a 25-call limit. Sample/statistics/flow budgets were 2,000
characters each; full results were capped at 5,000 characters, sample rows at 5.
The system prompt differs only in layout guidance; tool schemas were equal.

Configured and returned model aliases matched the intended Luna/Terra/Sol,
Opus 4.8, Qwen3.8-27B, and DeepSeekV4.1-Flash routes. These aliases do not
independently verify backend model weights. Provider routing, initial cache
state, and sampling were not controlled. One repetition on two tasks supports
descriptive regression checks, not statistical significance or general ranking.
[Configuration and provenance](comparison-provenance.json).

## Results

Costs are **two-task sums of frozen public-rate estimates**, excluding scoring
and infrastructure. Calls count model decisions, not individual actions.
Seconds are mean agent time per task, including tools but excluding scoring.

| Model | Correct native / Markdown | Calls native → Markdown | Estimated USD native → Markdown | Mean seconds native → Markdown |
| --- | ---: | ---: | ---: | ---: |
| GPT-5.6 Luna | 2/2 / 2/2 | 8 → 8 | $0.006229 → $0.006250 | 23.3 → 23.8 |
| GPT-5.6 Terra | 2/2 / 2/2 | 8 → 9 | $0.065089 → $0.072901 | 23.2 → 23.7 |
| GPT-5.6 Sol | 2/2 / 2/2 | 7 → 8 | $0.114490 → $0.126758 | 22.7 → 25.4 |
| Claude Opus 4.8 | 2/2 / 2/2 | 6 → 11 | $0.206973 → $0.301498 | 21.1 → 31.5 |
| Qwen3.8-27B | 2/2 / 2/2 | 14 → 11 | $0.048995 → $0.040064 | 77.2 → 64.6 |
| DeepSeekV4.1-Flash | 2/2 / 1/2 | 9 → 30 | unknown → $0.024042 | 119.9 → 64.7 |

DeepSeek native made **10 API requests for 9 recorded decisions**: one request
timed out after 180 seconds, then a retry succeeded. Its total cost and complete
token/cache totals are unknown. The $0.006716 known-attempt subtotal covers only
biomedical; even the legal task's five successful response costs omit the timed-out
request. DeepSeek's cost contrast therefore uses only the biomedical pair;
score/call contrasts use both tasks.

Known whole-attempt estimates sum to $1.020005 across 23 attempts; the complete
campaign cost remains unknown. OpenRouter separately reports response costs:
Qwen native $0.028141 versus Markdown $0.029747; DeepSeek Markdown $0.014454,
native unknown. These can disagree with frozen-rate estimates and are not
mixed with them or claimed as invoices.

| Model | Input tokens native → Markdown | Output tokens native → Markdown | Cache-read fraction native → Markdown |
| --- | ---: | ---: | ---: |
| Luna | 72,322 → 71,830 | 1,449 → 1,575 | 76.6% → 77.4% |
| Terra | 77,305 → 90,163 | 1,700 → 1,756 | 79.0% → 79.2% |
| Sol | 65,569 → 78,923 | 1,356 → 1,696 | 74.1% → 78.4% |
| Opus | 84,922 → 185,812 | 1,772 → 2,704 | 75.4% → 86.8% |
| Qwen | 167,156 → 121,313 | 5,652 → 6,249 | 64.2% → 66.5% |
| DeepSeek | unknown → 291,495 | unknown → 11,270 | unknown → 89.8% |

Cache reads/writes are subsets of input; reasoning is a subset of output and is
not added again. Opus separately reported 20,850 native / 24,417 Markdown cache
writes. Unreported optional cache fields retain availability flags; estimates
document assumptions about unreported writes. Higher cache fractions can reflect
more repeated calls, including failure loops, and do not imply lower cost.
[All attempts, errors, evidence reads, and matched contrasts](comparison.json).

## Trace findings and repairs

1. **DeepSeek empty-graph loop.** All 25 legal Markdown responses came from
   Sail Research and emitted only execute actions: 46 failed actions, zero
   edits, no answer. Raw wire arguments and recorded requests agree. The first
   request contains only system and user messages, with the same strict tool
   schema as native. Its rationale sometimes says it needs a scan while its
   actions remain execute-only. Successful DeepSeek cases used Venice, DekaLLM,
   or Wafer. A provider/structured-decoder issue is plausible, **not proven**;
   the prompt also differs in layout guidance. [Wire findings](deepseek-wire-findings.json).
   The new guard warns after two consecutive execute-only empty-graph decisions
   and ends the turn with `EMPTY_EXECUTION_LOOP` after four, preserving receipts
   and reported usage. Any other action or a new task resets the streak. It does
   not block nonempty graphs or independent execution after a sibling failure.
   This bounds waste; it does not establish that the provider can solve the task.
2. **Opus stringified actions.** Biomedical Markdown had two before-action
   rejections because `actions` was a JSON string, additionally ending in an
   extra brace. Neither call changed the graph. The active validator now gives
   an explicit array example; it never silently decodes or repairs malformed
   arguments. Opus also joined incompatible identifiers, observed an empty
   result, and corrected the join. It needed eight calls versus three in native.
   The valid empty join is a model reasoning error, not engine failure.
3. **Qwen data cleaning.** Legal Markdown corrected string years by replacing
   the same registered function and succeeded in six calls. Native needed ten:
   title/footer parsing, silently coerced comma-formatted counts, then a small
   diagnostic table revealed the separators. Independent completed results
   stayed available after errors. Biomedical needed five versus four calls.
   The prompt already teaches numeric-text normalization; speculative automatic
   parsing changes are not justified by these traces.
4. **Sol/Terra contract repairs.** Sol requested the same columns from different
   tables: the valid target survived the other's missing-column error. A quoted
   dtype was rejected atomically and corrected next call. Terra repaired a nested
   call by naming intermediate nodes. Existing diagnostics and result retention
   worked; these do not justify changing the graph language.
5. **Accounting.** Failed/stopped turns previously returned zero API usage even
   with recorded model responses. They now retain reported step sums. Missing
   transport usage still cannot be reconstructed. Group cost reporting also no
   longer labels a known subset as a total; partial sums are explicitly separate.

## Integrity, tests, and resources

- **Zero audited context/evidence violations**, 105/105 saved-message prefix
  checks and **106/106 captured-wire prefix checks**; 130 API attempts and 129
  model decisions. The timeout has unknown HTTP status, not a successful HTTP
  response. Its deadline and subsequent recovery are recorded.
- 49 successful retrieved targets. All 23 correct answers have a matching
  observed numeric cell; this supports grounding but does not independently prove
  the requested computation. Exact final-line format passed 22/24: Qwen native
  biomedical omitted the wrapper despite an official score of 1.0; DeepSeek
  produced no answer. Scoring and formatting stay separate.
- After the fixes: **1,557 Bun tests passed, zero failed**, eight golden snapshots;
  TypeScript passed. Benchmark helpers: **59 passed, two existing platform skips**.
  An initial sandboxed suite could not bind temporary loopback servers; the
  full rerun with those permissions passed. No test failure was waived.
- Deterministic live agent/engine probes passed **10/10 before** and **10/10 after**
  the pilot, with zero LLM requests. They cover zero/one/multiple tables, isolated
  invocation state, definition replacement, stale results, partial reads after
  failure, atomic rejection, final Answer, and immutable snapshots. All resources
  were cleaned up. [Initial probe](engine-probe-summary.json),
  [post-pilot probe](post-pilot-engine-probe-summary.json).
- Termination timestamps confirm cleanup of the three campaign CUs and the probe
  CU. The local CU API hardcodes `Running` even after termination; the timestamp,
  not that status label, establishes logical cleanup. The shared local engine
  remains available. [Cleanup check](cleanup-check.json).
  Across 27 resource samples, available
  RAM stayed at least **13.49 GiB** of 48 GiB; swap stayed zero; maximum observed
  one-minute load was 7.07 on 16 logical CPUs; free disk stayed above 407.55 GiB.
  These are periodic samples, not continuous peak measurements.
  [Resource samples](host-resources.jsonl).

Raw prompts, wire messages, traces, snapshots, usage, and official evaluations
remain in `benchmark/retrieval/runs/20261008-native-markdown-layout/` (gitignored).
The saved source hash matched the launch manifest; runtime changes were made only
after the campaign completed. The initial paid launch was rejected by automatic
review and then explicitly approved by the user; only the approved 24 attempts ran.

## Size comparison and remaining work

Replaying **20 identical saved traces, 89 working iterations** gives 306,561
native / 283,696 Markdown serialized bytes: **7.46% smaller**.
[Per-trace measurements](fixed-trace-history-bytes.json). This excludes system
prompts, tools, tasks, and final answers; it is neither token nor cost measurement.
Live total tokens also include changed model decisions and error recovery.

Keep native as an explicit comparison/fallback option. Before a wider rollout,
isolate the DeepSeek provider effect with fixed routing and repeated matched
attempts, and separately verify whether the clearer array diagnostic reduces Opus
repair calls. Neither is claimed resolved by this pilot. The loop guard and array
example have deterministic driver/runtime coverage, not paid post-fix validation.

The namespace may exceed the existing soft budget rather than lose definitions;
advanced context-policy combinations remain unsupported for Markdown. The prior
all-cached dispatch shortcut remains deferred until the engine can verify cached
artifacts and external-source freshness. Normal engine caching remains active.
