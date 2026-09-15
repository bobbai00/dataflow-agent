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

# C7 partial: collector accounting and owned-resource lifecycle

Date: 2026-09-15. Branch: `feat/native-python-dataflow`, descended from the
batch/observe parent `41cd8ae97`. Harness implementation: `377c33c`.
This checkpoint changes the nested KramaBench
harness, not the candidate operators, prompt or engine. It completes a real
setup/capture/cleanup smoke, **not** an operator/worker/model E2E or benchmark
pilot. Outstanding live qualifications and official pilot results remain
required; no accuracy or cost benefit is claimed.

## Implemented

- `utils/collector_measurements.py`: aggregate decoded profile measurements
  only after complete result-version/materialization binding and attribution
  to the workflow/CU-scoped execution journal. Deduplicate producing results,
  not snapshot retrievals. Preserve partial/unavailable/unattributed/conflicting
  evidence. `native_python_pilot.py` now writes this report instead of a string
  placeholder, including through the actual Executor/Evaluator integration.
- Collector `collectionMs` sums worker `ProfileAccumulator.add()` timers;
  snapshot/encoding, transport and rendering are excluded. It is neither total
  execution time nor CPU time. Even a complete snapshot capture can miss failed
  materializations, so these remain observed component totals, never claimed
  whole-attempt overhead. No sample rows/custom statistics enter this report.
- `utils/resource_journal.py`: exclusive private fsynced allocation intents
  and receipts. Pilot setup records workflow/agent IDs before the next creation;
  a separately allocated CU has its own journal. References and matching names
  are not ownership. Failed receipt writes retain IDs on the client and stop
  the next allocation. A crash before a receipt remains unresolved, not retried.
- `DataflowAgent.setup(on_resource=...)` uses explicit names/CU, synchronous
  callbacks and bounded no-redirect requests. The pilot reserves its attempt
  before setup; missing bundles fail before API calls. Legacy defaults and
  positional arguments are unchanged; destructors do not delete pilot state.
- `utils/pilot_cleanup.py`: verify actual source/service/delegate identity,
  complete capture and journals, current ownership, local CU/backend binding,
  all recorded requests and matching terminal database executions. Delete only
  the owned agent/workflow, then terminate the local CU registration, verifying
  each absence before continuing. Unknown outcomes, foreign workflow traffic
  or malformed resource lists prevent further cleanup. Local CU termination
  does not stop the shared JVM. Each mutation/partial outcome is persisted.
- The execution journal now rejects a footer with a changed backend, CU
  whitelist or request limit. This binds the recorded drain to its start scope.
- `utils/pilot_resource_smoke.py`: keep the outer process alive through actual
  setup, artifact capture, recorder drain, verified resource cleanup and empty
  service stop. Start only an isolated agent using the supported launcher; no
  model request, workflow execution or shared-backend restart.

Cleanup is one verified attempt, not automatic partial-deletion recovery.
Uncertain allocations, lost services or partial cleanup require investigation;
the helper deliberately refuses to guess IDs, retry tasks or kill executions.
The production admission guard and complete outer pilot orchestration are
still required.

## Verification

From `benchmark/Kramabench`, using its existing provisioned `.venv`:

```bash
.venv/bin/python -m unittest discover -s tests -q
```

**117 tests pass**, zero failures. This includes the prior 78 tests plus 39
collector, resource-journal/setup, cleanup and orchestration tests. The actual
Executor/Evaluator path is tested with a mocked agent; these tests themselves
make no real Texera or provider requests. New regressions were observed red
before fixing changed recorder scope, malformed absence responses and foreign
workflow traffic. The arm configuration fixture now reserves its attempt
bundle before setup, preserving the journaling requirement.

Scoped new/modified Python passes Ruff format checks (`--line-length 120`)
and F-rule lint. Large legacy client/system files were not mass-formatted;
their edits are scoped and checked by the harness tests. No package was
installed into the shared Python environment. `git diff --check` passes.
Root agent/engine production source did not change, so the previous 1,120 Bun
tests/typecheck and prior Scala/worker checks are not relabeled as fresh runs.

### Actual setup-only live check

Command, from the harness (fresh private output):

```bash
.venv/bin/python -u -m utils.pilot_resource_smoke \
  --worktree /home/bob/Desktop/dataflow-agent/.claude/worktrees/native-python-dataflow \
  --sha 762e80e96e45adac81cd3247c2ab0ead531141db \
  --output /tmp/native-python-c7-resources.ZQNqmc/run --port 3011
```

Observed outcome: **passed**. The source-pinned candidate agent was PID
2722192 on 3011. Actual pilot setup created CU registration 73, workflow 4156,
and agent `agent-bqtik7-1`, with intent/receipt journals. Real REST capture
returned an idle agent, empty workflow and no model/tool/user steps. The
recorder closed with zero requests, zero unfinished requests and no issues.
Pass-rate denominators were zero and pass rates **null**, not 100%.

The cleanup report independently checked ownership and empty backend execution
history, removed only those owned test resources, and verified their absence.
The qualified empty-service stop exited successfully and verified the process
gone/port free. Fresh separate workflow and CU list reads also confirmed 4156
and 73 absent. Their metadata and empty workflow remain in the private capture.
The shared master stayed PID **2114172**, start time **2026-09-15 02:03:03 local**,
cwd `op-granularity/amber`; 3011/3012/3013 had no listeners afterward. No shared
JVM, provider or Python worker was started/restarted/called by this check.

The cross-workflow refusal was added in final review after this live check and
verified as a failing-first mocked regression. The zero-request live evidence
contains `other_requests: 0`; no concurrent foreign execution was induced.

Artifacts include `smoke.json`, both allocation journals, `agent-launch/`,
`execution_requests.jsonl`, `execution_report.json`, `setup/` and
`cleanup/cleanup.json`. Temporary files may expire; this checkpoint is the
durable sanitized record. Raw auth responses, tokens and launcher logs are not
committed. This is a setup-only check outside official first-attempt namespaces.

## Remaining gates

1. Production manifest/admission checks and outer runner integration: pin the
   reference services, matching engine/worker, actual task/data hashes, pricing
   and required correctness/model qualifications; verify them before/after each
   dispatch. Refresh measurements after recorder drain without rerunning a task.
2. A coordinated shared-backend update window, then outstanding C4 repair, C5
   evidence and C6 shape/diagnostic live matrices against the matching build.
   The original restart-window question is still unanswered; this smoke grants
   no authority to restart the shared master.
3. Implement/run real-model dependent-batch, explicit-observe and repair smoke,
   retaining actual `inputMessages`, before the frozen `environment-easy-3`
   first attempt per arm and its official KramaBench evaluator.
4. Publish the dated answer accuracy, cache-aware cost, compile/runtime rates,
   observed collector components and trace-mechanism report. No full campaign
   or benefit claim is authorized by this checkpoint.
