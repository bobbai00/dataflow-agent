<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# C7 partial: frozen inputs and owned one-attempt runner

Date: 2026-09-15. Branch: `feat/native-python-dataflow`, still based on the
batching/observe parent. Harness commit:
`3f62a1144eaf3772c1ee4b8ad870afb91ba806f2`.

**This is runner integration and local verification, not a completed pilot.**
No model turn, worker execution or official benchmark attempt was run for this
checkpoint. No cost or answer-accuracy benefit is claimed.

## Implemented

- `utils/pilot_inputs.py` freezes the exact official task, deterministic ordered
  prompt files, actual matching harness/worker file bytes, prompt hash and
  existing harness token-price schedule. It rechecks paths/stat identity across
  hashing and rejects later input/pricing/prompt drift. No gold, raw rows or
  prompt text enters the manifest. An input check explicitly does not qualify
  the runtime. Local candidate `data` and `amber/data` aliases are gitignored
  environment setup, not source artifacts.
- `NativePilotSystem` sorts expanded files only for this pilot. The legacy
  set-order helper remains unchanged. Official execution and local preparation
  share `prepare_pilot_task`, preventing a `-tiny` task from silently overriding
  the exact executor workload.
- A discovered guard bug is fixed: previously any normal return, including
  `{"qualified": false}`, admitted work. All three guard stages now require a
  dictionary with `qualified` exactly `True`. Preflight rejection prevents
  setup/dispatch; postflight rejection keeps the raw answer but excludes the
  attempt from the treatment comparison. Regressions were observed failing
  before the fix.
- `finalize_pilot_measurements(system)` refreshes only derived execution and
  collector measurements after the originally bound recorder is valid/closed.
  It never reruns/rescores the task or changes answer, verdict, trace or cost
  artifacts. Open/foreign/invalid journals do not replace the initial report.
  Repeated refreshes are idempotent. Closure still does not prove backend
  termination, full phase coverage or whole-attempt collector overhead.
- `utils/pilot_session.run_owned_pilot` now composes the complete one-arm
  lifecycle: source/input/namespace checks, mandatory runtime admission before
  allocations, owned CU receipt, candidate recorder, pinned isolated agent,
  one official attempt, drain, metric refresh, independently verified cleanup,
  and empty-service shutdown. Historical agent trees use the same separately
  pinned candidate recorder; they need not contain the new recorder files.
  Source/input/recorder health is rechecked at every attempt guard. No campaign,
  retry, restart or permissive CLI is added.

The mandatory production qualification callback is **still not implemented**:
it must bind matching engine/worker, live correctness/model gates, historical
reference revisions, effective settings and current resource ownership. A mock
returning true is not that evidence. The runner API and limitations are in the
[harness documentation](../../benchmark/Kramabench/docs/native-python-pilot.md).

## Verification

From the isolated harness:

```bash
.venv/bin/python -m unittest discover -s tests -q
```

**160 tests pass**, zero failures/errors. The previous 132 are joined by 10
input tests, 3 guard-return tests, 3 post-drain finalization tests and 12
session/recorder-admission tests. These include all seven frozen arm ports,
one-attempt ordering, source drift, rejection before allocation, unknown
failure preservation, cleanup refusal and late execution finishes without
another model/evaluator call. Service/model behavior in these tests is mocked.
Scoped Ruff formatting/F-rule checks and `git diff --check` pass.

Agent/engine production code did not change: the prior 1,120 Bun tests,
typecheck and Scala/worker checks are not relabeled as fresh runs.

A fresh-process, local-file preflight check then used the committed harness
and actual `environment-easy-3` files through the new outer runner. It reached
`before_resources` for both the current master working directory and the
candidate worker directory. The 2012/2013 files were 1,467,124/1,469,864 bytes;
their hashes matched at harness and worker paths. Both produced prompt hash
`a50209522b4c3cade1ecfb532a4dc9884e76f49110c8230838413e22fcd4a870`.
An intentionally rejecting qualification callback then stopped each invocation
before authentication/allocation. Authentication was instrumented to fail if
called and was never called. No first-attempt task directory was reserved.
This is a **negative admission/local-input check**, not a live-qualified run.
Private evidence: `/tmp/native-python-c7-session-preflight.WW312X/evidence/preflight.json`.

The shared master remains PID 2114172, started 2026-09-15 02:03:03 local, with
working directory `op-granularity/amber`; isolated ports 3011/3012/3013 remain
free. No shared service was started, stopped or restarted for this checkpoint.

## Remaining gates

1. Implement/bind the production runtime/prior-live-gate qualification callback;
   retain source/build evidence, not a port map or arbitrary passed flag.
2. Obtain the still-unanswered shared-backend update window and run outstanding
   C4 repair, C5 evidence and C6 shape/diagnostic worker fixtures on the matching
   build. Review fixture cleanup before any uncertain execution is discarded.
3. Run the prepared real-model protocol in independent DELTA/LATEST sessions,
   retaining actual input messages and verified owned-resource cleanup.
4. Run the frozen task once per arm, serially, and publish official success,
   cache-aware cost, measured compile/runtime denominators, collector component
   overhead and the input-timed mechanism audit. No full campaign is authorized
   by this checkpoint.
