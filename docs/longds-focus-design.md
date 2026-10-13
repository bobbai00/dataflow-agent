# LongDS: a directory of tasks and a working set of focused tasks

Design and first implementation, 2026-10-12, branch `feat/longds-focus`. This
is the simplification of [the working-context design](longds-working-context-design.md)
that keeps its two properties — the context selects only the analysis a
request builds on, and the input stays small whether or not the prompt cache
survives — and drops the rest. It supersedes
[the task-expansion proposal](longds-task-expansion-proposal.md).

## 1. What is kept and what is dropped

| From the working-context design | Here | Why |
|---|---|---|
| Directory of every operator, a selected working set, the current request | kept: the whole idea | the selection is what makes the context small and relevant |
| Model-chosen focus, inherited across requests | kept, as a plain statement among others | only the model knows which stage it needs |
| Operator packets with source, full schema, sample, boundary inputs | kept (the renderer in `agent/working-set.ts`) | conventions live in code: entries with function source scored 43 against 31 without, on the same 92 requests |
| Versioned references `scores@5`, resolver, artifact retention, historical read path | dropped | agents never overwrite (0.01 updates per task in both arms; the Lite gold audit found no rollback that needs overwritten state); the current graph holds every state under its own name, and a `(set again in task 9: …)` note covers the rest |
| Continuation note, transcript segments, mid-request archiving | dropped | one segment per request; the request's own transcript is 2–4k tokens and the entry carries its outcome |
| `needs_focus` controller, context-pressure mode | dropped | a working set over budget loses its samples, then says so; a focus naming too many tasks is refused with the limit |
| Paging cursors, resource handles | dropped | `show schema x from N`, `show result`, `show function` exist |
| Checkout and branch reconstruction | dropped | sessions are linear |
| Focus as the sole statement of its call | dropped | it cost a call per refocus; the set is rendered at the next model call anyway |
| Four budgets | one cap on the working set (16k characters) | the directory is append-only and the request transcript is bounded already |

## 2. The context

```
[system prompt]
[U1][E1] … [U(r−1)][E(r−1)]   directory: each earlier task's text and its entry
[W(r)]                        working set: the focused tasks in full
[U(r)]                        the current request
[call 1][receipt 1] …         this request's calls
```

**Entry E(k)** (`catalogSource: "ledger"`): the functions task k registered,
as signatures with docstrings; one line per operator it set — the statement,
rows × columns, columns relative to its input's where shorter, `(updated: …)`;
`deleted:`; `built on: task 1, 2`; the answer as a depth-one preview. About
250 tokens.

**Working set W(r)** (`focusTasks`, default 5 in the arm), rendered from the
current graph at every model call:

```
## Working set: task 2, task 5
### Task 5
request: <the task text, verbatim>
functions:
- `protection_picture(view, *, exposure_weight=0.1)` — <docstring>
<source>
operators set here:
- `set protection: protection_picture(combined_player_view)` (set again in task 9: `set protection: …`)
  reads: `combined_player_view` (task 2, above)
  result: 86 rows × 30 columns; columns: player str, team str, … (every column)
  <sample: the whole table when ≤ 12 rows, else 3 rows>
answer: <the reply, verbatim>
reads from earlier tasks: `season_workspace` (task 1; focus task 1 for its rule)
read by later tasks: `protection` → task 8 (`refined_scored`)
```

Boundary, not closure: an input from another task is one line with its origin
and shape; the ancestor closure averages 7.6 operators and reaches 14. When
the set exceeds 16k characters the samples go first, then it says "focus
fewer tasks".

## 3. Selection

- `focus task 3, 7` replaces the set from the next call; `focus
  protection_picture` names a task through one of its operators. The
  statement sits in any call beside `set` and `show`; nothing else about the
  call changes. The choice is kept in the workflow content (`nativeFocus`), so
  it is versioned with the snapshots and inherited by later requests.
- At each request the set is the stored choice plus the previous task, cut to
  the limit by dropping the task used least recently: a task's last use is the
  latest request whose statements mentioned one of its operators, or the
  request that focused it. No semantic selector.
- Nothing is hidden: every operator is in the directory, and `show result`,
  `show schema` and `show function` reach anything, as before. Replies are
  text.

## 4. Cost, in tokens and in dollars

Per call at request 40: system 4.3k + directory (~160 tokens per task, 6.4k)
+ working set (~3k) + the request and its transcript (~3k) ≈ 17k, against the
ledger's ~25k, K=5's ~35k and smolagents' ~90k at the same point. Over a
session, about 28k input tokens per request against 42k, 75k and 68k.

Under this provider's cache the working set sits between the directory and
the request and changes every request, so at a request's first call only the
system prompt is reused (5.9k of 9.7k in the smoke); later calls in the
request reuse the earlier ones. Fresh tokens therefore cost more than the
ledger's; the arm is measured in both tokens and dollars, and the dollar
figure is the one that depends on the provider.

## 5. Evaluation

Luna, the eight Lite sessions, one rep, judged: `focus` against the ledger
run, hybrid K=5 (three reps) and smolagents (three reps) on the same
requests. Per arm: accuracy by session and by request position; input tokens
and their cached share; cost split into fresh, cached and output; calls per
request; focus statements per request, the tasks chosen and how far back;
working-set size; look-up calls; Python tokens per request as the rebuild
measure. Root `/var/tmp/longds-focus-luna-20261012`.

## 6. Implementation

- `types/agent.ts`, `native/settings.ts`, `server.ts`: `focusTasks`
  (0–20; needs `multiRequest: "catalog"`), decided before the first request.
- `types/workflow.ts`, `workflow-state.ts`: `nativeFocus` carried like
  `nativeNamespace`.
- `native/turn-syntax.ts`, `tools/dataflow-actions.ts`,
  `tools/dataflow-action-runtime.ts`, `native/turn-receipt.ts`: the `focus`
  statement, action, validation and receipt; the runtime learns the current
  request number and each operator's origin task from the agent.
- `agent/working-set.ts`: `effectiveFocus` and `renderWorkingSet`;
  `util/context-utils.ts` places the set in the catalog layout;
  `request-catalog.ts` exports its helpers and adds `built on`.
- `prompts.ts`: the layout paragraph and the `focus` statement line;
  `benchmark/longds/run_session.py`: arm `focus`.
