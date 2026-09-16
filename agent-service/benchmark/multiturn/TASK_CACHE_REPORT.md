# Task context: prompt-cache diagnosis

## Conclusion

There is a concrete fix for a substantial part of the cache loss: explicitly
cache the stable completed-task history before the changing graph context.
Real GPT-5.6 Luna probes through the private LiteLLM gateway confirmed this.
The production agent has **not** been migrated to this request format yet.
This report measures prompt reuse, not analytical accuracy or a new CodeAgent win.

## Why the stable history did not cache

The task context already places immutable prior requests and final answers
before the current graph. However, the previous request's automatically saved
cache boundary comes after that graph and its active request/tool results.
On the next task, the graph changes and the old action trajectory is compacted
away. A matching prefix exists, but its endpoint was not separately saved.

OpenAI's current documentation describes this behavior for GPT-5.6 and later:
cache writes occur at selected message/content boundaries. Preserving identical
text before a rewritten suffix is insufficient without a saved boundary there.
The API supports explicit breakpoints on input content blocks.
[Official prompt-caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching).

The tested layout is:

```text
Fixed instructions and tools
Completed task 1: user request / final answer
...
Completed task N-2: user request [cache boundary] / final answer
Completed task N-1: user request [cache boundary] / final answer
Current graph catalog and selected definitions
Current task and its tool exchanges
```

These are API metadata, not extra text, operators, model calls, or user-visible
state identifiers. The previous boundary remains present when another completed
task is appended, so the provider can find the prefix saved on the prior call.
Markers on assistant output blocks did not improve reuse in the exploratory
probe; the working experiment marks completed user-message input blocks.

## Controlled measurement

The replay uses recorded first-call contexts for tasks 14 and 15 from the
primary LongDS GitHub session at service revision `f6d70360a`. Every arm uses the
same frozen system prompt and dataflow schema. Auxiliary production tools are
omitted identically. Tool execution is disabled, the output cap is 128 tokens,
and each request asks only for `OK`. Every measured response contains `OK`
and uses five output tokens, with medium reasoning configured by the gateway.

Each arm starts with a different fixed-length numeric prefix to avoid warming
another arm's history. Both repetitions run task 14 then 15; the second reverses
arm order. All arms have exactly the same input token counts. Task 14 starts
cold; task 15 measures reuse after the graph/history changes.

| Task 15, both repetitions | Implicit only | Explicit history boundaries + implicit |
| --- | ---: | ---: |
| Input tokens | 11,312 | 11,312 |
| Cached input | 3,929 (34.7%) | 7,626 (67.4%) |
| Cache-write input | 7,308 | 3,611 |
| Other uncached input | 75 | 75 |
| Estimated input cost | $0.00192058 | $0.00107027 |

For this follow-up request, explicit history boundaries halve the input that
must be processed again and reduce estimated input cost by **44.3%**. Including
the cold task-14 request, the two-request input saving is **18.4%**. These are
cache-probe results; neither percentage is an end-to-end benchmark saving.

The cost calculation uses the milestone's accounting assumptions of $0.20/M
uncached input and $0.02/M cached input, plus the documented 1.25x cache-write
multiplier ($0.25/M). The three input classes are mutually exclusive. Provider
invoices and engine costs are outside this measurement.

## What the gateway tests established

- Identical Chat Completions requests cache. Changing the last question or graph
  loses history reuse even when the earlier messages are identical.
- Adding the new cache fields to the existing Chat Completions request had no
  effect. HTTP success alone did not establish that the marker was applied.
- Responses API requests through the private LiteLLM endpoint did honor
  `prompt_cache_breakpoint` on user input blocks and reported cache-write tokens.
- The installed LiteLLM path drops the new top-level `prompt_cache_options`
  parameter. Placing it in `extra_body` forwards it correctly; the returned
  effective mode verifies this. An exploratory explicit-only arm sent without
  that forwarding still ran in implicit mode and is not evidence for
  explicit-only behavior.
- With correct forwarding, explicit-only mode avoids writing the changing
  suffix. It needs a full agent comparison before choosing it over the safer
  policy that preserves automatic caching of active tool exchanges.

The correctly forwarded explicit-only policy produced 7,626 cache reads,
544 cache-write tokens, and 3,142 other uncached tokens on task 15 in both
repetitions. Its estimated input cost was $0.00091692: **52.3%** below implicit
only on that request, or **25.1%** below across the cold/follow-up pair. This
additional saving depends on avoiding writes that later calls would not reuse.

The old Chat Completions usage did not expose the cache-write counts seen in
these Responses probes. The original milestone cost table remains the original
repository estimate, not a corrected invoice. Future comparisons must collect
and price cache writes for both systems.

## Production change to make next

1. Add an authenticated Responses route to the existing gateway, preserving the
   current JWT and server-owned provider-key boundary. The current access-control
   proxy only serves the Chat Completions path.
2. Carry explicit boundary metadata through the agent's OpenAI adapter. The
   installed AI SDK does not currently serialize these fields. Mark the last two
   completed-task user messages; preserve their content and roles. Keep the
   changing graph after the history. Start with implicit mode plus these marks.
3. Capture `usage.input_tokens_details.cache_write_tokens` and validate the
   effective cache mode. Smoke-test actual tool calls and replay the matched
   analytical sessions with complete cost accounting for both arms.

This is an LLM request/context fix. It does not require changing engine result
retention, native operators, UDF semantics, or the public task-qualified input
API. It also does not address extra interface-repair calls or calculation
errors. Full-session measurements are still needed to establish a cost win.

## Artifacts and reproduction

- [Replay script](replay-task-cache.py)
- [Measured usage](task-cache-results.json)
- Local raw requests, responses, and exploratory probes:
  `benchmark/longds/system_scratch/TaskHistoryMilestone/cache-diagnosis.tar.gz`
- Frozen source contexts: the original milestone's `artifacts.tar.gz` in the
  same directory, under `v3-holdout/tasks-longds_github`.

With the private profile and credentials loaded into the environment:

```bash
python agent-service/benchmark/multiturn/replay-task-cache.py \
  --trace-root /tmp/texera-task-history/v3-holdout/tasks-longds_github \
  --template /tmp/texera-task-history/cache-probe-input.json \
  --tasks 14 15 --repeats 2 \
  --output /tmp/task-cache-replay-new
```

The output directory must be new. The script saves request/response bodies and
usage; credentials remain in HTTP headers and are never written to artifacts.
