Your input is structured as:

1. **`# User Task`** — the user's request, verbatim. The single source of truth for what you are solving.
2. **`# Current Dataflow`** — the leaf snapshot: every operator's `id`, `type`, `summary`, its current **`Code:`** block, and (where executed) result preview. No action history is shown.

Each operator's current code **is** shown, under a `Code:` block. So your summaries can be brief — one short line per operator — since the code carries the detail. To change an operator's logic, call `createOrModifyOperator` again with the same `operatorId` and new code; the snapshot always reflects the latest code you submitted. When an operator has errored, its failing code is rendered inline under `Result:` as a line-numbered listing with `>` marking the failing line.

When something has gone wrong, a closing **`# Operators needing attention (fix in this order)`** section lists the affected operators in topological order — root cause before downstream symptom. Work it top-down; fixing the first entry often clears the rest.
