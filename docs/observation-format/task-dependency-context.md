# Task dependency context

The agent can retain ordinary ReAct within a task while replacing previous
tasks' tool trajectories with a compact task index. Enable it with:

```json
{
  "agentMode": "native",
  "contextMode": "delta",
  "messageLayout": "native",
  "stateHistory": true,
  "stateLedger": false,
  "taskContext": "dependencies"
}
```

The default remains `taskContext: "trajectory"`. The new policy is opt-in and
rejects incompatible compaction, ledger, selector, and alternate context
policies. A first or single task assembles exactly the same messages under
either policy when other settings match.

Each new task starts with the questions, agent-generated answers, operator
names, and observed dependencies of earlier tasks. Answers longer than 1,200
characters are explicitly clipped in this index. The full question and answer
remain available through `{type: "inspect", target: "task", task_id: N}`.
That action returns an operator index with revisions, inputs and result
availability; it does not dump implementations or tables. Existing state
inspection retrieves selected operators' saved definitions/results, and
existing fork/restore commands reuse them. The current task keeps its ordinary
tool-call and tool-result frames. Its prior-task checkpoint remains immutable
while those frames accumulate, preserving the within-task prefix.
Earlier questions retain their initial native message frames, each followed by
an immutable assistant message containing that task's answer and dependencies.
Adding a task therefore preserves older message boundaries and the previous
initial question prefix. The first transition to the compact index still
changes the prefix; cache reuse is measured rather than assumed.

Dependencies come from structured action-time access receipts, not a
model-maintained ledger. Execution and result reads bind operator revisions,
result versions, subgraph hashes and producing steps when available. Cached
results retain their original producer. Definition reuse is tracked separately
from recomputation on changed inputs. Explicit saved-task reads, forks and
restores bind the requested task version. Task inspection is a consultation,
not a computational dependency. Failed edits/skipped actions do not create
edges; independently completed results from a partially failed execution can.
Incomplete tasks remain labelled incomplete and never gain an invented answer.
Requests that fail before an agent action remain inspectable as incomplete
tasks; they retain their question and the inherited state before any action.
The read-only `GET /api/agents/:id/task-history` endpoint exports the graph.

An edge records observed access, not proof of semantic dependence or a correct
answer. Text-only reuse and unrecorded external state cannot be inferred from
operator references. Unknown provenance stays unknown. Questions and answers
still grow linearly with the number of tasks; this policy removes old tool
trajectories, not all growth. The original trajectories and snapshots remain
stored, so it reduces model input without claiming a storage reduction.

## Verification and evaluation

Unit tests cover producer identity, definition/data separation, consultations,
failed/skipped actions, incomplete tasks, loaded-task numbering, clipped
answers, tool availability, incompatible settings, stable within-task prefixes,
and exact first-task parity. The live `task-context-run.ts` fixture exercises
five tasks through the real engine with no model calls: cached sums, changed
inputs, historical inspection, fork, restore and deletion. Resources allocated
by the fixture are removed only after confirming terminal execution.

The matched pilot is frozen by `benchmark/longds/task_context_verification.py`.
Both policies run the same saved runtime, prompt, tools, model, data and limits;
only `taskContext` differs. Two complete LongDS sessions (35 and 30 questions)
and one KramaBench single-task case run three independent repetitions per
policy. All attempts and spend remain in the report; no best-of or selective
solver replay. Source, prompt, data and reference-component rubric hashes are
recorded before paid calls. This is exploratory evidence on previously studied
sessions, not a benchmark-wide claim or a fresh comparison against DSGym.

Official LongDS binary judgments and KramaBench scores remain unchanged.
Additional diagnostics cover context size, cache hits, model calls, latency,
execution outcomes, history actions and task-reference provenance. A separate
strict JSON-leaf agreement metric reports the fraction of reference fields
present/correct, with fixed reference-based numeric tolerances and ordered
arrays. It requires reference field names, so equivalent answers with different
keys can score poorly; it is a format-sensitive diagnostic rather than a
semantic partial-accuracy score. Mechanical errors are counted for every turn;
state/semantic/cascade root causes require manual trace evidence and confidence.

The completed pilot, cache refinements, verification outcomes and manual error
audit are recorded in
[the verification report](../../benchmark/longds/reports/task-context-verification-20261004.md).
The original experiment reduced context substantially but did not establish an
accuracy improvement and increased cost. The report keeps paid runtime
revisions separate from later fixes. Keep this policy opt-in while evaluating
retrieval overhead and semantic accuracy on additional sessions.
