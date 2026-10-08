DSBench twelve-question analysis pilot

This harness runs one independent question per session, using original
workbooks and medium reasoning. --model selects the exact gateway model ID;
the default is gpt-5.6-luna. It compares four native
Dataflow configurations with a stock smolagents CodeAgent whose custom
instructions contain the same Analysis principles. Twelve questions across
five arms produce 60 attempts. This selected analysis pilot is not a full
DSBench score and does not include its data-modeling benchmark.

Upstream: https://github.com/LiqiangJing/DSBench
GitHub revision: ba786096137a5108af11c016ad3f09cdb97beefd
Hugging Face revision: 1196d6553ec200e1262841efc89cda5954ffe89f
The modules record pinned source URLs and SHA-256 values in their artifacts.

Prerequisites

Use the repository's Python environment (uv sync --all-extras), Bun, the
initialized benchmark/Kramabench submodule, and the engine setup described
in the root README.md and docs/local-dev-with-agent.md. Linux execution
requires bubblewrap (bwrap); there is no unrestricted execution fallback.
Native runs require an owned, isolated Texera stack. smolagents uses version
1.23.0 from the repository environment and a credential-free executor
subprocess; its model client remains outside that subprocess.

Run the commands below from the repository root in Bash. Load .env into
the runner's environment without displaying its contents:

  set -a
  . ./.env
  set +a

The smol model client requires CODE_AGENT_API_KEY or LITELLM_MASTER_KEY.
The native service uses its usual authenticated gateway. The separate judge
loads .env itself; it requires the exact GPT-4o snapshot via a gateway or a
valid OPENAI_API_KEY for direct OpenAI access.

Prepare canonical public inputs

These example paths are the October 8 pilot paths. Use fresh preparation
and run directories for another experiment. Download only the small
analysis archive and metadata, then verify their pinned hashes:

  export DSBENCH_SOURCE_ROOT=/var/tmp/texera-dsbench-audit-20261008
  export DSBENCH_PREPARED_ROOT=/var/tmp/texera-dsbench-pilot-20261008
  mkdir -p "$DSBENCH_SOURCE_ROOT"
  curl --fail --location \
    https://huggingface.co/datasets/liqiang888/DSBench/resolve/1196d6553ec200e1262841efc89cda5954ffe89f/data_analysis/data.zip \
    --output "$DSBENCH_SOURCE_ROOT/analysis-data.zip"
  curl --fail --location \
    https://raw.githubusercontent.com/LiqiangJing/DSBench/ba786096137a5108af11c016ad3f09cdb97beefd/data_analysis/data.json \
    --output "$DSBENCH_SOURCE_ROOT/data-analysis-metadata.jsonl"
  .venv/bin/python benchmark/dsbench/prepare.py \
    --archive "$DSBENCH_SOURCE_ROOT/analysis-data.zip" \
    --metadata "$DSBENCH_SOURCE_ROOT/data-analysis-metadata.jsonl" \
    --output "$DSBENCH_PREPARED_ROOT"

Selection:
  00000034: questions 5, 10, 14 (retail invoice analysis)
  00000032: questions 1, 3, 4 (unstructured electricity usage)
  00000006: questions 17, 23, 25 (district voting analysis)
  00000010: questions 5, 9, 15 (league and goal analysis)

prepare.py checks actual populated workbook cells and required headers
before writing outputs. Every inputs/<challenge>-question<number>/ folder
contains exactly introduction.txt, that question<number>.txt, and its
canonical workbook. Original names, question text, and workbook bytes are
preserved. Extra questions, notebooks, CSV exports, and answer files are
excluded. The source archive includes worked notebooks, so mounting the
entire archive is invalid. Layout checks are harness metadata, not extra
instructions to the tested agent. Neither arm receives converted workbooks.

manifest.json contains relative paths, hashes, public provenance and layout
checks, without answer values. Private evaluation/gold.json has a tasks list
with task_id, challenge_id, question_id, exact question text and the original
typed answer. Its directory/file modes are 0700/0600. Preparation refuses
existing inputs, evaluation, or manifest.json. verify_prepared_dataset(root)
checks allowlists, hashes and path boundaries.

Attach the isolated runtime

The October 8 pilot used an existing stack with port offset 14000, an agent
service override at 3082, dashboard at 22080, CU-manager at 22888, CU-master
at 22085, and model gateway at 18000. Its secret-free process configuration
is recorded in <prepared-root>/runtime-env-public.json. Its existing private
service profile and storage ports must be configured before attaching; the
following exports do not provision a fresh stack or change running JVMs:

  export TEXERA_LOCAL_DEV_PORT_OFFSET=14000
  export TEXERA_AGENT_SERVICE_PORT=3082
  export TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3082
  export TEXERA_DASHBOARD_SERVICE_ENDPOINT=http://localhost:22080
  export TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:22888
  export TEXERA_LOCAL_CU_URI=http://localhost:22085
  export CODE_AGENT_API_BASE=http://localhost:18000/v1
  export NATIVE_WORKSPACE=/var/tmp/texera-single-task-final/native-workspaces
  export NATIVE_SOURCE_DATA="$PWD/benchmark/Kramabench/data"
  export NATIVE_ISOLATED_PYTHON="$PWD/.venv/bin/python"
  export UDF_PYTHON_PATH="$PWD/benchmark/retrieval/native_isolated_python.py"
  export MODEL_MAX_OUTPUT_TOKENS=8192
  export MODEL_SDK_RETRIES=0
  export TEXERA_LLM_TRACE_DIR=/var/tmp/texera-single-task-final/wire

The engine's CU-master must have inherited the isolation variables when
started, and the agent service must use the same wrapper and model limits.
Use bin/local-dev.sh for service lifecycle; on an already configured owned
stack, bin/local-dev.sh up agent-service reloads the agent with these exports.
Setting variables only in the benchmark runner cannot isolate a previously
started engine. Keep the supervised launcher session alive during runs.

Copy only the public inputs into the engine's existing data tree, before
the first pilot run:

  mkdir "$NATIVE_SOURCE_DATA/dsbench" && \
    cp -a "$DSBENCH_PREPARED_ROOT/inputs/." "$NATIVE_SOURCE_DATA/dsbench/"

The runner verifies each mounted file hash and writes a per-workflow
task-inputs.json mapping. The native wrapper exposes only the current task
directory read-only at data/dsbench/<task-id>, hiding sibling questions and
evaluation files. smol receives copies of the same three files read-only
inside its executor, with networking off. Native workers retain networking
for engine result storage. Keep gold, judge inputs, caches and reports
outside all input mounts; permissions alone do not provide that separation.

Run the deterministic engine preflight before any model attempts:

  export DSBENCH_PREFLIGHT_ARTIFACT_DIR="$DSBENCH_PREPARED_ROOT/preflight"
  bun benchmark/dsbench/preflight.ts

Use a fresh artifact directory for another preflight. This script calls no
model: it checks all four workbook layouts, full row counts and profile
coverage, absence of gold/notebooks/sibling inputs, and safe resource cleanup.
Leave DSBENCH_PREFLIGHT_ALL_TEXT unset for the default Excel scan path.
The native Excel fix preserves timezone-free date and time cells as ISO
strings for engine transport. It retains numeric inference and nulls, and
does not change source bytes, all_text formatting or Process timestamp rules.

Run native and custom smol arms

  export DSBENCH_RUN_ROOT="$DSBENCH_PREPARED_ROOT/runs"
  DSBENCH_TASK_IDS=(
    00000034-question5 00000034-question10 00000034-question14
    00000032-question1 00000032-question3 00000032-question4
    00000006-question17 00000006-question23 00000006-question25
    00000010-question5 00000010-question9 00000010-question15
  )
  DSBENCH_PRINCIPLES=benchmark/Kramabench/judgment_runs/single_task_prompt_subset_20261008/shared-principles.txt

Validate settings and public inputs without calling a model:

  .venv/bin/python benchmark/dsbench/run.py \
    --prepared-root "$DSBENCH_PREPARED_ROOT" \
    --output-root "$DSBENCH_RUN_ROOT" \
    --arm data0_flow0 --task-ids "${DSBENCH_TASK_IDS[@]}" \
    --shared-principles "$DSBENCH_PRINCIPLES" --dry-run

Run the five arms serially, one attempt per question:

  for dsbench_arm in data0_flow0 data1_flow0 data0_flow1 data1_flow1 smol_custom
  do
    .venv/bin/python benchmark/dsbench/run.py \
      --prepared-root "$DSBENCH_PREPARED_ROOT" \
      --output-root "$DSBENCH_RUN_ROOT" \
      --arm "$dsbench_arm" --task-ids "${DSBENCH_TASK_IDS[@]}" \
      --endpoint "$TEXERA_AGENT_SERVICE_ENDPOINT" \
      --script-endpoint "$CODE_AGENT_API_BASE" \
      --shared-principles "$DSBENCH_PRINCIPLES" || break
  done

Arm             Data statistics   Flow metadata   Retrieval choices
data0_flow0     off               off             sample, full
data1_flow0     on                off             sample_stats, full
data0_flow1     off               on              sample, full
data1_flow1     on                on              sample_stats, full
smol_custom    stock Python execution + shared Analysis principles

Native profile collection stays on in every arm; exposure of statistics and
flow metadata changes independently. The native runner asserts the actual
settings, retrieval enum and one matching principles block before the task.
smol appends that same block through CodeAgent instructions and saves its
rendered prompt. Both receive identical introductions, question text and
file lists; their final-answer instructions match their respective tools.

Each task uses a fresh native workflow/CU/agent or fresh smol executor. Both
have a 25-step budget, 8192 model output-token cap, 900-second task limit and
zero model SDK retries. Native samples allow five rows and 2000 characters;
full retrieval and smol printed output allow 5000 characters. Each enabled
native evidence kind has a separate 2000-character budget. There is no
automatic whole-task retry. Existing attempt directories are never replaced.
Provider-blocked or prompt-integrity failures stop that arm's runner.

Artifacts land at runs/system_scratch/<arm>/<task-id>/: prompt.txt,
response.txt, answer.json, config.json, settings.json, system-info.json,
stats.json, status.json and cleanup records. Native adds turn, workflow,
snapshot, operator results and ReAct traces; smol adds memory/reasoning,
execution and model request/response traces. The final prediction is kept
verbatim; infrastructure status and usage completeness are separate fields.
Agent costs use the shared model pricing helper and recorded token usage,
including cache usage. Incomplete native traces yield unknown cost; failed
requests without returned usage cannot be priced from successful-call totals.

Repeat the same pilot with Terra and Sol

The model IDs for the repeat are gpt-5.6-terra and gpt-5.6-sol. Both native
gateway aliases must be configured for medium reasoning; smol sends medium
explicitly. Keep the same input preparation, shared principles, limits and
five arms. Use a separate output root for each model: existing attempts are
never overwritten and final reports reject mixed models.

--pricing-json supplies a frozen model price_schedule when the shared helper
has no entry or when an experiment needs explicit documented rates. The
schedule records model, source, version=1, kind=token_estimate, currency=USD,
unit=per_token, input_includes_cached=true, output_includes_reasoning=true,
and rates for input, output, cache_read and cache_creation. Its model must
match --model exactly; all four rates must be finite nonnegative numbers.
Validation happens before attempts, and the full schedule is saved in every
config.json and stats.json. An unknown model without a schedule fails before
a worker starts. A zero creation rate is valid for providers without that
charge; boolean, missing, negative and nonfinite rates are rejected.

The October 8 repeat uses verified schedules at
<comparison-root>/terra/pricing.json and <comparison-root>/sol/pricing.json.
After attaching the owned runtime and defining DSBENCH_TASK_IDS and
DSBENCH_PRINCIPLES above, the complete two-model repeat is:

  export DSBENCH_COMPARISON_ROOT=/var/tmp/texera-dsbench-terra-sol-pilot-20261008/valid
  for dsbench_model in gpt-5.6-terra gpt-5.6-sol
  do
    dsbench_name=${dsbench_model#gpt-5.6-}
    for dsbench_arm in data0_flow0 data1_flow0 data0_flow1 data1_flow1 smol_custom
    do
      .venv/bin/python benchmark/dsbench/run.py \
        --prepared-root "$DSBENCH_PREPARED_ROOT" \
        --output-root "$DSBENCH_COMPARISON_ROOT/$dsbench_name/runs" \
        --model "$dsbench_model" \
        --pricing-json "$DSBENCH_COMPARISON_ROOT/$dsbench_name/pricing.json" \
        --arm "$dsbench_arm" --task-ids "${DSBENCH_TASK_IDS[@]}" \
        --endpoint "$TEXERA_AGENT_SERVICE_ENDPOINT" \
        --script-endpoint "$CODE_AGENT_API_BASE" \
        --shared-principles "$DSBENCH_PRINCIPLES" || break 2
    done
  done

Add --dry-run to validate a chosen model's protocol without any calls. Each
model repeats the same 60 attempts. The original Luna output remains an
independent comparison run. Reports record agent_model and the model for
each arm and attempt, with matching per-model pricing. Official grading
uses the unchanged GPT-4o snapshot for every agent model. Identical official
requests can share a cache across models; deduplicate cache keys when adding
the total judge bill across several model reports.

Official analysis grading

After attempts have status.json, assemble private judge inputs from exact
question/gold values and raw response.txt, including empty or failed answers:

  .venv/bin/python benchmark/dsbench/report.py \
    --prepared-root "$DSBENCH_PREPARED_ROOT" \
    --output-root "$DSBENCH_RUN_ROOT" \
    --judge-inputs "$DSBENCH_PREPARED_ROOT/evaluation/judge-inputs.jsonl"
  .venv/bin/python benchmark/dsbench/judge.py \
    --input "$DSBENCH_PREPARED_ROOT/evaluation/judge-inputs.jsonl" \
    --output "$DSBENCH_PREPARED_ROOT/evaluation/grades.jsonl" \
    --cache-dir "$DSBENCH_PREPARED_ROOT/evaluation/judge-cache"

The judge preserves the evaluator at:
https://github.com/LiqiangJing/DSBench/blob/ba786096137a5108af11c016ad3f09cdb97beefd/data_analysis/compute_answer.py
It sends the exact prompt (including "Flase") to gpt-4o-2024-05-13, with
temperature=0, top_p=1, max_tokens=256 and both penalties=0. Its official
verdict is the upstream case-insensitive True-substring rule. Request or
response parsing exceptions produce official False and a separate error.
No model alias is substituted. --endpoint can select a gateway advertising
the exact snapshot; otherwise read-only inventory checks select a configured
gateway or direct OpenAI. The wrapper freezes zero retries and a 90-second
request timeout, and records actual response model, request and usage.

Identical question/answer/prediction requests across arms or later waves
reuse one cached official verdict. Cache keys include request parameters,
upstream revision and transport policy. Completed failures are cached too;
an interrupted pending request is reported separately without resending it.
Rebuilding judge inputs and rerunning these commands is safe with the same
cache. It cannot silently rerun a failed judgment.

grades.jsonl retains task/arm identity and official labels; its companion
grades.jsonl.summary.json records calls, cache hits, failures and cost.
Original estimated cost is retained on a cache hit; incremental cost is zero.
Use unique cached request records or the sum of new-call costs across waves
for total judge cost, rather than a final cached wave's incremental total.
Report this separately from per-arm agent costs and report judge failures
separately without changing official labels. An MCQ letter checker, if used,
is a separate diagnostic and never replaces official judging.

Once all 60 attempts are represented in grades.jsonl, aggregate the arm
scores, agent usage/cost and experiment-wide judge cost:

  .venv/bin/python benchmark/dsbench/report.py \
    --prepared-root "$DSBENCH_PREPARED_ROOT" \
    --output-root "$DSBENCH_RUN_ROOT" \
    --grades "$DSBENCH_PREPARED_ROOT/evaluation/grades.jsonl" \
    --cache-dir "$DSBENCH_PREPARED_ROOT/evaluation/judge-cache" \
    --report "$DSBENCH_PREPARED_ROOT/evaluation/pilot-report.json"

Final aggregation requires each declared task/arm exactly once and complete
agent and judge cost records. It binds grades and completed cache records to
the exact current gold and raw prediction, checking requests, cache keys,
official verdicts and error fields. Pending cache files are excluded. It
counts original costs from unique cached judge records
to retain the full grading bill after later waves reuse those judgments.
Compute costs are excluded. Keep partial waves separate from a final report.

The recorded standard price for this exact May 2024 snapshot is $5 per
million input tokens and $15 per million output tokens, verified October 8,
2026 at https://developers.openai.com/api/docs/pricing.md. No cached-input
discount is published for that snapshot; reported cached tokens remain part
of input cost. This differs from the floating gpt-4o alias's price. Reasoning
tokens, when present, are already included in output tokens. These are token
cost estimates; failed calls without returned usage have unknown cost.

Offline checks

  .venv/bin/python -m pytest -q benchmark/dsbench/test_prepare.py \
    benchmark/dsbench/test_run.py benchmark/dsbench/test_judge.py \
    benchmark/dsbench/test_report.py benchmark/dsbench/test_model_selection.py
  .venv/bin/python -m pytest -q benchmark/retrieval/test_execution_isolation.py
  .venv/bin/ruff check benchmark/dsbench
  .venv/bin/black --check benchmark/dsbench
  cd agent-service
  bun test
  bun run typecheck

These tests do not call models or judges. The judge regression test compares
the exact request hash captured from the pinned upstream evaluator and tests
its unchanged verdict rule, errors, cache behavior and incremental accounting.
