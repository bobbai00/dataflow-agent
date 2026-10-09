# C7: matched Terra arms, live qualification and pilot results

## Final checkpoint: 2026-09-15

Completed on candidate `1c12044149da5a17c5c2f32c940c962762583133` and harness
`1929be6841a9a7ff2ad9b7c87d2abdc7168d64c5`, descended from batch/observe
`41cd8ae97e30edfec90c847886ed4068dd0fa9b0`. Both exact `gpt-5.6-terra` and
`gpt-5.6-luna` used verified **medium reasoning**. The shared candidate master
was updated/restarted with the user's permission and remains on 8085.

The [completed 14-attempt report](../../benchmark/Kramabench/judgment_runs/native_python_dataflow_20260915/REPORT.md)
contains all seven arms for both models on `environment-easy-3`, one official
attempt each. Every attempt is scored, comparison-eligible, and cleaned up;
none was replaced. All 67 recorded backend requests compiled/executed, while
nine Luna V2Control edits failed earlier argument validation. Total scored
token cost was $0.239003 (cache-aware estimate, excluding qualification).

BatchParent answered correctly on both models and was 24.7% cheaper on Luna,
33.8% on Terra than V1Reference in this pilot. Data-only/flow-only/combined
all answered 267 instead of 268; they do not demonstrate an accuracy benefit.
The trace-backed report identifies wrong entity grouping, evidence budget/
visibility limits, and Luna's invalid nested Derive arguments. No gold-specific
fix or full campaign was added; V2/evidence remains opt-in.

Final checks: **1,129 Bun tests**, typecheck, **184 harness tests**, six live
worker suites/**20 DELTA/LATEST mode-setting cases**, and actual Terra-medium
four-turn model smoke in both modes pass. Source/runtime-bound worker proof:
`/tmp/native-python-live-master.i9nfol/campaign-5/worker-gates/worker-gates.json`.
Final real-model proofs and all official owned-session records:
`/tmp/native-python-live-master.i9nfol/campaign-6/`. A sanitized hash-bound
[qualification summary](../../benchmark/Kramabench/judgment_runs/native_python_dataflow_20260915/qualification.json)
is committed with the report. Isolated agent ports 3011/3012/3013 are stopped;
the shared backend is preserved.

LATEST remains functionally correct but inefficient on the smoke's cached
turn: six identical reads, five redundant, versus one read in DELTA. All had
the original materialization/rows and no additional execution. Harness `1929be6`
documents the pre-official-dispatch change from a universal one-batch assertion
to a separate repeated-cache-read metric, strengthening per-read identity
checks. Mutation turns still require one batch. Earlier failed smoke reports
were preserved and new smokes were run; they were not reclassified as passes.

The latest-action receipt change retains one bounded current-task status/target
receipt without parameters or hidden table/error content. It complements the
LATEST-only completed-snapshot prompt and leaves DELTA unchanged. This fixes
the missing action-completion signal, not the remaining read redundancy.

## Earlier implementation and live-qualification log

2026-09-15, `feat/native-python-dataflow`, harness
`8c5a6af0de5f5aaf50919a80647052b389340cc7`.

The seven Luna arms now have seven separately named, matched Terra arms.
Use exact `gpt-5.6-terra` with **medium reasoning**; `tara` is not a substitute.
The candidate gateway templates add Terra without removing existing routes.
Both model manifests freeze their own cache-aware token-price schedule.
The full harness passes **178 tests**. New E2E cleanup tests pass and agent
typecheck passes; ambiguous debug timeouts cannot authorize resource deletion.

The candidate engine package contains 410 JARs. Its build/runtime binding
checks cover the actual classpath, worktree, generated Python protos, default
worker interpreter, process start and boot identity. These are provenance
checks, not functional proof. With explicit user approval, the shared compute
master was restarted using the supported launcher and bound to the candidate
build on port 8085. The launcher is isolated under
`/tmp/native-python-live-master.i9nfol/launcher`; private runtime evidence is
under that directory's `evidence/` sibling. Other JVM services were not bounced.

Next: matching-worker fixtures in DELTA/LATEST, actual model input audits,
then the one-task official pilot. Prioritize the no-evidence/data-only/flow-only/
combined factorial for Terra and Luna, followed by collector/framework controls.
No benchmark score, cost or optimization benefit is claimed at this checkpoint.

Live follow-up: Python-native and core worker suites passed in both modes.
The evidence suite exposed an empty debug preview: the production SDK context
assembler was always async, even with the LLM tuner disabled, so the synchronous
preview returned an empty cached value. A failing regression reproduces this;
the untuned path is now synchronous while the opt-in tuner remains async.
**1,124 Bun tests and typecheck pass** after the fix. The worker matrix is
being rerun against the changed agent source before model/benchmark admission.

Further live checks exposed two more readback defects: previews kept only the
first message of a native transcript, and the settings API omitted the applied
`messageLayout`. Both have regression tests. At root `81b80e980296c7757e796124445e3ad00014c850`,
all six matching worker suites passed (20 mode/setting cases) and Terra-medium
passed all four DELTA model-smoke turns, including input-timed observation and
revision-pinned error inspection. Owned test resources were cleaned up.

The LATEST real-model smoke failed: it rebuilt the correct three-operator batch
25 times without answering. Actual model inputs contained the correct observed
rows, so this is not a missing-table failure. The candidate now adds LATEST-only
prompt guidance that the snapshot is completed work, and a visible current
result can support a direct final answer. DELTA and V1 prompts are unchanged.
**1,127 Bun tests and typecheck pass**; the failed live attempt is preserved under
`/tmp/native-python-live-master.i9nfol/campaign-2/model-smoke-latest`.
Matching-build worker/model gates must pass before official pilot dispatch;
no official benchmark first attempt has been consumed at this checkpoint.

The prompt-only change made LATEST's chain complete in two model steps, but
the cached-read turn still repeated. LATEST now also retains one bounded,
current-task last-action receipt: accepted/rejected edit statuses or the cached
observe/inspection target, with no parameters, rows or diagnostic body. It is
not a trajectory replay and does not claim tool completion means execution
success. A new user task clears the receipt; DELTA is unchanged. Regression
tests exercise rendering, task boundaries, pending calls, privacy and bounds.
The failed cached-read smoke is retained under `campaign-4/model-smoke-latest`;
all its resources and the isolated service were verified cleaned up.
