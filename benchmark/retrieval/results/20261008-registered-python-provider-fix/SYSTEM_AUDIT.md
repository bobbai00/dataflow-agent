# Registered Python trace and system audit — 2026-10-08

The traces support keeping atomic edits, explicit execution, isolated invocation
namespaces, targeted cache reuse, and batched retrieval. The next work should
improve inspection, provenance, repeated-failure recovery, and saved telemetry.
This audit made no production changes, service mutations, or model requests.

## Scope and evidence

Reviewed all 24 saved attempts: the [original 18](../20261008-registered-python-pilot/REPORT.md)
and [six corrected provider reruns](REPORT.md), alongside the current source.
Findings distinguish observed defects, code-confirmed risks, and untested
contracts. The already-fixed provider regex, preview scope, and cast diagnostics
are not counted as new defects.

For execution behavior, the final diagnostic cohort comprises the original
Luna/Terra/Sol/Opus attempts plus the corrected Qwen/DeepSeek attempts: 18 tasks,
85 model calls, and 46 execute actions. Forty executes succeeded, three failed
during custom Python, and three were skipped after edit validation. Receipts
contain 87 executed operator entries and 16 cache hits. These are event counts,
not unique operators or an unbiased model-accuracy comparison.

No inspected trace demonstrated incorrect cache reuse, partial commits of a
rejected edit, or invocation-global leakage. Qwen's corrected legal steps 7, 9,
and 11 retained the same cached source through two function repairs. DeepSeek's
corrected legal step 5 repaired a footer-parsing error and reused `raw`. Qwen's
corrected archaeology step 7 computed only `top5`, reusing its three ancestors.
The small pilot does not establish these properties for every execution path.

## Recommended next patches

### 1. Make operator inspection expose the complete schema

**Trace-exposed inspection gap, confirmed by a local renderer reproduction.**
The biomedical metadata table has 179 columns.
The graph/operator summary exposes 16, sampled records expose 50, and the shown
statistics expose 27. These views do not provide reliable discovery of later
columns. `inspect operator` has the full schema internally but renders only the
abbreviated operator block. A local renderer reproduction also hid column 20 of
a completed, zero-row table whose structured output contained all 20 columns.

Keep graph summaries compact. Make selected operator inspection expose schema
independently of row retrieval, with deterministic paging/continuation when a
schema exceeds its own budget. Do not require a helper function and execution
just to discover column names.

Source: [schema truncation](../../../../agent-service/src/agent/native/observation-format.ts#L623),
[full structured inspection](../../../../agent-service/src/agent/tools/dataflow-action-runtime.ts#L511),
[Markdown rendering](../../../../agent-service/src/agent/native/action-observations.ts#L354).
Acceptance: wide and zero-row tables expose every exact column name/type through
bounded inspection; whitespace and unusual names survive rendering unchanged.

### 2. Preserve source provenance outside optional statistics

**Observed metadata loss.** In both corrected biomedical snapshots, `meta`
(153×179) and `apm` (95×34) have `sourceFingerprints: null`, with scan metadata
`sources: []` and `sourcesOmitted: 1`. The 65,536-byte profile limit removes even
the sole source record before trimming frequency dictionaries.

Retain compact source identity separately from optional per-file findings and
statistical value dictionaries. Explicitly describe missing/partial provenance.
`ResultVersion.complete` already means complete execution binding, not file
freshness; its `true` value here is not itself a correctness bug. Source identity
also does not prove that an external file has remained unchanged.

Source: [profile trimming](../../../../amber/src/main/python/core/util/table_profile.py#L551),
[fingerprint extraction](../../../../agent-service/src/agent/native/result-versions.ts#L113),
[binding semantics](../../../../agent-service/src/types/execution.ts#L35).
Acceptance: overflowing statistics preserve compact source identity; large
source lists report explicit incompleteness without invalidating valid data.

**Related observation gap:** registered custom functions skip the old process
read/event observer. Luna's legal `clean_reports` and Terra's legal `ratio` read
CSV data with pandas, but their saved `native.operations` is empty. Restore
bounded witnessed reads/events with definition-cell and line attribution across
helpers. Keep arbitrary Python lineage explicitly unknown; observing a reader
is not a complete dependency or freshness proof.
Source: [registered and legacy execution branches](../../../../agent-service/src/agent/native/python/runtime.py#L2407).

### 3. Reconnect repeated-failure protection to registered actions

**Observed failure loops; underlying provider cause already fixed.** Original
DeepSeek biomedical repeated the unknown `1` execution error 22 times. Qwen
archaeology repeated unknown `*` execution 20 times; Qwen legal repeated unknown
`r` retrieval 22 times, plus one execution failure.

The current registered path bypasses the existing `NativeValidationRepair`
tracker. Reuse and extend that mechanism for action-level failures, scoped to
the action, normalized error, graph/namespace revision, and relevant result
versions. After two or three unchanged failures, issue one concrete recovery
message with valid IDs or the applicable signature. Continued identical failure
should yield a structured stalled outcome, rather than spend the remaining
budget on the same rejected action. Do not invent a successful answer.

Changed inputs, graph definitions, or remediation must permit retry. Transient
infrastructure errors need their separate retry policy. A block that merely
returns the same error for another twenty model calls does not solve the loop.

Source: [existing tracker](../../../../agent-service/src/agent/native/validation-repair.ts#L79),
[registered path returns before legacy binding](../../../../agent-service/src/agent/texera-agent.ts#L3108),
[registered validation](../../../../agent-service/src/agent/native/registered.ts#L160).
Acceptance: synthetic repeated invalid IDs/submissions stop within a bounded
budget; edits, changed result versions, and genuine repairs reset the condition.

### 4. Bound compilation waits and preserve execution timings

**Code-confirmed cancellation risk, not an observed pilot hang.** The schema
compilation fetch has no timeout or turn abort signal, and preparation awaits it.
Pass a finite deadline and the turn signal. Propagate user cancellation; retain
the existing no-schema fallback for compiler failure/timeout while the turn is
still active.
Source: [compile request](../../../../agent-service/src/api/compile-api.ts#L45),
[awaited preparation](../../../../agent-service/src/agent/texera-agent.ts#L2106).
Acceptance: a hanging compiler cannot prevent stop from completing promptly.

**Telemetry loss.** The engine already emits `phaseMetrics`, including compilation
duration and whether runtime start was attempted. `executeWorkflowAndPersist`
drops those fields when returning its summary. Preserve them per execution,
including independent execution groups and failures. Also persist the existing
preparation/context/post-step timings, and add missing registration, transfer,
and persistence spans. Keep unavailable measurements null.
Source: [engine metrics contract](../../../../agent-service/src/types/execution.ts#L95),
[summary loses metrics](../../../../agent-service/src/agent/tools/workflow-execution-tools.ts#L797).

The final 18 attempts total 472.620 seconds of agent wall time and 315.184 seconds
of captured model/gateway latency. The 157.436-second residual (33.3%) includes
validation, orchestration, engine work, transfers, rendering, and persistence;
it cannot be labeled engine execution time.

Repeated preparation compilation is **low priority for speed**: joining all 24
attempts to local service logs gives 196 preparation records, 996 ms total
`compileMs`, 4 ms median, and 115 ms maximum. Corrected Qwen legal's 12 prepares
total only 37 ms. This field includes preparation bookkeeping; it is not the
engine execution compilation timer. The service log's `modelMs` is also not
wire-only model latency. Preserve the distinction in benchmark reporting.

### 5. Tighten observations without adding more prompt prose

- **Preserve exact extrema or label approximation.** Biomedical statistics show
  a minimum of `-2.153` while an exact value is `-2.15300777`. Float ranges silently
  round to four significant digits. A model could equality-filter on a value
  that is absent. No observed answer failed for this reason.
  [Source](../../../../agent-service/src/agent/native/evidence.ts#L1058).
- **Remove duplicate schemas in batched retrieval.** Corrected Qwen legal step
  5 prints the same schema in the operator block and result text. The older
  single-result path already has deduplication; share it with the active batched
  renderer while preserving structured metadata.
  [Source](../../../../agent-service/src/agent/native/action-observations.ts#L129).
- **Give narrowly grounded error hints.** Qwen legal's missing `Identity Theft`
  key has a whitespace-equivalent actual column, `"Identity Theft "`. The exact
  name was already visible to the model, so this was a model error, not hidden
  data. Suggest the exact quoted candidate when unambiguous; do not silently
  normalize names. Keep conversion failures' offending values and user-code
  locations. Additional raw data would not have helped: the model had already
  received all 26 rows, including the footer/null rows.
  [Source](../../../../agent-service/src/agent/native/python/runtime.py#L2413).

Acceptance: numeric bounds cannot appear exact after lossy rounding; one schema
per retrieved result; hints never reinterpret arbitrary dictionary KeyErrors or
silently change data-cleaning semantics.

## Contract to settle before mutable-source, long-running sessions

**Freshness is untested by these immutable benchmark inputs.** Cache fingerprints
cover plans/configuration, schemas, and edges, rather than current external file
contents. The exposed execute action reuses results and has no explicit refresh
choice. Custom loaders can also read external data without graph input edges.

Define whether sources are immutable for a session or can be explicitly
refreshed. An explicit refresh is useful, but must preserve historical results
and invalidate all affected descendants, including branches outside the
immediate target set. A temporary cache bypass alone can leave a later branch
using stale derived data.

Do not directly expose the existing cache-eviction endpoint as refresh: it
deletes historical result documents and port-result rows. A safe implementation
would invalidate the relevant cache index while preserving artifacts, update
current descendant result state, and execute under the workflow mutex.

Source: [cache fingerprint contract](../../../../common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/cache/FingerprintUtil.scala#L38),
[destructive eviction](../../../../amber/src/main/scala/org/apache/texera/web/service/OperatorPortCacheService.scala#L322).
First test: execute a temporary CSV and custom loader, modify the source, refresh
one branch, then execute another dependent branch. Verify the chosen freshness
contract and that historical snapshots still retrieve the old materializations.
No stale answer was observed in this pilot.

## Measurements and tests to add before broader optimization

- Keep protocol completion, official task score, supporting-result freshness,
  and configured output-format compliance separate. The original `"I"` answers
  were accepted by the protocol but incorrect. Corrected Qwen biomedical's `60`
  earned full official credit while missing the requested wrapper. Preserve one
  `answer` action; this calls for distinct audit fields, not `answer_from`.
- Track namespace cell/byte counts and validation duration. Qwen legal replaces
  one function three times; all cells are retained/replayed, and every custom
  node carries them. Preserve cell-order/default-binding semantics if optimizing.
- Each generated biomedical operator carries approximately 126.6 KB of runtime
  code. The corrected five-node Qwen workflow is 687 KB; DeepSeek's seven-node
  workflow is 961 KB. Runtime packaging/transfer deserves measurement, but these
  sizes alone do not establish a bottleneck.
- Keep statistics enabled: Qwen biomedical's retained profiling collection costs
  sum to only about 214 ms. There is no evidence here for removing statistics or
  redesigning scheduling. Likewise, keep conservative namespace invalidation
  until an independent expensive-branch test demonstrates its cost.

Use deterministic local tests for schema discovery, metadata truncation,
repeated-failure recovery, cancellation, refresh, and long-session growth before
another paid campaign. The existing synthetic engine probe and saved model
traces are sufficient to establish the small patches' starting conditions.

## Evidence locations

Raw attempts remain under the ignored directories
`benchmark/retrieval/runs/20261008-registered-python-pilot/system_scratch/` and
`benchmark/retrieval/runs/20261008-registered-python-provider-fix/system_scratch/`.
Within each model/task directory, inspect `react_steps.json` (normalize its
`steps` wrapper), `snapshot.json`, `workflow.json`, `stats.json`, and `wire/`.
The tracked campaign reports retain manifests, source hashes, metrics, and
answers. Source links above refer to this audited checkout, not a newly deployed
revision. Local preparation timings were joined by trace `messageId` against
`/tmp/texera-local-dev/logs/agent-service.log`; no credentials or raw log contents
were copied into this report.
