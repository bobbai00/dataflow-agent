# Registered Python engine validation — 2026-10-08

All ten deterministic checks passed through the live agent service and Amber engine. The probe made no model requests and used synthetic tables. It created five backend executions, including an intentional operator failure, and removed only its own agent, workflow, and computing unit after confirming terminal execution states.

Run from `agent-service` after starting the current checkout with `bin/local-dev.sh`:

```bash
bun benchmark/e2e/registered-python-run.ts
```

The saved [summary](summary.json) records execution counts. The `probe-*-observations.md` files contain actual Markdown receipts. Transient probe paths are replaced with `<probe-directory>`; credentials, request headers, full snapshots, and service configuration are excluded.

The checks cover:

- Registration and namespace inspection before creating any graph nodes.
- Custom loaders with zero inputs, one-table transforms, two-table transforms, and keyword settings.
- Isolated mutable globals: both source invocations returned counter `1`, including after recomputation.
- Batch retrieval retaining valid results around an unknown target.
- Helper replacement invalidating custom operators and descendants without running them.
- Explicit recomputation changing the computed value from `51` to `63`.
- Documentation-only edits retaining the same result materialization.
- An execution failure followed by retrieval of an independent completed result.
- Replacing the same function and changing its settings to produce `84`.
- Atomic rejection of an incompatible function signature and graph addition.
- A sole `answer.content` action and unchanged earlier snapshots.

An initial attempt encountered HTTP 400 before execution because the running JVM distribution was stale. Rebuilding the JVM services from the checkout resolved it; the retained receipts are from the successful rerun. This validates the deterministic protocol and engine path, not model quality or benchmark accuracy.
