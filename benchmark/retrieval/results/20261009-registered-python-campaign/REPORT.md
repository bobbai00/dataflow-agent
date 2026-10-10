# Registered-Python dataflow agent vs smolagents on KramaBench — 2026-10-09

One repetition of all 104 KramaBench tasks per cell. Dataflow agent at campaign revision
e8bd686e3 (`campaign/registered-python-20261009`), four evidence arms (none / stats / flow /
both), full-result cap 5,000 characters, sample budget 1,000, 25 model calls, 900 s wall clock
(1,800 s on the OpenRouter routes). smolagents `CodeAgent` with the KramaBench custom
instructions, 5,000-character output cap, 1,200 s wall clock (timeouts rerun at 1,800 s). Same
task text except the final-answer instruction; same official evaluator.

Accuracy = passes / 104 attempted (timeouts and unscored attempts are failures). Cost = frozen
public-rate token estimate per task; attempts with a call cut off (gateway deadline or wall
clock) are priced at their completed calls, as smolagents' killed attempts are (the runner's
`cost_usd` leaves them unknown, which had understated DeepSeek by 20%).

## Result

| Model | Dataflow: none / stats / flow / both | smolagents | Δ pts | $/task dataflow | $/task smolagents |
|---|---|---|---|---|---|
| GPT-5.6 Luna | 62.5 / 62.5 / 59.6 / 63.5 | 54.8 | +4.8 … +8.7 | 0.0038–0.0042 | 0.0040 |
| GPT-5.6 Terra | 68.3 / 63.5 / 67.3 / 71.2 | 60.6 | +2.9 … +10.6 | 0.034–0.036 | 0.058 |
| Claude Opus 4.8 | 68.3 / 74.0 / 73.1 / 69.2 | 70.2 | −1.9 … +3.8 | 0.17–0.19 | 0.087 |
| DeepSeek V4.1 Flash | 70.2 / 69.2 / 73.1 / 73.1 | 68.3 | +1.0 … +4.8 | 0.020–0.021 | 0.0145 |
| Qwen 3.8 27B (all attempts) | 47.1 / 49.0 / 41.3 / 54.8 | 69.2 | −14 … −28 | 0.047–0.069 | 0.047 |
| Qwen 3.8 27B (started before 10:00) | 55.0 / 55.7 / 54.1 / 56.8 | 67–71 same tasks | −12 … −14 | | |


- Luna, Terra: the dataflow agent wins in every arm, at equal cost (Luna) or 60% of it (Terra).
- Opus: parity at 2.0–2.2× cost. First call 11.9k input tokens vs 5.1k; +1.28k per call vs
  +0.59k; output 2.4k vs 1.2k per task. Cost splits evenly: cache reads, cache writes, output.
- DeepSeek: slightly better at 1.4× cost.
- Qwen: worse. DeepInfra's Qwen throughput fell from ~67 to 13–21 tok/s after 10:00 local;
  attempts started after that lost 16–28 per arm to provider timeouts. Before 10:00 the gap is
  12–14 points.
- Evidence arms: no consistent winner (one rep; Luna sd ≈ 3 points per run).

## Why Qwen loses (before the slowdown)

1. No retry after a slow call: the profile sets `MODEL_RETRIES_PER_TURN=0` and the gateway caps
   a call at 180 s (`LLMProxyRequest.MaxDurationMillis`); smolagents' OpenAI client waits 600 s and
   retries twice. 5–9 attempts per arm ended at the first cut call.
2. Runaway generation on DeepInfra: 5% of calls generate ~8,192 tokens and return one tool call
   (21% of Qwen's billed cost). Random; a stop string after the tool call does not prevent it.
3. 72 of 315 answers lack the requested `Final Answer:` line (prose, or values cut: "S" for São
   Paulo, "27 states had " for 27). Terra never; Luna 2 of 869.

## Luna variants (both arm)

Caps: 63.5% (5k/1k) · 64.4% (100k/1k) · 65.4% (5k/2k) · 66.3% (100k/2k). Samples-first prompt
(follow-up branch): 70/104 = 67.3% at 7% lower cost.

## Telemetry

Median wall time per task (both arm): Luna 34 s, Terra 29 s, Opus 42 s, DeepSeek 121 s,
Qwen 235 s; engine + agent overhead 13–23 s for every model; model calls 4 s each on
Luna/Terra/Opus vs 15–25 s on OpenRouter. Host: 31.1 GiB RAM, median 16.2 GiB free, lowest
0.6 GiB (a model-written loader at 15.7 GB, killed), swap up to 17.8 GiB, load ≤ 10 of 24 CPUs.

## Fixes

On the campaign branch: repeated-failure loop guard, accepted spellings, `UDF_PYTHON_ALLOW_FILE_IO`,
pinned providers, caps. On `feat/registered-followups` (dfc02bbe8) and
`feat/registered-followups-seq` (14680bb83, not merged): rejected edits name unregistered
functions; samples-first prompt; duplicate tool calls collapse; distinct calls in one response
run in order; answers without the requested marker line are returned. The Qwen confirmation of
these (with two retries per turn) stopped at 14/104 when the provider slowed down: inconclusive.

## Exclusions

Contaminated before the UDF flag and rerun: Luna astronomy-easy-1, astronomy-hard-8; Terra
environment-hard-9. Killed for memory: Luna basecaps wildfire-hard-19; DeepSeek none
wildfire-hard-21 (counted as failures).
