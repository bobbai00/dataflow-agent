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

# Long-horizon task catalogs: implementation and evaluation plan

Status: 2026-09-21. The shared ReAct cleanup and manual context switch are
implemented and unit tested. Bounded catalog memory, automatic switching and the
experiments below are planned. This document is the forward plan;
[task-history-dataflow.md](task-history-dataflow.md) describes the implemented
contract. Historical results describe their recorded revisions, before this
cleanup.

## Main idea

Measure the cost of solving the next task as a conversation gets longer, while
holding task difficulty and accuracy comparable. A session can be expensive to
initialize yet become economical to continue: earlier work creates useful
cleaned tables, joins, calculations and historical results. The question is
whether a short catalog lets the agent find and reuse those artifacts without
replaying the work that produced them or generating the same program again.

The durable store may grow with the session; the working prompt should contain
only the applicable analysis requirements, relevant artifact cards and current
task evidence. After initial construction, we seek decreasing or approximately
flat marginal task cost over the tested history range. We do not expect cost to
decrease indefinitely, or remain flat when the intrinsic task complexity grows.
Whole-session cost and recovery of initial construction cost remain secondary
measurements.

CodeAgent already keeps Python state, and it can also use summaries, indexes and
retrieval. Our strongest comparison is therefore against a credible CodeAgent
with bounded memory. Dataflow's possible advantage is that executable artifacts,
schemas, dependencies and exact historical bindings make useful state easier to
identify, reuse and verify. A smaller prompt by itself would establish a memory
management improvement, not a unique advantage of dataflow abstraction.

## Why this is worth testing

The [direction review](multiturn-direction-review.md) audits the earlier attempts.
The [long-horizon trace analysis](../agent-service/benchmark/multiturn/LONG_HORIZON_REVIEW.md)
and its [per-task measurements](../agent-service/benchmark/multiturn/long-horizon-analysis/per-task.csv)
support a focused experiment, with important limits:

- On seven later university tasks solved correctly by all three compared
  systems, compact Dataflow cost about 49% less than ordinary CodeAgent and 45%
  less than the snapshot control. Reusing a cleaned table reduced regenerated
  code. About 82% of the saving against ordinary CodeAgent came from output
  tokens. This selected successful subset diagnoses a mechanism; it does not
  establish an end-to-end accuracy advantage.
- Long cached histories still cost money. Ordinary CodeAgent's late NFL input
  averaged about 131k tokens per call, and cache reads accounted for 53.5% of
  late task cost. Nevertheless, Dataflow was more expensive overall in that
  block because it needed more calls and generated work. All compared systems
  failed those late tasks under strict scoring.
- The historical catalog arm still replayed old questions, answers and receipts.
  At NFL task 42, that text accounted for approximately 38.6k tokens, versus
  4.9k for the catalog. Making operator cards shorter alone misses most growth.
- Repeated runs had substantial accuracy variance. The current evidence does
  not demonstrate stable cost savings at preserved accuracy.

Using the historical campaign's recorded prices, a completely cached history
of `H` tokens costs less than a completely rewritten catalog of `K` tokens until
`H > 12.5 × K` ($0.02/M cache reads versus $0.25/M writes). A 5k catalog crosses
a 62.5k cached history under those assumptions. This is a context-only example,
not current provider pricing or a universal switching threshold. Retrieval,
catalog maintenance, call count and output can erase that saving.

## Implementation boundaries

Keep one ReAct implementation for all Dataflow arms. The synchronization baseline
is `feat/evidence-compaction` at `fa22f4213`, plus the source-seeding work inspected
in the `evidence-only-context` worktree. Source seeding is optional and defaults
off. Use ordinary repository changes to maintain shared code; runtime behavior
must not depend on importing files from another worktree.

The cleanup removes the separate task cache transport, compact prompt/schema,
direct-return path, answer refusal heuristics, receipts/reuse prompting,
demand-execution variant and kept-frame rewriting. The remaining task-specific
behavior is context projection and historical result retention. Normal tool
calls, execution, observations, repair and final answers use the shared loop.

| Capability | Current state | Next action |
| --- | --- | --- |
| Shared ReAct and evidence assembly | Implemented, aligned and tested | Keep fixed across research arms. |
| Exact historical `{operator, atTask}` inputs | Implemented with complete retained outputs | Preserve binding, invalidation and error semantics. |
| Full history versus catalog context | Implemented as an assembler decorator | Use `react-full` and `react-catalog` as the initial controlled pair. |
| Switching context between completed tasks | Implemented in both directions | Exercise it in a same-session experiment harness. |
| Bounded catalog and active requirements | Not implemented | Build the smallest context projection and retrieval prototype. |
| Automatic switching | Not implemented | Evaluate fixed thresholds first; add a measured policy only if justified. |

The present catalog is not bounded: it includes prior questions/answers and all
operator cards. The shared active-task renderer can also include the current
workflow. Both sources of inherited context must be covered by any prompt
budget; capping only the prefixed catalog would leave a hidden growth path.

### 1. Bound inherited context while preserving meaning

Maintain the complete task archive and artifact metadata outside the prompt.
Keep a compact active analysis specification containing applicable units,
precision, population/cohort definitions, filters and changing defaults. Track
where a requirement came from and which later instruction superseded it. A
summary must not silently replace an explicit user requirement with a guess.

Render a bounded set of relevant cards with stable operator identifiers,
schema, availability, version and provenance. Distinguish current results from
historical results and failed or stale state. Select dependency details and
result evidence only when needed, within the same configured evidence budget.
Keep exact runtime bindings authoritative; a summary or card is not evidence
that a calculation is correct.

Start with a simple deterministic selection policy using information available
at the current task, such as explicit references and graph dependencies. Provide
a normal shared tool path to discover omitted artifacts and retrieve archived
requirements or details. Selection must not depend on reference answers, future
tasks or benchmark-specific names. Charge any model-assisted summarization,
retrieval and repair calls to the run. Measure inherited-context size separately
from the current task's necessary instructions, tools and observations.

Implement a comparable CodeAgent control with persistent Python state, one
current index, compact applicable requirements and access to archived details.
Do not repeatedly prepend the full index to historical prompts; the existing
snapshot control's index duplication is not a fair compact-memory baseline.

### 2. Start with full history, then switch

First test a caller-selected boundary. Create the agent with historical retention
enabled if the workload needs it, run initial tasks with full history, and set
`nativeTaskContext: true` between completed turns. A switch changes the context
projection while preserving workflow, results, task numbering and historical
bindings. It must preserve the active requirements as well. The current setting
switches to today's growing catalog; switching to a bounded catalog depends on
the implementation above.

Compare always-full, always-bounded and full-then-bounded policies. Explore fixed
task or token thresholds on development workloads, then freeze the policy before
held-out evaluation. Begin with one switch per session so the experiment is easy
to interpret. A later adaptive policy can estimate full-history input cost
against catalog input plus update/retrieval overhead using recorded usage and
the configured price schedule. Any estimate of remaining horizon must use
information available to the agent, not future benchmark tasks.

Log the boundary, available state and estimated costs for each decision. Charge
conversion and catalog construction where they occur. A context-only crossover,
a cheaper next task and cumulative repayment of setup cost are three separate
outcomes. Leave normal provider caching enabled and comparable across arms;
custom cache-boundary tuning is outside this experiment.

### 3. Record enough evidence to explain a result

For every task, capture success, total cost across all attempts, model calls,
uncached input, cache reads/writes, output and reported reasoning usage without
double counting. Include maintenance and retrieval calls, failures, retries,
and missing-usage indicators. Record the rate schedule and provider accounting
fields rather than inferring billing from prompt text alone.

Also record context component sizes, selected/retrieved artifacts, actual input
bindings, reused result identities, invalidations and executed operators. Tool
arguments and execution evidence establish reuse more reliably than a model's
claim that it reused a result. Report latency, executed work and retained bytes
separately from model cost; include infrastructure cost if it is measured.

Each run manifest should identify runtime and harness commits, any dirty source
hashes, settings, model/transport, dataset/task versions, judge version and
threshold policy. Historical labels keep their old meanings and run at their
recorded revisions. New results use new arm names and cannot silently inherit
the older experiments' scores.

## Testing and experiment sequence

### Completed cleanup checks

- Agent-service: 1,107 tests passed, with zero failures; TypeScript type checking
  passed.
- Python native runtime: 35 tests passed.
- Regression coverage includes switching both directions, synchronous and
  asynchronous assembly, active-turn rejection without partial settings changes,
  shared tool/final-answer behavior, retained state across switching, retired
  setting rejection, SDK callback ordering, limits and cancellation.
- Source comparison checked the ReAct, execution, preview and model/assembler
  construction against the inspected evidence worktree. Task-boundary retention
  and the documented generic runtime fixes are the intentional differences.

No new paid model campaign or live engine smoke was run for this cleanup. The
local JVM/engine services were stopped. These checks establish implementation
behavior, not the research hypothesis.

### A. Verify the context and switching contract

Write regression tests before each new behavior. Test budget enforcement and
deterministic selection as task and artifact counts grow; retrieval of an old
requirement or omitted artifact; superseded defaults; and explicit handling when
required content cannot fit. Check that summaries preserve units, precision and
cohorts, and that tool-call/result pairs remain valid for the model transport.

Verify identical active-task ReAct behavior between projections, unchanged
current/historical input semantics, and switching with empty results, revised
operators, failed execution and distant dependencies. Cover both catalog-prefix
growth and inherited graph content in the shared renderer. Exercise the same
memory expectations in the compact CodeAgent control.

With the supported local stack running, run the maintained no-model retention
smoke before a model campaign:

```bash
# Stack setup, credentials and generated Python protos: docs/local-dev-with-agent.md
bin/local-dev.sh up
bun run agent-service/benchmark/multiturn/task-history-smoke.ts
```

Extend the smoke to verify that switching around actual engine execution keeps
complete historical values and live invalidation correct. Unit tests with a
retainer fixture do not replace this backend check.

### B. Isolate the memory mechanism with paired continuations

Build a few correct saved analysis states and equivalent Python states. Continue
from those states with matched requests under different history lengths and
memory policies. This separates finding/reusing correct state from the harder
problem of constructing it reliably. Restoring retained task bindings may need
harness support: the current service does not reconstruct them from files after
clear/import/restart. Otherwise keep the prepared sessions alive.

Use meaningful prefixes at depths such as 10, 25, 50 and 100 tasks; consider 200
only after the smaller experiment works. Match probe difficulty, answer length,
available useful state and reuse opportunity. Vary history depth independently
of distance to the needed artifact. Do not use dummy padding or replay the probe
answer earlier in the conversation. Keep both warm and cold cache conditions
comparable and report them; trace-based repricing is only a cost estimate and
cannot establish post-switch accuracy.

### C. Evaluate full sessions against credible controls

Start with `react-full` versus `react-catalog` to validate the shared-loop baseline.
Then compare bounded Dataflow and bounded CodeAgent with their ordinary controls.
Add the hybrid policy once the bounded representations work; avoid a large
matrix of unrelated optimizations.

| Arm | Purpose |
| --- | --- |
| Ordinary CodeAgent | Competitive persistent-Python baseline. |
| CodeAgent with bounded memory | Test whether generic memory management explains the benefit. |
| Dataflow with full history | Same ReAct loop, retaining complete conversation. |
| Dataflow with bounded catalog | Test executable catalog memory throughout the session. |
| Dataflow full then bounded | Test whether postponing catalog conversion improves the tradeoff. |

Use the same model, transport, output/step limits and normal cache treatment
where supported, and record unavoidable framework differences. Keep Dataflow
tool, evidence and retention settings identical across its arms. Source seeding
stays off for the initial comparison. Include all attempted tasks and complete
session failures in primary results; show success-conditioned diagnostics only
as secondary explanations.

Cover repeated analyses over shared cleaned/joined data, returning to an older
analysis after intervening work, and combining current with historical results.
Include revisions that invalidate descendants, growing catalogs, distant
dependencies and fresh-dataset tasks with little reuse. These negative controls
show where the approach should not help. Use pilot repetitions to estimate
session-level variance, then freeze the accuracy criterion, minimum worthwhile
cost reduction, sample size, thresholds and budget before held-out evaluation.
The intended accuracy target is unchanged accuracy; any practical tolerance and
uncertainty rule must be explicit before interpreting a saving.

Report per-task cost and accuracy by matched history depth, cost components,
calls, context growth, reuse and repair behavior. Estimate uncertainty across
sessions/templates and repeated runs, not by treating dependent turns as
independent samples. Compare late-task levels and slopes over the tested range.
Show setup cost and cumulative break-even separately, without claiming an
asymptotic bound from a finite experiment.

## Decision and deliverables

Proceed with the bounded-context prototype and small paired experiment before
building more reuse operators. A convincing result preserves accuracy and lowers
late-task total cost against compact CodeAgent, with traces showing what work
was avoided. If both compact systems improve equally, the contribution is memory
management. If Dataflow's typed artifacts and exact historical bindings improve
reliable reuse or recovery at lower cost, that supports the dataflow hypothesis.

If savings disappear after retrieval/output costs, or accuracy becomes unstable,
stop adding ad hoc optimizations. Use the failures to decide whether to improve
requirement preservation, change the catalog representation, or narrow the task
family. A benchmark change should test a stated mechanism on held-out workloads
with natural reuse, such as long-lived cohort revisions or historical/current
composition. Keep low-reuse controls and report the narrower scope. Longer
conversations alone are not evidence of a useful dataflow opportunity.

The next milestone should deliver the bounded projection and retrieval contract,
its regression tests, a credible compact CodeAgent control, a reproducible
continuation/switching harness, and a report with manifests, raw traces,
per-task tables, uncertainty and crossover plots. Only a successful pilot
justifies the larger full-session campaign.
