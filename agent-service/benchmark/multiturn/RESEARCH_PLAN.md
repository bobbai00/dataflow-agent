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

# Research plan: maintaining analytical state with executable dependencies

Status: minimum state milestone and paired smoke campaign completed. See [MVP_REPORT.md](MVP_REPORT.md) for the implementation, 130 scored requests including recovery attempts, and the next experimental gates. The primary competitor is ordinary Code Agent; the full backend stack is isolated.

## 1. Claim and falsifiable hypotheses

Can an executable dependency graph reduce the model work required to preserve,
compose, and repair analytical state across a session?

The primary comparison is ordinary Code Agent versus Dataflow. Do not add reusable-function guidance or an artificial Python catalog. The treatment is automatic management of versioned dependencies. A catalog,
function reuse, batching, or a cheaper prompt layout alone does not establish
this contribution. Python may author or implement the same graph semantics.

Test two hypotheses separately:

- **State maintenance:** with comparable history, artifact access, and reusable
  computation, graph-managed composition and updates reduce state errors and
  model calls spent on repair.
- **Context selection:** after state maintenance is qualified, following the
  selected dependencies reduces total model cost as unrelated history grows,
  without starving the model of definitions, values, or governing instructions.

Model calls and token usage are observable proxies for model work, not direct
measurements of internal reasoning. Graph consistency cannot prove that a
chosen statistical formula or historical artifact is semantically correct.

## 2. Starting point and isolation

- Existing research branch: `feat/multiturn-dataflow-research`, with prototype
  and study through `c1d6c0a8f`; measured results are in [REPORT.md](REPORT.md).
- Parent inspected for this plan: `feat/native-python-dataflow` at `8ef6b6201`.
  Its committed work now includes result-version metadata, evidence budgeting,
  revision-pinned error inspection, and additional Python operators. Its
  checkpoint reports matching-worker V2 qualification and a completed pilot.
  That does not establish compatibility of the current research service.
- The current research implementation already recomputes descendants within a
  live workflow. New experiments concern history, bindings, branch semantics,
  and context; do not claim ordinary descendant recomputation as new work.
- Reuse committed parent features after a compatibility preflight, porting the
  chronological-history and research changes onto a pinned compatible base.
  Keep the previous study reproducible at its original commits and settings.
- Isolate the complete backend stack: agent `3031`, engine HTTP `18085`, Pekko
  `12552`, dashboard `18080`, compiling `19090`, and private infrastructure.
  Use the `texera-multiturn-mvp` Compose project, private database and volumes,
  and `/tmp/texera-multiturn-mvp` launcher state. Do not restart another stack.
- Keep research logic under `agent-service/`; launcher and engine port configuration
  changes are necessary for full isolation. Reuse the LongDS harness and data read-only. New outputs belong to an
  isolated run directory. A backend capability change is a separate experiment.

Freeze the model route, reasoning setting, operator catalog, backend identity,
context/result budgets, and source commits before each comparison. Start with
GPT-5.6 Luna. Replicate a qualified result with Terra later.

## 3. Minimal state contract

Represent analytical objects explicitly, with separate identities for source
data, computation definitions, materialized results, and published baselines.

Each artifact version records its definition version, named input versions,
parameters, schema, execution status, and the identity of any complete result.
An operator revision number alone is not a source-data version. Freeze source
files/manifests or record a verified immutable content identity.

The session also has a small mapping from active analysis names to versions.
Distinguish two dependency policies:

- **Pinned:** consume this exact historical artifact version.
- **Following:** a maintained analysis follows a declared active input or
  definition; a persistent update can create a new dependent version.

Changing an active input does not make a correctly computed historical result
false. It makes an active output due for replacement if its required inputs
have changed. Preserve old versions as history and keep published baselines
pinned. This distinction prevents a global invalidation walk from rewriting
the historical objects a later comparison needs.

Give recipes named roles such as membership, values, and definition, plus
parameter overrides. At a membership boundary, use distinct keys to select
rows from the declared value source. Validate available column-origin facts.
General recipes can define other roles; these names are not task-specific gold.

Native operations expose the contracts the runtime understands. UDFs declare
their inputs and outputs; opaque lineage remains unknown. Reuse requires known
input identity and appropriate determinism assumptions. Hidden external reads
and mutable state prevent a correctness guarantee from the input list alone.

Historical access must use a complete result or a replayable definition over
immutable inputs. A result sample or profile is never a substitute for a full
input table. Frozen baseline values must preserve what was actually published.

## 4. Milestone 1: deterministic state-maintenance prototype

Implement the smallest service-side layer that can:

1. Resolve selected artifact versions and formal recipe inputs.
2. Fork a recipe with bindings and parameter overrides in one batched request.
3. Identify the active outputs whose following dependencies changed, sharing
   unchanged versions and preserving pinned inputs.
4. Execute through the existing scheduler and promote active references only
   after the required results succeed. Existing batches may partially succeed;
   stage changes under fresh IDs so a failed branch cannot silently replace the
   active analysis. Retain explicit failure receipts and owned cleanup metadata.
5. Return a compact receipt naming consumed versions, created results, reused
   results, failures, and changes to active references.

Keep full chronological history for this milestone. The first implementation
does not add a mandatory LLM planning round. Selection, fork, overrides, and
execution can share a tool request when the required inputs are known.

### First acceptance fixture

Build one session with immutable input versions, two dependent active reports,
one independent report, a frozen baseline, and a temporary alternative.

- Compose original membership with revised values and a different saved formula.
- Issue an explicit correction to an upstream definition.
- Update the dependent active reports and verify their exact results.
- Verify that independent results, the baseline, and the temporary branch keep
  their expected versions and values.
- Exercise a failed update, stale/out-of-order result receipt, overlapping value
  column names, duplicate membership keys, and a UDF with unknown lineage.

Use independent numeric expectations and artifact invariants, then a real-backend
smoke without an LLM. Qualify full-result identity and retrieval before claiming
materialization reuse. Run relevant service tests and typecheck after changes.

**Deliverable:** an end-to-end, inspectable execution that proves these state
transitions. This is a correctness gate, not evidence of superiority to code.

## 5. Milestone 2: matched real-model state experiment

Start with three distinct short workflows: historical composition, temporary
branch isolation, and correction affecting multiple maintained outputs. Keep
the current customer diagnostic as a regression case rather than counting more
random seeds as new task families.

Use two primary arms:

| Arm | Shared capabilities | Distinct treatment |
| --- | --- | --- |
| Code | Existing persistent Code Agent and its normal Python environment | No extra function guidance, memory registry, or restrictions on its own code |
| Dataflow treatment | Native Python operators, data/flow evidence, versioned state operations | Runtime handles named bindings, version-preserving forks, and propagation across maintained outputs |

Provide the same task, data, model, execution budget, and observation budget. Each system uses its own normal state interface. Do not hand either agent evaluator dependency
labels, answers, or a solved recipe. Allow the code agent to write dependency
helpers itself; include that setup and all later work in its cost.

Record prompt placement, evidence exposure, answer serialization, and model
settings. An internal Dataflow ablation is secondary to the Code Agent comparison. Provide equivalent mechanical answer
return to code and Dataflow before scoring this comparison, with its effect
reported separately from the graph treatment. The prior study's answer-copying
failure must not be misattributed to dependency management.

For controlled repair, both agents receive the same explicit source or formula
correction. This measures maintenance after detection, not automatic discovery
of a semantic error. Natural errors and unassisted recovery are a separate
analysis; never supply corrections taken secretly from evaluator gold.

**Deliverable:** paired traces showing where version selection, propagation,
or repair differs, plus first-pass correctness and complete cost. Begin with
one full attempt per workflow and arm; apply the recovery policy below before
freezing failure comparisons. Expand only if the mechanism is visible.

## 6. Milestone 3: dependency-directed context

Once state maintenance works, add compact artifact retrieval followed by a
backward traversal from selected targets. Stop expansion at valid materialized
boundaries where the requested operation does not need the producing code.
Support explicit expansion for edits, debugging, or provenance questions.

Keep active analysis references and governing session instructions available.
Persist inspected content for the rest of the turn. Retain visible execution
receipts and failures. Earlier recall experiments lost code, values, or recalled
outputs; verify the actual input messages before any model evaluation.

Compare the qualified graph treatment with full history versus selected context.
Keep the ordinary Code Agent as the competitor. An internal graph/context ablation may identify the mechanism, but must not replace the primary comparison.

Vary unrelated intervening turns and dependency breadth separately. Count the
catalog, retrieval calls, selected content, and all cached/uncached tokens.
Context savings are useful only if they survive selection overhead. No claim
that the catalog itself remains constant as the session grows.

**Deliverable:** a context-growth/cost curve and accuracy by dependency demand,
with replay of the same turns under the matched policies.

## 7. Milestone 4: hold-out validation on real sessions

Audit LongDS request/reference-code pairs to select candidate workflows with
actual required state dependencies. Metadata labels are a filter, not proof
that a task needs graph maintenance. Run each full prerequisite history; do not
warm-start with evaluator-supplied correct intermediate state.

Proposed initial inventory: twelve distinct sessions across at least three
domains, six for development and six reserved before tuning. Include ordinary
sequential-analysis controls alongside historical composition and rollback.
Record exclusion reasons and numerically reproduce the reference answers before
admitting a task. Finalize the inventory and affordable fixed repetition count
after pilot costs are measured, before viewing held-out treatment results.

Use the original tasks for answer accuracy. Additional source-correction or
artifact-maintenance probes form an explicitly separate diagnostic extension.
Do not call modified tasks or our deterministic scoring an official leaderboard
result. Repeat held-out sessions with a fixed policy; aggregate uncertainty at
the session level, not as though dependent turns were independent tasks.

If the effect survives held-out workflows, replicate the frozen comparison on
Terra. To separate interface from runtime, a later control can expose the same
graph engine through Python; a win there supports the runtime mechanism too.

## 8. Measurement and decision rules

Primary measures:

- Answer correctness under a frozen, task-appropriate numeric/structural rule.
- State correctness: selected versions, active references, branch isolation,
  published baselines, and whether maintained outputs reflect required changes.
- Total model cost per complete session, including setup, inspection, failed
  actions, and recovery. Keep input, cached input, output, and reported reasoning
  tokens separate; avoid treating trace prose length as reasoning effort.

Mechanism measures: calls after a correction until recovery, repeated operator
authoring, stale-result reads, context size, actual executed operators/worker
requests, and elapsed time. Use execution telemetry for execution claims; a tool
receipt or requested graph is not proof of what the backend recomputed.

Record all attempts, exact prompts/effective settings, model route, source and
data identities, result provenance, evaluations, and input-timed evidence. Freeze
first-pass results. Rerun failed sessions twice in full under the same policy for
every arm, reporting recovery results and costs separately. Never select the
cheapest successful retry as the primary result. Randomize arm order and report
cache-aware costs plus a common cache-normalized sensitivity analysis.

Development gate: deterministic invariants pass, then repeated traces demonstrate
the intended mechanism on distinct workflows without a material quality loss.
An engineering target is at least 20% less complete-session model cost at equal
accuracy, or materially fewer state errors at comparable cost. This is a pilot
target, not a statistical conclusion. Held-out comparisons must report uncertainty
and cannot hide accuracy loss behind aggregate cost.

If code matches the treatment with simple helpers, retain that finding. If only
context retrieval improves, narrow the claim to memory management. If benefits
appear only after explicitly announced corrections, describe the result as
repair following detection. Broaden the study only after these limits are clear.

## 9. Immediate next work package

1. Pin the compatible parent and verify the isolated service/backend handshake.
2. Write the independent acceptance fixture and version/branch contract tests.
3. Implement named bindings, version-preserving forks, active-reference updates,
   and compact execution receipts by extending the current recipe path.
4. Demonstrate the acceptance fixture on the real backend without a model.
5. Run the six-session pilot (three distinct workflows, two arms) on Luna,
   followed by the consistent failure-recovery rounds; audit the first divergences.

Stop this work package with a reviewed mechanism report. Context compaction,
the held-out expansion, and Terra replication are subsequent milestones.
