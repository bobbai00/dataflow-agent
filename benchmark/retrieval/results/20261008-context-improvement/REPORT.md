# Markdown iteration history — implementation validation

The implementation is complete on `feat/context-improvement`. Flat native DELTA
now defaults to one Markdown environment report per iteration. Actual paid model
comparisons have **not started**: automatic approval review rejected the launch
pending explicit user approval for the exact 24-run provider/data combination.

## Behavior

- Each report pairs decoded Python definitions and graph declarations with their
  saved outcomes: function registration/update, operator/edge changes, execution,
  retrieval, errors, and skipped actions. Source remains fenced and appears once
  per submitted edit. [Live synthetic examples](EXAMPLES.md).
- Reports read immutable request/receipt records, matched by tool-call ID. They
  do not infer success from submitted code or reinterpret current graph state as
  historical evidence. Malformed and unknown receipts retain raw repair context.
- User tasks and final answers keep their roles; intermediate reports are labeled
  environment records. The prompt still requires actual `dataflow` tool calls.
  Raw calls and receipts remain in the saved trace.
- The existing budget policy selects retained iterations/checkpoints. Checkpoints
  retain registered namespace cells in order, including unused functions, and
  preserve earned observations across verified cached executions. Changed or
  unrequested newer results never inherit earlier observations. Loaded hidden
  definitions remain hidden.
- `messageLayout: "native"` pins the prior tool transcript for controlled
  comparisons. PATCH switches the layout and prompt together; incompatible
  settings fail atomically. Advanced historical context policies retain their
  previous defaults rather than silently changing experiment semantics.

## Validation

- Full agent suite: **1,551 passed, 0 failed**, eight golden snapshots;
  TypeScript and generated native-reference checks passed.
- Benchmark helpers: **58 passed, two existing platform skips** (60 total).
- Deterministic live agent/engine probe: **10/10 checks passed**, covering zero,
  one and multiple table inputs; isolated invocation state; function replacement;
  stale-result rejection; independent reads after execution failure; atomic edit
  rejection; final Answer; and immutable saved snapshots. All owned resources
  were cleaned up. [Probe summary](engine-probe-summary.json).
- An earlier development probe passed seven checks before Bun's source watcher
  restarted the service. Its retained workflow and computing unit were removed
  only after all backend executions were confirmed terminal. The full rerun above
  passed. This interruption is not a model or engine correctness failure.

The runtime additions have regressions for embedded Markdown/backticks,
missing/ambiguous/malformed receipts, unknown actions, error visibility,
chronological requests and answers, stable prefixes, all four evidence settings,
sliding/checkpoint budgets, registered namespaces, cached materializations,
hidden loaded state, and live API setting changes.

## Offline size comparison

On **20 identical saved legal/biomedical traces, 89 working iterations**, the
reconstructed native transcript uses **306,561 serialized bytes** and Markdown
uses **283,696 bytes**, a **7.46% reduction**.
[Per-trace measurements](fixed-trace-history-bytes.json).

This compares UTF-8 JSON serialization of working-iteration history only. It
excludes system prompts, tool schemas, user tasks, and final answers, and is not
a tokenizer measurement, provider request size, or cost estimate. The Markdown
prompt contains additional format guidance. These results establish a modest
history-size reduction and a readable representation; they do not establish
accuracy, cache, latency, token, or cost improvements.

## Pending model comparison

The fixed plan is two tasks (`legal-easy-3`, `biomedical-hard-3`) × six configured
models (GPT-5.6 Luna/Terra/Sol, Claude Opus 4.8, Qwen3.8-27B,
DeepSeekV4.1-Flash) × two layouts (`layout_native`, `layout_markdown`) × one
repetition: **24 attempts**, three workers. Both arms enable statistics and flow
evidence with identical execution/retrieval limits. Task prompts, relevant data,
and system/tool context go to configured OpenAI, Anthropic, and OpenRouter
endpoints. The approval request describes this exact scope.

The supported launcher is `bin/bench.sh retrieval run`. The plan passed dry-run
validation; required local services are healthy. The runner records every
attempt, configured/returned model identities, frozen source/config hashes,
official scores, formatting and numeric-support diagnostics, model calls,
failures, exact request prefixes, input/output/cache usage, latency, costs and
host resources. Missing usage remains unknown. No outcome-selected reruns are
planned. Two tasks with one repetition support a descriptive regression pilot,
not a general accuracy claim or statistically reliable model ranking.

## Remaining limitations

The registered namespace can exceed an existing soft context budget rather than
silently lose definitions. Advanced context-policy combinations are explicitly
unsupported for Markdown. The previous audit's all-cached dispatch shortcut
remains deferred until the engine can verify cached artifacts and external-source
freshness; the normal engine cache remains active. Paid model behavior and cost
under the new history format await the approved comparison.
