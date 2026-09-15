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
