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

Each new task starts with the questions, agent-generated answers and parent
task IDs of earlier tasks, plus their declared answer-table IDs. Operator lists
and access receipts stay outside the default model index. Answers longer than 1,200
characters are explicitly clipped in this index. The full question and answer
remain available through `{type: "inspect", target: "task", task_id: N}`.
That action returns the local computation behind declared answer roots:
operators introduced or changed for the answer, including affected downstream
steps. Unchanged earlier computations become versioned input references with
their owning task, operator ID, revision, availability, row count and scope.
It excludes unrelated branches and deduplicates shared inputs. The default
read returns local expressions, ports, schemas, availability and scope;
local implementations and selected root-result rows are opt-in:

```json
{"type": "inspect", "target": "task", "task_id": 1,
 "operator_id": null, "include_implementation": true, "view": "sample"}
```

Null roots use declared answer sources. Named roots select an intermediate
branch at that task's endpoint. Views follow the session's retrieval choices
and budgets; only root results are retrieved. Neither inspection executes nor
changes the current graph. Existing fork/restore commands reuse saved branches.
Expand an input reference with its owning task and operator ID, or inspect the
saved operator and its direct inputs. A task can contain no local operators
when its answer simply reuses an earlier result. Missing earlier results stay
explicitly unavailable; they are never fabricated. Matching considers incoming
computation fingerprints and result identity, so a changed upstream or fresh
materialization cannot be hidden just because downstream definitions are
unchanged. Restoring an older computation remains local if it differs from the
immediately preceding task. An answer read directly from an older saved version,
including through a fork, is represented as a saved input to the answering task.
The full provenance and saved graphs remain on the server.

In multi-task sessions, `inspect target="graph"` requires `operator_ids` and
returns only those current operators with direct input references. The task
index provides discovery; whole-session graph dumps are not exposed by the
multi-task tool schema. Single-task sessions keep unscoped graph inspection.
The current task keeps its ordinary
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

With saved-state tools enabled, free-text Answer accepts optional
`operator_ids` (one to eight unique IDs). The runtime checks that every named
table exists and has a completed result before recording any declaration.
Structured Answer `from` records its roots automatically. Explicit answer
roots take precedence over exploratory reads. Older/free-text answers without
roots list prior result reads labelled `observed_reads` candidates. They do not
automatically expand candidate graphs or attach their result tables, even when
a view was requested. Select a candidate operator explicitly. Superseded
reads are excluded, and missing roots produce an explicit note and the saved
operator index instead of a guessed branch. Access receipts bind reads to
their snapshot and result version; incompatible saved versions remain separate
sub-DAGs. Later edits and deletion do not redirect a read to the live graph.

The system prompt explains the mechanism with generic examples. It asks the
agent to check filters, joins, units, grouping and coverage before reusing a
branch; select a complete intermediate table when the previous report was
limited; repair a faulty step and recompute downstream; and preserve baselines
when comparing versions. The runtime checks provenance and availability, not
semantic correctness. Benchmark dependency annotations are never solver input.

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
inputs, five local operators with a pinned earlier input, selective expansion,
scoped graph inspection, historical inspection, fork, restore and deletion. Resources allocated
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

The subsequent [saved sub-DAG pilot](../../benchmark/longds/reports/task-subdag-pilot-20261004.md)
records the new one-call retrieval, Answer source declarations and generic
prompt examples. A five-question prefix scored 5/5 under both policies, with
smaller thin context but more model calls and nearly identical estimated cost.
It verifies the mechanism without establishing a broader accuracy improvement.
