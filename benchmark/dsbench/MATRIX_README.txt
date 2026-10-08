Matched original-input matrix

The generalized entry point is benchmark/experiment_matrix.py. It declares
5 KramaBench tasks and 5 DSBench tasks for each of the six exact requested
models, crossed with smol_custom, bob_data, bob_flow and bob_both: 240 attempts.
Selection covers input formats and documented failure mechanisms. It is a
diagnostic sample, not a full-benchmark accuracy estimate.

Preparation makes no model calls. Freeze only after the served agent is
restarted at the final source and owned resource inventories are current:

  .venv/bin/python benchmark/experiment_matrix.py prepare \
    --output /var/tmp/texera-single-task-final/campaign-matrix-v1 \
    --model-facts /var/tmp/texera-single-task-final/campaign-preflight-v3/model-facts.json \
    --ds-prepared-root /var/tmp/texera-dsbench-pilot-20261008 \
    --owned-services /var/tmp/texera-single-task-final/owned-services.json \
    --component-scopes /var/tmp/texera-single-task-final/runtime-components-v3.json

Add --dry-run to validate without freezing or staging. Model facts must include
boolean provider access and exact native/provider routes. Unavailable models
remain declared and receive preflight-blocked rows with zero launched requests.
There is no model substitution. Arbitrary exact models can be supplied through
the same facts format and optional --models selection.

Model capabilities select structured-output transport explicitly. Sonnet 5.5
uses auto_tool because its provider rejects forced tool choice: the unchanged
CodeAgent thought/code schema is sent as one automatically selected tool, and
validated arguments are restored to the structured content CodeAgent expects.
Other models retain response_format. Actual requests, raw tool responses and
separate adaptation events are preserved; missing or invalid tool output fails
the attempt without a model substitution or an unrecorded retry.

KB preparation copies only original selected files, byte-for-byte, beneath
NATIVE_SOURCE_DATA/matrix_inputs, retaining basenames and nested names. Both
executors see the same logical read-only paths. Existing DSBench mounts are
verified against the three original public input files. Private reference
answers and scorer artifacts remain outside every agent input mount.

The frozen manifest includes task hashes, prompts and shared principles,
settings, provider facts, price schedules, source revisions, source hashes,
dependency lockfiles, gateway config and the resource inventory. Each native
attempt checks startup source fingerprints and owned agent-service PID before
inference. Current prompts, context settings and evidence settings are retained.

Execution is a separate paid command, after infrastructure checks:

  .venv/bin/python benchmark/experiment_matrix.py run \
    --output /var/tmp/texera-single-task-final/campaign-matrix-v1

Execution is serial and protected by an exclusive runner lock. A PAUSE file
stops new launches. Re-running resumes never-started identities only. Existing
failed, interrupted, blocked and completed attempts are immutable; failures are
never erased or silently retried. The optional --limit bounds new launches.

Raw native traces, workflow/result snapshots, transport accounting, durable
journals, script request/response traces and executions are retained alongside
normalized metrics. accounting/ contains the shared runtime schema and one
record for every actual request, including SDK retries and failed calls.
Unknown tokens or billing remain null; observed successful usage and known
costs remain separately available. Cache writes are a separate token subclass
for new runs. Existing historical protocols and reports remain unchanged.
Provider-reported usage.cost and frozen token-price estimates remain distinct.

Both systems measure monotonic wall from supervisor measurement setup through
child exit and resource finalization. The interval includes the child setup,
solve, artifact capture and cleanup phases. Harness group allocation, later
accounting normalization and official grading are outside this interval. CPU includes all
owned child processes and the declared native service scope. Full native scope
must include the owned storage services when they are part of the SUT. A common
gateway is measured separately and identically for both arms. Script cgroups
use a sibling parent outside the native group and are removed only when empty.
Individual verified cgroups provide exact CPU deltas and kernel memory peaks.
If multiple disjoint groups are needed, combined CPU is additive; combined
simultaneous memory is sampled and explicitly approximate. Component memory
peaks are never added to claim a total peak. Missing coverage fails preflight
when require_complete_resources is set, before tested inference begins.

Official grading is separate and benchmark-specific:

  .venv/bin/python benchmark/matrix_judge.py \
    --output /var/tmp/texera-single-task-final/campaign-matrix-v1 \
    --cache-dir /var/tmp/texera-single-task-final/campaign-matrix-v1/judge-cache

DSBench retains its exact official GPT-4o snapshot, prompt and original verdict
rule. The cache preserves identical requests and failed/interrupted judgments.
Snapshot preflight failures remain unscored. KB uses the unchanged original
Evaluator and original answer parsers in its existing benchmark environment;
--scorer-python selects that interpreter. Official evaluations and conservative
diagnostic labels are separate artifacts. Diagnostic labels never replace an
official score. Judge token cost is reported separately from tested-agent cost.

Read-only reporting:

  .venv/bin/python benchmark/experiment_matrix.py report \
    --output /var/tmp/texera-single-task-final/campaign-matrix-v1 \
    --report /var/tmp/texera-single-task-final/campaign-matrix-v1/report.json

Every declared identity appears, including not-started and unscored attempts.
Summaries retain known versus complete costs/tokens and measurement coverage.
Wall sums are serial task totals, not campaign duration. Peak-memory means and
maxima describe per-attempt peaks; sums do not represent a campaign peak.

Original retrieval launchers also use the shared supervisor. run_baselines.py
and run_comparison.py accept --resource-scope and optional --model-facts, retain
their existing named defaults, and accept arbitrary exact gateway IDs. Owned
shared scopes require --workers 1. Their original evaluator executes inside the
adapter process, so the wider wall/resource boundary explicitly includes
official grading and is not interchangeable with matrix agent-only metrics.
Native serve_query phase timing and request ledgers exclude evaluator requests.

Measurement metadata and model capabilities

CPU total is a kernel scheduler-time delta over the declared owned scope. On
cgroup v1, cpuacct.stat user/system values use independent kernel tick accounting;
their sum can differ from cpuacct.usage total. Per-field counter sources and
user_system_exact distinguish this from scope coverage. The v1 values are
preserved, rather than adjusted to force equality. Kernel charged-memory peaks
include page cache and the native service baseline. Native service startup
precedes timed attempts; script controllers start fresh for each attempt.

clocks.measured_interval records the monotonic measurement boundary and, for new
supervised attempts, UTC observations taken beside the monotonic timer calls.
Receipt constructed_at/finalized_at describe accounting construction. Legacy
started_at/finished_at are retained with explicit receipt semantics; they are
not used to infer execution time. Older UTC execution intervals remain unknown.

The native create API accepts modelCapabilities.forcedToolChoice as an optional
boolean. An explicit value overrides the registered default, including for an
arbitrary gateway model ID. Native benchmark adapters forward the corresponding
model-fact forced_tool_choice field. Existing callers can omit capabilities.
This controls transport while preserving the native Answer contract.

Native generation parameters come from the gateway model profile. The separate
native-generation-provenance.json records the exact route, requested fact
parameters and the absence of native API generation parameter overrides. A
model-fact model_parameters object does not itself override the native gateway
profile. Script adapters forward their configured supported generation parameters.

Structured-output failures retain provider finish_reason/refusal metadata
separately from schema-validation errors. Filtered or refused partial output is
rejected before execution. Safe native ledger metadata contains flags and lengths,
not message or refusal text. HTTP request success, usable model output, completed
agent actions and official correctness remain separate measurements.

Model request deadlines

New DS and matrix runs accept --model-request-timeout-seconds (default 240),
record the value in the manifest and enforce an elapsed deadline for each model
call. Native modelRequestTimeoutMs spans fetch and response-body reading. The
script worker uses a watchdog thread and a dedicated Linux real-time signal
targeted only at the main thread, alongside HTTPX phase timeouts with the same
numeric limit. The guard checks kernel signal dispositions before reservation,
cancels and joins its watchdog, drains pending delivery and restores its owned
handler and mask on exit. The parent SIGALRM handler and task timer are untouched;
earlier task deadlines still win. Unsupported or conflicting script contexts
fail before inference. model-request-timeout.json records requested and resolved
values and enforcement method. model-request-deadlines.jsonl records per-call
watchdog signal/target provenance separately from raw provider request events.

Existing native API callers that omit the override retain the captured
environment/default timeout (180 seconds by default). The original frozen
campaign used native absolute 180-second deadlines and script 240-second HTTPX
inactivity timeouts. Its historical metrics retain those different semantics;
they are not backfilled from the updated enforcement code.

maxSteps limits the agent decision loop; it is not an independent cap on actual
model requests. CodeAgent can issue an additional finalizer request. The request
journal counts every dispatched request, including failed calls and finalizers.
