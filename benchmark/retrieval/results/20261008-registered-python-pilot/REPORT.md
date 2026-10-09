# Registered Python integration pilot — 2026-10-08

The corrected Qwen/DeepSeek validation completed **6/6 full-score passes** after
fixing a provider-dependent JSON Schema regex incompatibility. The original
campaign remains preserved: **14/18 passes**, from three unchanged KramaBench
tasks on each of six requested models. Luna, Terra, Sol, and Opus each passed
3/3 initially; Qwen improved from 0/3 to 3/3 and DeepSeek from 2/3 to 3/3 in
the separate corrected campaign. These attempts are not pooled into a model
ranking or an unbiased accuracy estimate.

The [corrected validation report](../20261008-registered-python-provider-fix/REPORT.md)
contains all six outcomes, actual providers, tokens, costs, timings, and resource
samples. Qwen's three corrected tasks and DeepSeek's biomedical task succeeded
on Wafer, the same provider affected by the original failure. No further model
runs are required for this validation scope.

## Scope and provenance

- Tasks chosen before outcomes: `archeology-easy-6` (CSV filtering/ordering),
  `legal-easy-3` (numeric parsing/ratio/rounding), `biomedical-hard-3` (workbooks
  and multiple tables). The original prompts, input files, truth, and official
  evaluator were unchanged. This small diagnostic pilot is not representative
  benchmark accuracy; one attempt per task/model gives no variance estimate.
- One `adaptive_flow1_fullstats` arm: registered Python native mode, DELTA
  context, full/sample/sample_stats retrieval, flow evidence, full-table profile
  collection, 25 model steps, 900-second per-attempt watchdog. No retries within
  the original campaign; the six corrected runs are reported separately.
- Official score is the maximum available KramaBench response metric, exactly
  as used by the existing harness; a pass requires 1.0. Pipeline grading is
  disabled. [Every original metric and final answer](attempts.json) is retained.
- [Manifest](manifest.json), [exact prompt and tools](system-info.json),
  [actual settings](settings.json), and [source inventory](source-snapshot.json)
  identify the run. The source hash covers tracked **and untracked** relevant
  implementation files. HEAD alone is insufficient for this uncommitted build.
- Agent HEAD: `e031c69dface58591da15d910e51c5aadfae5150`; primary source SHA256:
  `02f019eee82f4c1af7678664d2f30250308c7dd1af60b9290805c8f753b9d1da`.
  The local JVM distribution was freshly rebuilt before the successful engine
  probe and model campaign. Raw per-attempt prompts, tools, snapshots, traces,
  and wire bodies remain under the ignored run directory shown below.

Exact routes were checked against live provider inventories before the campaign:

| Requested model | Configured provider model | Observed route |
| --- | --- | --- |
| gpt-5.6-luna | OpenAI `gpt-5.6-luna` | OpenAI, medium effort |
| gpt-5.6-terra | OpenAI `gpt-5.6-terra` | OpenAI, medium effort |
| gpt-5.6-sol | OpenAI `gpt-5.6-sol` | OpenAI, medium effort |
| claude-opus-4.8 | Anthropic `claude-opus-4-8` | Anthropic, default effort |
| qwen3.8-27b | OpenRouter `qwen/qwen3.8-27b` | Wafer |
| deepseek-v4.1-flash | OpenRouter `deepseek/deepseek-v4.1-flash` | Together, Makora, InferenceNet, Wafer |

No model substitution was made. Gateway response model names match the requested
aliases; those aliases are not independent proof of the underlying model version.
The explicit configuration and [provider inventory](../20261008-model-inventory.json)
record the provider IDs. OpenRouter may choose a different serving provider on
each call, including within a single task.

## Original results

All 18 attempts were scored, all returned a successful `answer` action, and no
attempt timed out. A syntactically successful answer action does **not** imply a
correct answer: the affected provider routes returned the single character `I`.

| Model | Archeology | Legal | Biomedical | Passes | Failed calls / actions | Mean agent seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Luna | 1 | 1 | 1 | 3/3 | 0 / 0 | 21.49 |
| Terra | 1 | 1 | 1 | 3/3 | 1 / 1 | 21.18 |
| Sol | 1 | 1 | 1 | 3/3 | 0 / 0 | 17.86 |
| Opus 4.8 | 1 | 1 | 1 | 3/3 | 2 / 2 | 23.19 |
| Qwen 3.8 27B | 0 | 0 | 0 | 0/3 | 64 / 43 | 88.73 |
| DeepSeek V4.1 Flash | 1 | 1 | 0 | 2/3 | 24 / 25 | 24.72 |

The difference between failed calls and failed actions is intentional. A call
can fail before any action runs or contain multiple failed actions. Qwen's
biomedical attempt had **22 whole-call rejections** for duplicate single-character
IDs and zero individual failed actions. Earlier action-only accounting missed
these rejections; all original audits have been recomputed.

Successful recoveries demonstrate the execution/error loop:

- Terra initially nested operator calls inside a declaration. The atomic edit
  rejected this, and a subsequent edit used separate operator IDs; score 1.
- Opus used `preview=True` where an integer is required, then supplied the quoted
  dtype `'float64'` in `cast(columns={...})` instead of the unquoted `float64`
  descriptor. Both were rejected; it repaired the graph and obtained score 1.
  The second error exposed an adapter diagnostic containing a temporary column
  name and the old cast signature; this prompted a targeted diagnostic fix.
- DeepSeek legal initially received a one-character target from InferenceNet.
  Later Makora calls recovered. A submitted parser then tried to parse a footer
  as numeric data; the engine reported the function line and upstream failure,
  and the agent revised the function and returned the correct rounded ratio.
- Luna, Sol, and the other successful tasks demonstrate registration, zero-input
  custom loading where needed, execution, batched retrieval, and grounded answers.

## Confirmed provider compatibility failure and correction

The schema used `pattern: "\\S"` for required nonblank text. JSON Schema treats
this as a substring match, but some serving providers constrained the entire
generated string to that regex. A single nonblank character satisfied their
decoder, producing `reasoning: "I"`, `operator_ids: ["1"]`, and answer `"I"`.
Unpatterned Python and change strings remained normal. The malformed arguments
were present in the raw provider response before the local parser saw them.

Two direct calls to the same Qwen model through the same Wafer provider isolated
the cause. Both requested exactly `inspect the complete table`:

| Schema pattern | Actual generated field |
| --- | --- |
| `\S` | `I` |
| `^[\s\S]*\S[\s\S]*$` | `inspect the complete table` |

The [original](regex-diagnostic/substring.json) and
[anchored](regex-diagnostic/anchored.json) diagnostic records include the exact
request, response, provider, timing, and usage, without credentials. Their combined
provider-reported cost was $0.0003578244, separate from the 18-attempt campaign.

All 25 DeepSeek biomedical calls used Wafer and exhibited the same failure.
DeepSeek archaeology used Together and succeeded; legal switched between Makora
and InferenceNet, with the one-character output occurring on InferenceNet.
This route variation explains why the issue did not consistently affect every
DeepSeek task.

The shared nonblank pattern is now anchored as above, preserving the intended
contract while supporting full-match decoders. Focused schema tests pass. The
completed validation reran **all three original tasks on both routed models**,
with all six passing. The paired diagnostic establishes the mechanism; the
separate six-attempt campaign validates the corrected protocol end to end.
Original outcomes remain preserved. The rerun also includes namespace metadata
hardening and clearer cast diagnostics; it is not a single-change randomized
A/B experiment.

## Tokens, costs, and time

Every primary attempt has complete gateway usage: **18/18**, with **zero token
counter mismatches** against the preserved harness statistics. Cache reads and
writes are disjoint subsets of input; reasoning is already a subset of output.
No token class is charged twice. Exact billed system-prompt versus tool-schema
token splits are not returned by these APIs and are not estimated as exact.

| Model | Input | Cached input | Cache writes | Output | Reasoning | Public-rate estimate USD | Provider-reported USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Luna | 81,535 | 63,946 | 0 | 2,127 | 576 | 0.007349 | unknown |
| Terra | 116,515 | 86,242 | 0 | 2,037 | 365 | 0.102238 | unknown |
| Sol | 126,693 | 79,928 | 0 | 1,667 | 266 | 0.252371 | unknown |
| Opus 4.8 | 395,832 | 310,480 | 85,208 | 3,215 | 0 | 0.768885 | unknown |
| Qwen 3.8 27B | 592,901 | 562,560 | 0 | 9,441 | 4,983 | 0.084787 | 0.039240 |
| DeepSeek V4.1 Flash | 313,160 | 232,320 | 0 | 4,210 | 1,237 | 0.030698 | 0.031345 |

Public-rate estimates total **$1.246329** for the original 18 attempts. These
use frozen, cited standard-tier rates and per-request context thresholds;
they are not invoices. OpenRouter's `usage.cost` is preserved as a distinct
provider-reported measure and may differ because of routing prices. Missing
provider costs remain null, not zero. Evaluator, engine, and infrastructure
costs are excluded from both columns. The unchanged evaluator makes its own
scoring calls; its spend is not included in these model totals.

| Model | Mean model/gateway seconds | Mean agent seconds | Mean attempt seconds |
| --- | ---: | ---: | ---: |
| Luna | 12.78 | 21.49 | 23.96 |
| Terra | 13.34 | 21.18 | 24.09 |
| Sol | 10.30 | 17.86 | 20.48 |
| Opus 4.8 | 14.65 | 23.19 | 25.80 |
| Qwen 3.8 27B | 87.41 | 88.73 | 90.87 |
| DeepSeek V4.1 Flash | 19.87 | 24.72 | 27.07 |

Model seconds sum gateway request durations, including transport and gateway
overhead. Agent wall time includes models and tools but excludes scoring.
Attempt wall time also includes setup, scoring, and artifact collection. These
overlapping measurements must not be added together. Runs used two workers;
cross-model latency comparisons also reflect provider routing and cache state.

## Integrity, resources, and support fixes

- **Zero invariant violations** across 135 context-prefix checks and 64 retained
  profiles covering 1,438 columns. Batched retrieval audits retain successful
  entries even when another target fails. These audits cover captured context
  and retained profiles, not every possible execution path or historical row.
- Both worker computing units were terminated by the runner after completion.
  Existing unrelated Docker/Kubernetes deployments were left running.
  Validation covered the agent, authenticated model gateway, compiler, engine,
  storage, and database. Frontend startup was skipped (`--skip=frontend`); an
  existing frontend remained running, but no browser/UI validation is claimed.
  The final supported-launcher status check reported all 13 listed services
  running, including that frontend.
- Host preparation: 51.5 GB RAM, approximately 438 GB free disk, two workers.
  A [post-campaign snapshot](post-campaign-host.json) records 12.79 GB available
  memory, no swap, 438.18 GB free disk, 16 logical CPUs, and 1/5/15-minute load
  averages 9.59/6.95/6.05. This is not a peak resource measurement. The primary
  runner checked disk before launches; continuous memory/load sampling was not
  recorded. Corrected runs wrote 11 samples to `host-resources.jsonl` at
  15-second intervals: at least 13.07 GB available memory, no swap, at least
  437.99 GB free disk, and maximum observed one-minute load 4.32. These are
  sampled observations, not continuous peaks.
- Fixed launcher bugs: failed Docker startup no longer announces success or
  proceeds into schema setup; an existing JAR without a verified build stamp
  now requires rebuilding instead of being declared current. A forced rebuild
  resolved stale `SyncExecutionRequest` decoding (HTTP 400) during the engine
  probe. The deterministic engine probe then passed all 10 checks.
- Fixed reporting bugs: unknown prices remain unpriced; batch retrieval and
  registered edit reports are understood; whole-call rejections are counted;
  preserved harness usage is compared on every reconciliation; provider cost,
  cache creation, reasoning, and separate timings are exposed.
- Scoped verification: **15 benchmark/accounting tests and 46 launcher tests
  passed**; shell syntax, Python compilation, Compose rendering, and diff
  whitespace checks passed. Latest full agent-service verification: **1,446 tests
  passed, zero failed** across 123 files (9,566 assertions, 8 snapshots), with
  TypeScript typechecking green. These final checks include the implemented
  provider-schema and namespace fixes, whose six model reruns are recorded
  separately.
- After the model runs and full-suite check, documentation/display clarifications made preview scope
  explicit (per file/sheet/table and separate header metadata), documented the
  initial 1–200 preview bound, and used the public custom-operator name in flow
  labels. These are locally tested clarifications, not another model campaign;
  the exact prompts and source hashes actually used remain archived. Those final
  changes passed 94 focused tests (1,003 assertions), TypeScript typechecking,
  and four regenerated-reference/prompt checks (57 assertions).

## Reproduction

See the [benchmark setup and isolated-launcher commands](../../../README.md).
The checked-in `bin/local-dev/docker-compose.isolated.yml` supplies independent
container names, network, and project volumes. It replaces the temporary
override used during preparation; its rendered names and volumes were checked
to match. Standard host ports must be available. Set these overrides before
every launcher invocation:

```bash
export TEXERA_DOCKER_PROJECT=texera-python-pilot
export TEXERA_POSTGRES_CONTAINER=texera-python-pilot-postgres
export TEXERA_DOCKER_OVERLAY_FILE="$PWD/bin/local-dev/docker-compose.isolated.yml"
export LITELLM_BASE_URL=http://localhost:4000
export TEXERA_LLM_TRACE_DIR=/tmp/registered-python-wire
bin/local-dev.sh up --build --skip=frontend
bin/local-dev.sh status
```

The root `.env` supplies credentials without embedding them in these commands.
The build must complete before a campaign starts. Use a fresh output directory;
the runner refuses to overwrite an existing campaign.

```bash
bin/bench.sh retrieval run \
  --output benchmark/retrieval/runs/20261008-registered-python-pilot \
  --endpoint http://localhost:3001 \
  --engine-revision e031c69df-rebuilt-20261008 \
  --repetitions 1 --workers 2 --timeout 900 --direct-artifacts \
  --wire-dir /tmp/registered-python-wire \
  --tasks archeology-easy-6 legal-easy-3 biomedical-hard-3 \
  --models Luna Terra Sol Opus48 Qwen38_27B DeepSeek41Flash \
  --arms adaptive_flow1_fullstats
```

For corrected validation, the prepared command uses output suffix
`20261008-registered-python-provider-fix` and only
`--models Qwen38_27B DeepSeek41Flash`, preserving all three tasks and settings.
The user explicitly approved this OpenRouter payload and the six reruns.

Offline accounting and audit commands make no model or evaluator calls:

```bash
bin/bench.sh retrieval reconcile benchmark/retrieval/runs/20261008-registered-python-pilot
bin/bench.sh retrieval analyze benchmark/retrieval/runs/20261008-registered-python-pilot
bin/bench.sh retrieval audit benchmark/retrieval/runs/20261008-registered-python-pilot
```

Raw wire bodies contain prompt and task data. They are kept in the ignored
`benchmark/retrieval/runs/` tree and `/tmp/registered-python-wire`; HTTP headers
and credentials are not recorded. This tracked result bundle contains the
compact report, exact system prompt/tools/settings, aggregate and per-task
metrics, final answers, inventory hashes, and the two minimal regex probes.
