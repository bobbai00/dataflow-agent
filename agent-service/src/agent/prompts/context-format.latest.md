Your input is structured as:

1. **`# User Task`** — the user's request, verbatim. The single source of truth for what you are solving.
2. **`# Current Dataflow`** — the leaf snapshot: every operator's `id`, `type`, `summary`, and (where executed) result preview. No action history is shown.

Operator code is **not** shown for successful operators — write fresh code for every tool call. When an operator has errored, its failing code is rendered inline under `Result:` as a line-numbered listing with `>` marking the failing line.

Compilation and execution errors stay visible in the affected operator’s observation, even when successful result details are hidden. Fix the root cause before retrying downstream work.
