# C7: matched Terra arms and live runtime handoff

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
