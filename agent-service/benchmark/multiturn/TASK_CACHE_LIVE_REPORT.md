# Running-agent cache fix: real task results

## Outcome

The isolated agent is running the cache fix. On the primary 20-task evaluation,
explicit history boundaries reduced Dataflow model cost by **18.2%**. On the
15-task real-data session plus its two fresh recovery runs, average session cost
fell **19.7%**, with the same aggregate correctness: **38/45 task instances**.

This fixes measurable prompt-processing overhead. It does **not** establish a
cost or accuracy win over ordinary CodeAgent.

## Deployed change

Service revision: `514312fbf`, branch `feat/task-history-dataflow`. The agent runs
on **3041**, authenticated LLM gateway on **29096**, and isolated engine on
**28085**. The existing private stack remains running.

- GPT-5.6+ agents using `nativeTaskContext` now call the Responses API through
  the existing authenticated gateway. Provider credentials stay in the gateway.
- The context assembler marks completed-task user messages with internal
  metadata. The adapter places cache boundaries on the fixed instructions and
  last two completed-task user messages, before the changing graph context.
  Prompt text, roles, task-qualified inputs, and engine operators are preserved.
- `nativeTaskCache` defaults to true when this path is used. Setting it false
  supplies the control on the same Responses transport. Automatic caching of
  active exchanges remains enabled in both cases.
- The adapter forwards cache options through LiteLLM and preserves the existing
  optional function arguments. It creates request-local fetch closures, avoiding
  shared mutable boundary selection between agents.
- Each agent has its own stable cache key. A live probe confirmed that the
  Responses gateway honors separate keys: the first request for each was cold,
  followed by a cache hit when that same key was reused.
- Per-step and aggregate usage now retain OpenAI cache-write counts in
  `cacheCreationInputTokens`. The benchmark prices writes as a separate input
  class, without counting those tokens twice.

Other context modes and unsupported models keep their existing transport.

## Primary comparison

Twenty tasks comprise the existing **15-task adapted LongDS GitHub session** and
**five original-membership/current-value tasks**. Same task text, files, Luna,
25-step cap, and 2,000-character output budgets. All three controlled arms use
Responses with independent cache keys. CodeAgent keeps its ordinary persistent
Python execution and memory; its adapter changes only transport and accounting.

| Primary runs | Correct | Model calls | Model cost |
| --- | ---: | ---: | ---: |
| Dataflow, implicit cache | 16/20 | 29 | $0.037671 |
| Dataflow, explicit history boundaries | 19/20 | 29 | **$0.030820** |
| Ordinary CodeAgent, Responses transport | 18/20 | 26 | $0.026961 |

The two Dataflow arms made **the same number of calls**. With boundaries, input
tokens increased slightly (207,475 → 208,366) and output tokens increased
(10,197 → 10,548), yet cost decreased. The saving comes from the cache mix:

| Input class | Implicit cache | History boundaries |
| --- | ---: | ---: |
| Cached reads | 114,912 | 147,497 |
| Cache writes | 92,476 | 60,782 |
| Other uncached input | 87 | 87 |
| Cache-read fraction | 55.4% | 70.8% |

For a concrete late-session example, both systems correctly answered real task
15 in one call. The control reused 4,256 of 11,737 input tokens; the fixed agent
reused 8,000 of 11,786. The changing graph still requires processing, but the
completed history is now reused.

Costs are repository estimates at $0.20/M ordinary input, $0.02/M cache reads,
$0.25/M cache writes, and $1.20/M output, including reasoning in output. They
exclude engine/storage cost and are not provider invoices. Scores use the
existing deterministic evaluator: exact JSON structure/order and absolute
numeric tolerance 0.0001. No LLM judge supplied success labels.

## Real-data session and recoveries

Failed primary sessions receive two fresh complete recovery runs. Primaries
remain in the table above; no retry replaces a primary failure.

| 15-task LongDS session | Primary | Recovery 1 | Recovery 2 | Average session cost |
| --- | --- | --- | --- | ---: |
| Dataflow implicit | 12/15; $0.031151 | 13/15; $0.031479 | 13/15; $0.035355 | $0.032662 |
| Dataflow boundaries | 14/15; $0.023625 | 13/15; $0.028416 | 11/15; $0.026658 | **$0.026233** |
| CodeAgent Responses | 14/15; $0.023781 | 14/15; $0.022084 | 15/15; $0.025495 | $0.023787 |

Both Dataflow arms total **38/45 correct**. CodeAgent totals **43/45**, with
average cost about **10% below the fixed Dataflow agent**. The cache improvement
is consistent in these runs; an accuracy improvement is not established.

The fixed agent's primary real-session failure uses `name` instead of the
requested `language`; the calculated values are correct. Recovery failures also
include output shape/rounding and analytical population mistakes. The cache fix
does not validate the intended answer structure or analytical formula.

For the five-task membership session, fixed Dataflow passes 5/5 at $0.007195.
The control passes 4/5 at $0.006520, then 5/5 and 4/5 in recovery. CodeAgent
Responses passes 4/5 in all three runs ($0.003180, $0.004011, $0.004538). In the
primary final task, Dataflow returns the original baseline count/value, 3/800;
CodeAgent substitutes 4/1400. The fixed input is useful here, but this case has
more Dataflow calls and does not produce a cost win. Cache availability alone
does not explain the choice of historical state.

## Ordinary Chat CodeAgent reference

An additional run using the original Chat transport scores 19/20 at a recorded
$0.020360. Its membership recoveries score 5/5 and 4/5. This is supplementary,
not the controlled comparison, for two measured reasons:

1. The Chat gateway ignores `prompt_cache_key`: a direct probe showed that a
   second, different key reused 6,000 tokens from the first key. Responses honors
   separate keys. The Chat reference can therefore benefit from shared cache
   history across runs, despite sending a unique key.
2. Chat usage omits cache-write counts. Its recorded cost excludes that premium;
   at these rates the maximum missing premium for this primary run is $0.000923.

Two initial Responses CodeAgent attempts failed in the Python SDK before any
model request because its typed method lacked `prompt_cache_key`. That transport
issue was corrected by forwarding through `extra_body`; fresh complete runs in
`cache-code` are the canonical CodeAgent results. The zero-call setup failures,
their automated retries, and the three-task development smoke are preserved
separately and excluded from the controlled primary comparison.

## Validation and artifacts

- **1,085 Bun tests passed**, plus TypeScript typecheck.
- **14 gateway tests passed**, including missing/incorrect JWT roles, the
  copilot gate, server-key injection, and request/usage forwarding.
- Live unauthenticated `/api/responses` returned **401**; authenticated real
  sessions completed through that route.
- All canonical primary campaigns and their required recovery rounds finished.
- [Machine-readable results](task-cache-live-results.json) retain separate
  primary/recovery counts, token classes, costs, errors, and artifact locations.
- Raw traces, inputs, configuration, test logs, and namespace probes are in
  `benchmark/longds/system_scratch/TaskHistoryMilestone/cache-live-artifacts.tar.gz`.
  Historical Arrow sources referenced by the traces are in
  `cache-live-retained.tar.gz` beside it. Hashes are in the results JSON.

The next cost target is the changing graph catalog, which still gets processed
on each request. Output-format and tool-repair errors remain separate accuracy
and cost problems. These results support retaining the cache fix while continuing
the comparison against CodeAgent.
