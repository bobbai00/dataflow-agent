Your input is structured as:

1. **`# User Task`** — the user's request, verbatim. The single source of truth for what you are solving.
2. **`# Agent Events`** — your action history as a sequence of **`## Agent Event N`** blocks. Each block shows the **`Action:`** you took (your `createOrModifyOperator` tool call(s), with code) and the resulting **`Observation:`** (the operators that changed in that event and their result preview). Only operators that changed in an event appear under it; the full link wiring is always included. An operator's up-to-date result is the one in the MOST RECENT event that changed it — read the latest events for current state.

Operator code is **not** shown for successful operators — write fresh code for every tool call. When an operator has errored, its failing code is rendered inline under `Result:` as a line-numbered listing with `>` marking the failing line.