<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements. See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership. The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License. You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied. See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# C7 partial: durable measurements and isolated service lifecycle

Date: 2026-09-15. Root implementation: **`6047f6a44`**. Harness:
**`702cf446ced179eded36ceebcfe9a853ad51578e`**, pushed on
`feat/native-python-dataflow`; the root gitlink points at that revision.
The batching/observe parent remains `41cd8ae97`.

This checkpoint closes the in-memory-only execution-recording gap and adds
source-pinned agent-only lifecycle checks. It is **not a completed pilot**:
no real-model trace, benchmark task, official task score, cost saving or
accuracy improvement was obtained. No shared backend was restarted or deployed.

## Implemented

- `agent-service/benchmark/e2e/execution-recorder-run.ts` writes an exclusive
  private JSONL journal. Startup metadata includes the actual recorder process,
  boot/start identity, source revision/dirtiness and source-file hashes.
  Each start is fsynced before forwarding and each finish afterward. A finish
  write failure preserves the backend's real response but prevents new work;
  a start write failure prevents forwarding. Read-only recorder status exposes
  identity, pending/completed counts and persistence health. Graceful shutdown
  drains; a killed recorder leaves explicit unfinished starts.
- Harness `utils/pilot_launch.py` uses only the supported
  `bin/local-dev.sh up agent-service --skip-build`, a free non-default port,
  and a fresh private launcher state directory. It verifies clean source and
  launcher tree hashes before/after launch, actual listener/entry-point
  identity, process start time, health and the execution route. No environment
  dump, credential or raw subprocess exception enters the public record.
  It never installs dependencies or starts/restarts a shared JVM.
- Its verify function rejects missing/replaced processes or changed
  source/routing. Empty-service shutdown additionally checks the same private
  state directory and that the service has no agents, then runs only
  `down agent-service` and verifies process exit/port release. Stop artifacts
  are separate from the original launch record. Failed/ambiguous launches
  are not automatic stop targets; workflow/CU cleanup is not implemented here.
- Harness `utils/execution_journal.py` binds the exact recorder, workflow and
  CU identities; deduplicates identical events; and preserves unknown outcomes
  for unfinished, conflicting, orphaned or malformed evidence. It checks phases
  rather than trusting saved pass labels or heuristic error-state strings.
  For each phase, `pass_rate = passed / (passed + failed)`, with all four
  outcome counts, the known-attempt denominator and known coverage reported.
  Zero attempts has no rate. A missing journal is not zero requests, and a
  drained recorder is never proof of backend termination. The reader is bounded
  to a 32 MiB journal; an oversized file is explicitly invalid, not successful.
- `run_pilot_task` accepts paired optional `execution_journal_path` and
  `recorder_id` arguments and attaches a scoped report to `pilot_metrics.json`.
  Missing/unreadable evidence leaves rates unknown without erasing an actual
  model answer or official score. A production guard must still require/bind
  the recorder; these reporting arguments do not qualify a run by themselves.

No candidate operators, prompt, schemas, model settings or engine runtime code
changed in this checkpoint. Existing measured engine phases from `4febe3761`
are consumed; Python preflight and runtime-start RPC success remain separate.

## Verification

| Check | Observed result |
| --- | --- |
| `bun test` in `agent-service` | **1,120 pass**, 96 files, 10 snapshots, 6,521 assertions |
| `bun run typecheck` | Pass |
| Focused recorder suites | **15 pass**, including an actual Bun child killed during an admitted request |
| Harness `.venv/bin/python -m unittest discover -s tests -q` | **78 pass**: prior 57 plus 10 launcher, 10 journal, 1 additional Executor/Evaluator integration test |
| Scoped Prettier and Ruff formatting/F checks; `git diff --check` | Pass; no packages installed into the shared venv |
| Real isolated agent-service launch/verify/empty-stop | Pass within one live calling runner; no model or execution request |
| Actual Bun journal -> Python phase report | Pass against a controlled loopback HTTP fixture, not Texera |

The full Bun log is `/tmp/native-python-c7-recorder-full-bun.log`; typecheck
log is `/tmp/native-python-c7-recorder-typecheck.log`. Private lifecycle,
journal and harness-test evidence is under
`/tmp/native-python-c7-runtime.mejJ56/`. Raw artifacts/logs are not committed.
Earlier Scala/Python-worker results are not presented as fresh reruns.

### Real agent-only lifecycle check

The agent runtime was clean at root `3d010ef163d5d1ac218f501ecc9cf904187ae786`.
The recorder/launcher changes tested then are committed in the revisions above.
The launcher used port **3011** and an explicit recorder route on **39193**;
the recorder's unused test CU whitelist was not a real resource allocation.

The first one-shot launch was initially healthy, but its listener was gone
before the next command. Verification correctly refused the old launch record.
A fresh contained invocation kept its calling runner alive through launch,
verification and shutdown: listener PID **2638689** was source-verified and
then stopped cleanly, with the port free afterward. Do not assume a background
child survives the lifetime boundary of an external command runner merely
because `nohup` was used. A launch record proves a point-in-time observation,
not indefinite process liveness.

That recorder ended with **zero pending and zero completed execution requests**.
No agent, workflow or CU was created. Lockfiles are hashed but the reused
installed dependency directory is only identified, not content-fingerprinted;
this is not an immutable-build attestation or backend/worker qualification.

### Journal/report integration fixture

A separate controlled loopback backend returned three synthetic phase records.
The actual Bun recorder produced `measurement-fixture.jsonl`; the Python reader
reported two compiler passes/one failure, and one runtime pass/one failure/one
not attempted. The synthetic compiler durations summed to **9 ms**. These
numbers test serialization/accounting only; they are **not Texera compilation
or benchmark results**. The start/finish and kill tests additionally demonstrate
that lost responses cannot be used as evidence that the backend stopped.

## Remaining gates

1. Complete the production admission manifest/guard: source-pinned reference
   services, matching backend/worker, actual task/data hashes, frozen price
   schedule and required correctness/real-model qualifications. Keep the outer
   runner alive and recheck live identities before dispatch and after attempts.
2. Journal each owned allocation; bind recorder output to attempts; verify
   terminal backend state and clean up only owned agent/workflow/CU resources.
   The empty-service stop helper is not workflow/CU cleanup. Refresh final
   measurements after recorder drain, without replacing an interrupted attempt.
3. Aggregate collector cost by producing result identity, not snapshot count;
   preserve partial/unavailable coverage. This is still a report placeholder.
4. Obtain a coordinated shared-backend update window, then run outstanding C4
   repair, C5 evidence and C6 shape/diagnostic live matrices against the matching
   candidate engine and Python worker. Final read-only checks still show master
   PID **2114172** on 8085 from `op-granularity/amber`; 3011/3012/3013/39193
   have no listeners. The restart question remains unanswered.
5. Implement/run the real-model dependent-batch, explicit-observe and repair
   smoke, retaining actual `inputMessages`. Then run only the frozen
   `environment-easy-3` first attempt per arm through KramaBench and its official
   evaluator (expected `success`, threshold >=0.9), and publish the dated
   cache-aware cost/accuracy/compile/runtime/collector report.

The implementation goal remains active. No live/real-model/benefit gate is
waived by the passing local checks above.
