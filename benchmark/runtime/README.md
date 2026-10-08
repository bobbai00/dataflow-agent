<!--
Licensed to the Apache Software Foundation (ASF) under one or more
contributor license agreements. See the NOTICE file distributed with
this work for additional information regarding copyright ownership.
The ASF licenses this file to You under the Apache License, Version 2.0
(the "License"); you may not use this file except in compliance with
the License. You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Shared benchmark runtime

This package measures immutable attempts for KramaBench, DSBench, LongDS and
script/smolagents baselines. Historical stats and pricing protocols remain
historical artifacts. New adapters write `metrics.json` beside them, using
schema version 1 and a frozen pricing snapshot.

## Attempt accounting

`AttemptMetrics(attempt_id, benchmark=..., system=..., task_id=..., manifest=...)`
records monotonic lifecycle phase clocks, every dispatched model request and
a resource result. Use `lifecycle_clock("execution")` around the same lifecycle
window in each arm; setup, scoring and postprocessing have separate phase names.

`record_usage(response, provider=..., model=..., pricing=..., status=...)`
retains the raw response in an exclusive numbered `model_calls/*.json` artifact.
A failed request with absent usage is unknown, even if earlier requests succeeded.
A genuine zero must be returned explicitly. Normalized totals include cache
subclasses in input and reasoning subclasses in output; reasoning is not added
to OpenAI output twice. Native Anthropic input excludes cache classes, so those
are added once. Gemini thoughts are reported separately and added to output.
Conflicting aliases and invalid counts remain unknown and are listed in
`normalization_issues`. Missing OpenAI cached-token counts remain unknown;
absent cache-write counts are zero when usage exists.

Aggregate `usage` is null for any token class missing from any request.
`observed_usage` is the known subtotal and `usage_coverage` records coverage.
`usage_complete` additionally requires every call to pass normalization.
Opaque reasoning counts may remain null while billable output is complete.

`PricingSchedule` retains exact route/provider model IDs, per-token rates,
source URL/date/hash, currency and context tiers. Input and output rates are
applied to disjoint billing classes; reasoning is already part of output.
Unpriced routes/classes and inconsistent usage produce a null token estimate,
with a separate known subtotal. OpenRouter `usage.cost` is preserved separately
as `provider_reported_cost`, including raw `cost_details`; it is never used
to silently replace or adjust the frozen token estimate. Neither model cost
includes scoring or local compute.

`write(directory)` creates `metrics.json`, `attempt-manifest.json` and numbered
model responses with exclusive publication. Existing files are never overwritten.
Manifests should include task/selection hashes, source and loaded-service hashes,
settings, provider parameters, prices, timeout, package versions and ownership
inventory. No helper serializes environment variables, authorization headers or
Docker environment inspection. Callers must avoid secrets in supplied manifests.

Native runs use `record_native_requests` to ingest the authoritative transport
ledger, including retries, failed requests and stable request IDs. A ReAct step
is not a model request. Retain session and per-message ledger artifacts.

## Process supervision

`run_supervised(command, timeout_seconds, ..., stdout_path=..., stderr_path=...)`
runs a dedicated Linux subreaper. It waits for all descendants, including short
children that exit between samples and orphaned children that change sessions.
Timeouts, launch errors and successful roots with background children receive
owned-descendant cleanup. Existing engine services are measured separately and
never terminated by the attempt supervisor. Output paths are opened exclusively.
The result exposes `as_dict()`, return code, status, wall time, resources,
cleanup and captured output when no output paths were supplied.

CPU user/system/total from `wait4` includes exited descendants and is exact for
the supervised process tree. A native adapter's children exclude existing engine
services, so this measurement cannot represent the complete native system.
Memory uses a simultaneous sum of sampled RSS and is always approximate.
Individual `ru_maxrss` values are retained raw and never summed into a peak.
Sampled RSS counts shared pages per process and differs from cgroup memory charge.

Use `require_complete_resources=True` to fail before launching a task if the
required owned scope, exact CPU counters or exact per-attempt kernel memory peak
is unavailable. Public `ProcessResourceCollector.validate_ready()` performs
the same check after entry. Resource failures remain visible with a reason.

## Owned cgroups and service scope

`CgroupScope` supports unified v2 controllers and separate v1 CPU/memory
controllers. It reads CPU counter deltas and kernel memory peaks, preserving raw
initial/final readings, controller paths, sampling methods and limitations.
Exact attribution requires verified exclusive ownership. Kernel memory includes
page cache and baseline allocations; report the starting idle memory separately.

Fresh groups are exact only when the initial kernel peak is zero. Existing groups
require an explicitly owned reset to measure an attempt's peak. Lifetime maxima
are retained raw when reset is unavailable, and an approximate sampled peak is
reported instead. Peak resets are locked to prevent overlapping attempts.
v1 user/system CPU counters have clock-tick resolution; total CPU has nanosecond
resolution. The two totals can differ slightly due to kernel counter resolution.
v2 peak resets retain one writable descriptor through the measurement window,
because reset applies to that descriptor. A delegated writable \`memory.peak\`
is required; \`sudo tee\` is used only for owned v1 peak resets. See the
[kernel cgroup v2 reference](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

`provision_cgroup("parent/new-attempt", sudo=True)` creates a new v1 group and
delegates only its membership/peak files. It refuses existing groups and never
moves a service. `cleanup_cgroup(scope, sudo=True)` removes only newly provisioned,
empty scopes, never signals members, and preserves measurement artifacts.
Use sibling native and script roots so script attempts are not counted as native
descendants.

To start owned services before they allocate memory:

```bash
python -m benchmark.runtime.cgroup_exec --scope-file owned-scope.json -- \
  bin/local-dev.sh up <owned-services> --skip-build
```

Keep the launching host execution session alive. Some executors terminate
orphan descendants when a command returns. The persistent wrapper runs the
supported launcher, retains services after it succeeds, and stops its own
descendants on TERM/INT/HUP or calling-parent death:

```bash
python -m benchmark.runtime.service_session --scope-file owned-scope.json \
  --ready-file new-ready.json --result-file new-stopped.json -- \
  bin/local-dev.sh up <owned-services> --skip-build
```

A ready artifact means the launcher completed; check application health separately.
The wrapper must run in a dedicated process because subreaper and signal settings
are process-wide. Never attach an ambient user/session group.

For native service coverage provide `owned_service_pids={label: pid}`,
`ownership_verified=True`, `scope_kind="native_system"` and an explicit
`required_service_labels` inventory. Missing PIDs or PIDs outside the controller
invalidate completeness. A child-only native measurement is incomplete.

## Docker dependencies and common gateway

`docker_cgroup_scope(container, exclusive=True, ownership_verified=True,
reset_peak=True, sudo_reset=True)` resolves an explicitly owned running container's
actual cgroup. Only container ID/name/PID/start time are inspected. Docker scopes
are measurement-only; attaching a launcher to them is rejected. Readiness checks
verify the recorded container PID remains in its controllers.

Measure the same dedicated gateway during each arm's matching execution window,
as a separate common component. Native postgres/minio/lakefs dependencies are
separate native components. Do not include the shared gateway in the engine group.

`ComponentResourceCollector({label: scope})` collects disjoint component groups,
rejecting duplicate and parent/child scopes. Each component retains exact CPU
and kernel peak when available. CPU totals are additive. Whole-scope memory is a
sampled maximum of the simultaneous sum of current charges and stays approximate;
individual component peaks are never summed. Components use sequential boundary
reads, and their precise windows are retained separately. `snapshot()` is public;
`validate_ready(skip_labels=("engine",))` validates all other components before
paid work while a primary engine collector owns its peak reset. Use a read-only
engine scope copy (`reset_peak=False, fresh=False`) in this bundle to avoid
resetting the primary scope twice.

## Verification

```bash
.venv/bin/python -m pytest benchmark/runtime -q
```

Tests cover provider/cache semantics and unknown billing, tier boundaries,
immutable artifacts, short/exited descendants, session-changing timeout cleanup,
concurrent supervision, service lifetime, scope coverage, failed resource
preflight and the distinction between per-component peaks and sampled aggregate
memory. They make no provider calls.
