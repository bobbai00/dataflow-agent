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

# C9: observe-only correction

2026-09-16. The user requires that `inspectResult` not be available in any
configuration. This is a tool-surface correction, not an additional evidence
optimization or a changed task/scoring protocol.

## Tool contract

- Remove the executable result-inspection factory and every registration path.
  Code, general, native-typed, native-batch V1/V2 all lack the tool.
- Keep the legacy `enableInspectTool` wire field inert and always false so old
  clients cannot re-enable it. Legacy positional prompt flags are ignored.
- Native batches retrieve results solely through explicit `observe`, including
  `dataflow({operators: [], observe: ["answer"]})` for a cached read. Such reads
  preserve the evidence switches and shared result budget; no statistics bypass
  or replacement inspection tool is introduced.
- Use real project/filter/distinct/aggregate operators plus `observe` for focused
  or full-table calculations. The DAG scheduler and execution scope are unchanged.
- Preserve V2 `inspectError` and diagnostic repair acknowledgement. Error-only
  history must not advertise the removed tool through an inspection heading.
- Old saved traces remain readable without granting the old tool execution access.

## Baseline and evaluation

The baseline must be a minimal child of the actual batching parent
`41cd8ae97e30edfec90c847886ed4068dd0fa9b0`, with the same tool removal. Its
original checkout/history remain untouched. The three V2 arms share the corrected
candidate source and prompt. Model routes remain exact gpt-5.6-luna and
gpt-5.6-terra, both medium reasoning. All four requested configurations run on
the same 104 canonical tasks, with the same result/step budgets and retry policy.

C8 was stopped at 822 recorded first-pass slots with 808 completed model attempts.
Only Luna BatchParent wildfire-hard-19 was active at cancellation; its exact owned
agent was stopped and final partial traces/costs captured. The last two Luna
baseline tasks and legal-hard-1 in all eight arms were not dispatched. Original
artifacts remain at `/tmp/native-c8-campaign.HILOqM`, with `SUPERSEDED.md` recording
the cancellation. These are not corrected-design accuracy/cost results, even
when a particular trace did not call the tool: the advertised tool set differed.

Fresh labels use `NativeCampaignObserveOnly20260916Rep1`. The canonical-only
loader fix prevents a tiny fixture from shadowing legal-hard-1. The known missing
original astronomy-hard-7 files still require an explicit data-readiness failure
in the 104-task denominator; do not substitute different dated files.

New qualification must verify the actual service prompt and effective tool schema
before dispatch, not merely a disabled flag. Sources/services/settings/input
bindings are frozen anew; no old attempt is mixed into new results. Both common
failed-task recovery rounds preserve every earlier attempt and cumulative cost.

## Verification status

Regression-first tests demonstrate the original exposure failure, then check
absence across modes, DELTA/LATEST, settings toggles, initialization, delegate
rebuild, direct execution and driver schema dispatch. Cached-observe tests cover
all four data/flow combinations with the shared budget and immutable DELTA frames.
Historical trace rendering and error inspection remain covered.

The full candidate Bun suite passes: **1,153 tests, 10 snapshots**, followed by
successful `bun run typecheck`. Logs: `/tmp/native-observe-only-unit.log` and
`/tmp/native-observe-only-typecheck.log`. The initial new regression failed
against the previous runtime before the removal patch, as expected.

Live E2E qualification is required before the fresh campaign. Its final evidence
and source references will be recorded here once it finishes; this implementation
checkpoint is not a completed evaluation.
