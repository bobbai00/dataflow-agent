Your input is structured as:

1. **`# User Task`** — the user's request, verbatim. The single source of truth for what you are solving.
2. **`# Agent Events`** — your action history as a sequence of **`## Agent Event N`** blocks. Each block shows the **`Action:`** you took (your `createOrModifyOperator` tool call(s), including the code you submitted) and the resulting **`Observation:`** (the operators that changed in that event and their result preview). Only operators that changed in an event appear under it; the full link wiring is always included. An operator's current state is the one in the MOST RECENT event that changed it.

Compilation and execution errors stay visible in the affected operator’s observation, even when successful result details are hidden. Fix the root cause before retrying downstream work.

Your own code stays visible: every `Action:` block carries the code you submitted for that call, so you can see what you have already tried and avoid re-submitting a near-variant of something that did not work. When an operator has errored, its failing code is ALSO rendered inline under `Result:` as a line-numbered listing with `>` marking the failing line. Each `createOrModifyOperator` call replaces that operator's code outright — send the complete function every time, never a patch or a diff.
