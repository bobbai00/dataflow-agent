<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# C7 partial: first attempts and cost accounting

Date: 2026-09-15. Branch: `feat/native-python-dataflow`, descended from
batching/observe `41cd8ae97`. Harness commit:
**`79cdec91639c8ec98eb093b91a432792c3269036`**, pushed to the isolated
`bobbai00/Kramabench` branch of the same name. This follows the
[measurement checkpoint](native-python-dataflow-c7-measurement.md).

This implements and tests the harness execution/capture/scoring path, **not
a completed pilot or launch-ready production runner**. No real model, live
Texera worker or official benchmark task was run. Official scoring tests use
a synthetic task and mocked agent; those scores are not benchmark results.
No cost/accuracy improvement is claimed.

## Delivered execution path

The seven new arms inherit `NativePilotSystem`; legacy SUTs retain their
setup/retry policy. Dataset preparation is read-only. A fresh task directory
is reserved exclusively, including failed or empty first attempts. The one
dispatch uses `empty_turn_retries=0` regardless of the legacy environment and
a fixed 1,800-second client turn budget. There is no reset/setup fallback.

`native_python_pilot.run_pilot_task` calls the existing KramaBench `Executor`
once, on exactly `environment-easy-3` with the oracle-file subset, then the
existing `Evaluator` with official `success` and the frozen >=0.9 threshold.
Numeric answer scoring no longer constructs an unused pipeline LLM judge.
Preflight rejection before a model dispatch is unscored, not an officially
wrong model answer. Raw scores and treatment-comparison eligibility differ.

The caller must bind a guard before using a new pilot SUT, invoked before
setup, immediately before dispatch and after the attempt. The production
provenance/data/qualification/ownership guard is still pending; tests use
controlled callbacks. There is no default no-op guard or CLI bypass.
Registration or a supplied CU ID does not qualify a live run.

## Failure evidence and answer semantics

- Received step/state/complete/error events are fsynced to private
  `events.jsonl` before the next frame. Init/delegate payloads are excluded.
  Step updates are deduplicated by ID for token accounting.
- Normal completion, EOF, setup/dispatch exceptions and catchable interrupts
  preserve resource IDs and attempt bounded REST capture of the full trace,
  effective settings/identity, workflow and every step snapshot. Wrong
  snapshot IDs fail capture; unavailable/malformed traces use the received
  stream and remain partial.
- `attempt.json`, `capture.json`, `config.json`, `snapshots.json`, canonical
  `response.json`, `verdict.json` and helper-derived `pilot_metrics.json`
  supplement the standard artifacts. Model inputs come from real service
  `inputMessages`, not reconstructed context. Tests mock those inputs;
  real-model qualification is still owed.
- An observed final model answer survives a missing completion frame or input
  capture. That does not prove complete usage/input history, termination or
  qualification. Synthetic error/stop steps are not parsed as answers.
  Transport completion, answer correctness and compile/runtime pass rates
  remain separate measurements.
- Atomic writes stay inside the fresh private task directory. Exception
  records retain stage/type, not credential-bearing raw messages. Full traces
  and snapshots remain private ignored artifacts and need sanitization before
  publication.

Pilot destructors/`cleanup()` deliberately do not delete live resources.
The pending outer runner must verify terminal state, clean up only owned
resources, and retain unresolved IDs. An interrupted socket is not termination
proof. Per-allocation journaling is still needed for SIGKILL/power loss during
setup before an ID is persisted; current guarantees cover received events and
catchable finalization, not every possible hard process failure.

## Accounting and provenance bugs fixed

1. The server re-broadcasts its final step with `isEnd=true`. The old client
   added its usage twice. A regression reproduced double-counted steps/tokens;
   the client now replaces usage by step ID.
2. Empty-turn retry policy can now be explicitly disabled per pilot call.
   EOF is not assumed to mean no model/backend work occurred.
3. Generic exceptions formerly returned zero usage before saving a trace.
   The new pilot path preserves partial evidence and marks unknowns.
4. Missing/invalid/partial costs no longer become free runs in shared
   `kb.py` cost/compare/Venn/case helpers. Known-cost denominators are labeled;
   unknown costs do not discard tasks from accuracy overlap.
5. Service provenance resolves the actual listener PID/start identity,
   source entry, on-disk SHA and dirtiness instead of guessing by port or
   falling back to main. Unresolved cases remain unknown. This explicitly
   does **not** prove what a previously started process loaded.

`price_schedule()` captures existing harness rates/source before dispatch.
The common cache-aware formula uses those frozen rates, without double-billing
reasoning. Complete `cost_usd` requires complete valid input/output/cache counts
and completed-turn evidence. Otherwise observed cost is separate and the
whole-attempt cost is null. Missing cache usage and impossible counts cannot
earn a complete cost. These are token estimates, not newly verified public
prices/provider invoices. Cross-arm pricing equality still needs the guard.

Historical artifacts were not changed or rescored. Old-versus-new cost
comparisons must audit the final-step accounting difference; fresh pilot arms
will all use the corrected harness. No old savings claim is revised here.

## Verification and unchanged services

- `.venv/bin/python -m unittest discover -s tests -q`: **57 pass**, including
  the prior 19 and 38 added provenance/client/capture/scoring regressions.
  Output: `/tmp/native-python-dataflow-c7-attempt-harness.log`.
- Actual `Executor` -> pilot SUT -> actual `Evaluator` integration passes
  with a mocked agent, including no-dispatch preflight rejection. This is not
  a live backend/model or benchmark-task result.
- `kb.py systems` lists all seven pilot SUTs.
- Ten scoped Python files pass Ruff formatting and F-rule checks;
  `git diff --check` passes. Black was unavailable in the shared venv;
  cached Ruff 0.15.5 ran in an isolated offline tool environment instead.
  No packages were installed into the shared benchmark environment.
- Agent-service/engine runtime source is unchanged here. Older Bun/Scala/
  Python-engine results are not presented as fresh reruns.
- Final read-only checks still show master PID **2114172** on 8085, cwd
  `op-granularity/amber`; ports 3011/3012/3013 have no listeners. No Texera
  service was started, stopped, rebuilt or deployed in this checkpoint.

## Remaining gates

1. Implement source-pinned launch/admission checks for stable service/worker
   build identity, effective settings, task/data hashes, one pricing schedule,
   isolated CU ownership and immutable attempt namespaces.
2. Persist execution-recorder start/end events and bind them to each attempt;
   report measured compile/runtime denominators and unknowns. Add allocation
   journaling, verified cleanup and producing-version collector deduplication.
   `pilot_metrics.json` is not that execution/overhead report.
3. Coordinate the backend update window, then run outstanding C4 repair,
   C5 evidence, C6 shape/diagnostic and execution-phase live checks against
   matching engine/Python source.
4. Capture real-model dependent-batch/observe/error-repair inputs, run the
   one-task/one-attempt-per-arm pilot, and publish the dated sanitized official
   score/cost/compile/runtime/collector report and mechanism audit.

The implementation goal remains active; C7 and live/real-model gates are not
complete.
