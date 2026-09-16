# Task history for native Dataflow

Research branch based on `refactor/evidence-only-context` (`c5620b9b4`).

## Contract

Each user request is a numbered **task** in the current session. Native inputs
accept either a current operator id or `{operator: "total", atTask: 1}`. The
qualified input reads the actual complete output recorded at task 1's end.
Task numbers are runtime assigned. No model-generated result ids, save calls,
report registry, or workflow checkout are needed.

The agent records bindings automatically. The engine copies complete results
to immutable Arrow files before later edits can evict their caches. The copy
includes the table schema, empty tables, nulls and exact int64 values. A checksum
is checked when a historical source executes. Unchanged result identities share
one retained file. The initial implementation supports native scalar tables.

The service resolves a qualified reference to an internal source operator. Its
graph has no live edge to the original producer. Updating that producer therefore
recomputes its current descendants while leaving historical consumers unchanged.
Historical and current inputs can be combined in one normal batch. Runtime source
ids and file paths are hidden in the task context; the agent uses operator names
and task numbers. Historical UDF inputs bind positionally, with model-chosen
Python parameter names.

Missing, failed, or unretained outputs fail explicitly. A failed current edit
blocks current dependent results; it does not invalidate earlier retained data.
The existing partial-success batch semantics remain: this feature does not add
transactional workflow rollback. It also cannot infer whether the model selected
the intended population, formula, or historical task.

## Independent experimental settings

All default false and require native batch catalog V2:

| Setting | Purpose |
| --- | --- |
| `nativeCompactPrompt` | Generated catalog semantics and a fully typed wire schema with repeated descriptions removed. Runtime validation stays strict. |
| `nativeDirectReturn` | Optional `return:{operator,format:"records"\|"columns"\|"row"\|"value"\|"json",column?}` finishes with complete successful JSON data from the same batch. |
| `nativeTaskContext` | Prior requests/answers, compact current operator catalog, current-task observations, and complete definitions of selected dependencies. |
| `nativeTaskHistory` | Automatic full-data retention and `atTask` inputs. Must be selected before the first task/operators. |

`return` implicitly observes the answer operator. Errors, truncated tables, and
ambiguous scalar/row requests continue the normal repair loop. The model can
still answer in prose. Direct return is a general agent optimization; the
dependency boundary is the Dataflow-specific mechanism under investigation.
`columns` returns an object of column arrays. `json` validates and returns an
entire JSON document stored in one string cell, preserving its exact numeric text.
Ordinary string cells are never silently decoded. Successful engine cache hits
are eligible both for direct return and for historical retention.

Direct return also follows the output's input graph and refuses outputs derived
from `Scan.preview`, which is a raw discovery probe. An aggregate can contain all
of its output rows while still using only five lines of its input file. Preview
origins are retained with historical data, so changing today's scan cannot make
an old partial output appear complete. Ordinary `Filter`/`Limit` operations remain
valid analytical choices. This checks known discovery sources; it does not infer
the user's intended cohort, inspect arbitrary Python file reads, or prevent an
unverified prose answer. Preview observations remain available for inspection.

Task context preserves prior user requests and answers. It does not replay prior
tool actions/reasoning. Catalog cards include input references, a bounded
definition preview, current schema/status, and available historical task ranges.
Normal edits and `observe` select operators; the renderer follows their actual
ancestors for full definitions and stops at historical sources. There is no
mandatory extra context-selection inference. UDF internals remain opaque.
Completed tasks form stable user/answer message pairs. Current graph context
comes next, then the active request and its actions/observations. This permits
prefix caching and leaves the actual observation last during a task.
Definitions use the public operator syntax (`filter`, `input`, `left`/`right`).

## Scope and lifecycle

- Agent session bindings currently live in memory. Restart/clear/import does not
  reconstruct them. Historical files alone do not imply a restorable session.
- `TEXERA_TASK_RESULT_DIR` must name an engine-owned directory visible to that
  engine's Python workers. This milestone targets the isolated local stack;
  distributed object storage and retention quotas/garbage collection are future work.
- Files survive cache eviction and workflow cleanup, until the experiment's
  archive directory is cleaned up. Storage/time costs are reported separately
  from model cost. Only scalar native tables are retained; opaque binary UDF
  objects fail retention explicitly.
- Task selection remains model reasoning. The engine enforces exact historical
  identity and graph dependencies, not the scientific meaning of a task.

## Isolated stack

The supported launcher is used with `/tmp/texera-task-history/profile.sh`.
Agent `3041`, engine `28085` / cluster `22552`, web `28080`, compiler `29090`,
Postgres `25432`, MinIO `29000`, LakeFS `28000`, and LLM proxy `24000`.
Docker project/volumes/network: `texera-task-history`.

Rebuild engine changes through `bin/local-dev.sh up texera-web --build`;
`computing-unit-master` shares that distribution and has no separate build.
Set `TEXERA_LOCAL_DEV_PROFILE` on every launcher invocation.

## Validation and experiment protocol

Tests cover immutable references, absent/failed history, graph boundaries, complete
Arrow tables, exact int64/null/empty data, strict direct return, selected context,
and settings validation. A live smoke replaces source bytes, edits the current
source/cohort, consumes a historical middle row outside every saved preview, joins
original membership to current values, and checks failure isolation.

Primary comparison: six diagnostic sessions / 50 user tasks, fresh persistent
smolagents CodeAgent versus native Dataflow, GPT-5.6 Luna, 25 model steps per task,
2,000-character result/print budgets. CodeAgent's one-operation and reusable-function
instruction presets are disabled; Python can freely batch and naturally reuse state.
The six families include old cohort/new measurements, corrections across reports,
temporary scenarios, customer rankings, a 20-task correction session, and independent
tasks as a negative control. These are diagnostic fixtures, not a representative
LongDS score. Dataset seeds are not additional task families.

Both arms receive the same task text. Gold remains evaluator-only. Numeric JSON
scoring uses exact keys/order and absolute numeric tolerance 0.0001. Compare complete
primary sessions; run two additional fresh recovery sessions for each failed session
in either arm, reporting their costs separately. Never replace primary failures.

Ablations on membership and temporary-scope sessions add compact catalog, direct
return, task context, and history in order. Attribute changes using actual traces,
not aggregate token counts alone. Model cost uses the repository's Luna rates
(input $0.20/M, cached input $0.02/M, output $1.20/M), with reasoning already included
in output. These are accounting assumptions, not invoices. No universal cost or
accuracy advantage is assumed.

The initial development campaign exposed three interface problems: a missing
`CompletedFromCache` success case, internal rather than public catalog syntax,
and a loose compact wire schema that discarded nested type constraints. Those
runs are retained separately from the corrected milestone. The 20-task fixture
also originally said "per shipped unit"; the corrected version explicitly
includes returned units in the handling-cost denominator for both agents.

`prepare-task-longds.py` prepares the real 15-task GitHub-language session with
the original public questions and explicit JSON formats shared by both arms.
It omits no requested quantities and gives neither arm answers or dependency
annotations. This is an adapted diagnostic, not an official LongDS score.
Its gold Python reproduces 15/15 published answers after supplying the missing
notebook display helper `format_decimal_json` as an identity function (upstream
already rounds before that helper).

Reproducible runners (source the isolated profile first):

```bash
python3 agent-service/benchmark/multiturn/task-study.py generate /tmp/new-fixtures
python3 agent-service/benchmark/multiturn/run-task-study.py \
  --fixtures /tmp/new-fixtures --out /tmp/new-campaign \
  --kb-root /path/to/benchmark/Kramabench --env-file /path/to/.env
```

The coordinator records fixture hashes, revision, per-session traces, usage,
primary results, and two fresh recovery sessions for every failed primary
session. It refuses to overwrite artifacts. Keep the watched agent service's
implementation fixed until the campaign finishes.
