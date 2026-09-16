# Task-qualified Dataflow: first research milestone

Implementation: `feat/task-history-dataflow`, based on evidence-only-context
`c5620b9b4`. Evaluated service revision: `f6d70360a`. Model: GPT-5.6 Luna.

## Result

The historical-input and dependency mechanisms work, but **this milestone does
not beat ordinary CodeAgent on overall cost or accuracy**. Do not promote it as a
cheaper default. The experiments identify a useful correctness contract and show
where the current interface still makes the model do unnecessary work.

| Primary sessions | CodeAgent correct | Dataflow correct | CodeAgent model cost | Dataflow model cost | Code / Dataflow calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Six diagnostic sessions, 50 tasks | 49/50 | 46/50 | $0.031794 | $0.068910 | 62 / 93 |
| Adapted real LongDS GitHub session, 15 tasks | 15/15 | 14/15 | $0.016330 | $0.025780 | 19 / 19 |

Dataflow costs **2.17×** CodeAgent on diagnostics and **1.58×** on the real-data
session. The latter has one field-name error (`name` instead of the requested
`language`); its computed values are correct. Diagnostic failures are three
wrong profit formulas and one timeout. CodeAgent's diagnostic failure applies
the current eligibility rule to an original-publication comparison.

Costs use recorded usage and the repository's Luna accounting rates:
$0.20/M uncached input, $0.02/M cached input, $1.20/M output. Reasoning is already
included in output. These are estimates, not provider invoices, and exclude
engine/storage cost. Usage missing after a timeout is not counted as free work;
the affected Dataflow cost is a lower bound. Primary failures stay in these
numbers; fresh recovery sessions are reported separately below.

## What was built

The public state reference is an existing operator plus an optional task:

```js
input: "eligible_customers"                           // current calculation
input: {operator: "eligible_customers", atTask: 1}    // task 1's actual output
```

Each user request starts a runtime-numbered task. At its end, the engine retains
complete materialized tables as Arrow files; the agent records the task/operator
bindings. A qualified input becomes an internal immutable source with no live
edge to today's producer. The model never names those internal sources or paths.
There are no save/checkout calls or new public result identifiers.

For example, changing the current eligibility threshold updates all current
reports. Joining `eligible_customers atTask:1` to today's measurements evaluates
the original membership using new values. Reading `summary atTask:1` returns the
original publication, even after the source file and current operators change.
The engine enforces those dependency boundaries instead of relying on the model
to remember every Python alias and copy.

Other implemented pieces:

- **Dependency-selected context:** prior requests/answers, a bounded operator
  catalog, and full definitions of selected operators and their ancestors.
  Selection uses ordinary edits and observations; it adds no selection-model call.
- **Direct return:** a batch can return an already computed complete result,
  avoiding a separate model call to copy the answer. Interpretation can still be
  prose. This is a general agent optimization, not a unique Dataflow advantage.
- **Input-coverage check:** direct return follows dependencies and refuses an
  answer derived from a raw `Scan.preview` probe. Historical tables retain that
  provenance too. This checks an explicit operator property, not whether a
  formula or user-selected cohort is scientifically correct.
- **Compact typed catalog:** generated semantics plus a fully typed tool schema.
  Runtime validation remains strict; removing nested type constraints in an
  earlier attempt caused extra repair calls.

All four experimental settings default off. See
[the implementation guide](../../../docs/task-history-dataflow.md) for the API,
context layout, flags, and lifecycle limits. The default agent was not changed.

## Fairness and scoring

Both arms use the same public task text and files, a persistent session, Luna,
25 steps per task, and 2,000-character observation/print budgets. The CodeAgent
runner uses the existing smolagents wrapper with the custom, fine-grained, and
pitfall prompt presets disabled. It may batch arbitrary Python and naturally
define functions. There is no special reusable-function comparison arm.

Gold answers are evaluator-only. Scoring checks all requested keys, array order,
and numeric values with absolute tolerance 0.0001. JSON-looking strings are not
silently converted into nested objects. Exact answer-format mistakes therefore
count as failures, and are distinguished from numerical mistakes in this report.

The six small sessions are mechanism diagnostics, not independent samples of a
large population. The 20-task fixture explicitly includes returned units in the
handling-cost denominator. Earlier ambiguous wording is excluded from final
comparisons. The LongDS session uses the original public questions with explicit
JSON formats supplied equally to both arms. Its reference Python reproduces
15/15 answers after restoring a missing notebook display helper. This is an
adapted diagnostic, **not an official LongDS benchmark score**.

## Diagnostic breakdown

| Session | Tasks | Code correct | Dataflow correct | Code cost | Dataflow cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original membership / new values | 5 | 4 | 5 | $0.002888 | $0.004699 |
| Temporary scope | 5 | 5 | 4 | $0.003775 | $0.006363 |
| Correction across reports | 5 | 5 | 5 | $0.002425 | $0.006555 |
| Customer reports | 9 | 9 | 9 | $0.010306 | $0.018613 |
| Repeated corrections | 20 | 20 | 17 | $0.010008 | $0.028012 |
| Independent control | 6 | 6 | 6 | $0.002393 | $0.004668 |

Of the 50 paired tasks, CodeAgent alone passes four and Dataflow alone passes
one. Both pass 45: CodeAgent is cheaper in 42, Dataflow in three. The historical
cohort win is useful trace evidence, but not proof of a general accuracy gain.

## Why Dataflow still costs more

| Diagnostic usage | CodeAgent | Dataflow |
| --- | ---: | ---: |
| Calls | 62 | 93 |
| Uncached input tokens | 24,503 | 165,991 |
| Cached input tokens | 264,182 | 394,528 |
| Output tokens, including reasoning | 18,008 | 23,184 |
| Reasoning tokens, subset of output | 4,978 | 8,394 |
| Uncached input cost | $0.004901 | $0.033198 |
| Cached input cost | $0.005284 | $0.007891 |
| Output cost | $0.021610 | $0.027821 |

Most of the extra cost is uncached input. Many Dataflow requests report only
the approximately 4,256-token static prefix as cached; CodeAgent's cached history
grows through the session. Completed task messages are stable in the new context,
but that has not produced the expected cache benefit in these runs. A six-call
endpoint probe confirmed that identical requests can cache beyond the static
prefix and that changing `developer` to `system` did not fix the difference.
The precise cause remains unresolved; do not credit a hypothetical cache saving.

Additional calls are also avoidable. In the long correction session, the model
repeatedly emits `format:"json"` without the required `column`, then makes another
call to add `column:"answer"`. It also creates JSON-serialization UDFs when the
existing one-row aggregate could be returned with `format:"row"`. These are
interface and prompting failures, not inherent requirements of a dependency graph.

## Trace evidence

Paths below are relative to the retained artifact bundle.

1. **A real historical-state distinction.** In
   `v2-code/code-membership_values/t05/react_steps.json`, CodeAgent recomputes
   the original baseline using the newer `risk >= 5` rule, returning 4 / 1400
   instead of 3 / 800. In `v3-tasks/tasks-membership_values/t05/react_steps.json`,
   Dataflow changes the live scan and joins current totals with
   `{operator:"cohort_totals",atTask:1}` in one batch. The original values remain
   correct. Counterfactual: an explicit preserved Python baseline would also work.

2. **Propagation does not validate formulas.** In
   `v3-tasks/tasks-repeated_corrections/t03/react_steps.json`, Dataflow subtracts
   `cost + 3*units` from revenue, omitting the multiplication of base cost by units.
   Tasks 4 and 6 instead multiply the surcharge by units twice. The graph
   correctly propagates incorrect formulas. CodeAgent uses the stated formula
   correctly. Counterfactual: a previously validated formula consuming a scalar
   handling-charge input would avoid rewriting that formula on each update.

3. **Avoidable answer-copy calls.** In that session's `t10/react_steps.json`, the
   first call requests the right cached result but omits `column`. The second
   call only supplies it. This explains two model calls for an already-computed
   answer. Inferring the only column when unambiguous, or using `row` directly,
   would remove that repair; neither is assumed in the reported cost.

4. **A dependency check catches a real class of error.** In development revision
   `6240bed4e`, the fanout and repeated-correction primary traces analyze a raw
   five-line discovery probe as the dataset. Revision `f6d70360a` adds the graph
   check and a prompt warning. A scripted model through the real agent loop and
   engine confirms that both live and historical preview-derived returns are
   rejected. The final fanout session passes 5/5. Because the warning and guard
   changed together, the paid-run improvement cannot be attributed to the guard
   alone.

5. **Output shape still matters.** In
   `v3-holdout/tasks-longds_github/t01/react_steps.json`, the native chain produces
   the correct ranking and counts but never renames `name` to `language` before
   direct return. That is the real-data primary run's only scored error. All
   15 tasks use current inputs; this session does not demonstrate historical
   selection benefits.

6. **A cost win without historical selection.** In the customer session's task 4,
   both agents correctly compute the temporary trial-customer report. CodeAgent
   reloads/inspects the CSV and then computes it in a second call; Dataflow batches
   the known chain in one call using its existing typed source. Costs are
   $0.001655 versus $0.001017; output tokens are 1,020 versus 564. Neither uses an
   `atTask` input here, so this is a reuse/batching win, not evidence for history.
   CodeAgent could also reuse its earlier loaded rows and schema. Dataflow is
   slower in wall time on this task despite the lower model cost.

## Recoveries and ablations

Each failed primary session receives two additional fresh **complete-session**
runs, even if the first recovery succeeds. Successful primary sessions are not
rerun under this policy. This is a recovery sensitivity check, not three
independent full-benchmark replicates.

| Failed primary session | Primary | Recovery 1 (cost) | Recovery 2 (cost) |
| --- | ---: | ---: | ---: |
| CodeAgent membership | 4/5 | 4/5 ($0.002352) | 5/5 ($0.002297) |
| Dataflow repeated corrections | 17/20 | 20/20 ($0.015326) | 20/20 ($0.022813) |
| Dataflow temporary scope | 4/5 | 5/5 ($0.006715) | 5/5 ($0.004444) |
| Dataflow LongDS GitHub | 14/15 | 11/15 ($0.033020) | 14/15 ($0.029516) |

Additional recovery cost is $0.004649 for CodeAgent, $0.049298 for diagnostic
Dataflow, and $0.062536 for real-data Dataflow. These are additional to the primary
table. The real-data first recovery repeats the field-name mistake, misses a
top-five limit, and omits requested rounding in two tasks; the second omits
rounding in task 13. Neither is a historical-state failure.

With the final implementation, a small history-disabled comparison keeps the
compact catalog, task context, and direct return enabled:

| Session | History off | History on | Cost off / on | Calls off / on |
| --- | ---: | ---: | ---: | ---: |
| Membership | 4/5 | 5/5 | $0.006327 / $0.004699 | 11 / 9 |
| Temporary scope | 5/5 | 4/5 | $0.006867 / $0.006363 | 11 / 10 |

Without historical inputs, the membership run reconstructs the original baseline
using the current rule and returns 4 / 1400, exactly the primary CodeAgent error.
With history it reads the saved result. The temporary-scope history-on failure
is a timeout, so that row is not evidence for a semantic regression. This is one
primary sample per configuration and two families; it is not a statistical claim.
The history-disabled failed session also receives two fresh recovery runs:
both pass 5/5, costing $0.005676 and $0.004922 (10 and 9 calls). Those successes
show that correct original-state selection does not require Dataflow history;
the mechanism makes the selected historical reference enforceable at runtime.

The first development campaign's additive ablations are retained for diagnosis,
but they predate fixes to cache-hit handling, catalog syntax, and the typed wire
schema. They are not clean causal evidence for the final implementation.

## What to build next

1. **Make changing assumptions data inputs.** Establish one validated profit
   calculation depending on a one-row `assumptions` table. A task changing the
   handling charge edits that table; the existing graph updates all reports.
   Preserve the original publication with `atTask`. Native operations express
   dependencies; a UDF is appropriate for the initial formula if needed. No
   parallel function registry is necessary.
2. **Remove measured interface overhead.** Handle an unambiguous one-column
   return without a repair call, prefer returning existing rows, and capture
   actual provider requests to resolve the cache-prefix behavior. Measure these
   separately from historical-state semantics.
3. **Evaluate the causal claim directly.** Use sessions with source replacement,
   original-membership/current-values joins, corrections with several dependent
   reports, and temporary scenarios followed by resumption. Compare against a
   CodeAgent allowed normal memory, `.copy()`, and parameterized functions. Add
   independent tasks as a control and retain unadapted real sessions for breadth.
   Report model calls, cost, stale-state errors, formula errors, and recovery
   effort separately. Expand to additional domains before claiming generality.

The graph's potential advantage is deterministic dependency propagation and
provenance checks. Python can implement those too. The research question is
whether providing them in the runtime saves enough model decisions to offset
the interface/context overhead. This milestone establishes the mechanism,
not that final performance claim.

## Validation, isolation, and limits

- 1,080 Bun tests and TypeScript checking pass; two Scala retention tests and the
  isolated engine-port test pass. The isolated-profile helper's three tests pass.
- Live engine smoke covers 2,000 source rows, an old row outside every preview,
  source-file replacement, old membership joined to new values, cached results,
  missing/failed references, and isolation from a failed current edit.
- The additional coverage smoke drives the production agent loop with scripted
  actions and a real engine: zero paid calls, three checks passed.
- Isolated project/network/volumes: `texera-task-history`. Agent `3041`, engine
  `28085`, web `28080`, compiler `29090`, PostgreSQL `25432`, proxy `24000`.
  The shared development stack was not restarted or modified.
- A first LongDS attempt lacked the isolated engine's `amber/data -> ../data`
  symlink. It was stopped and excluded as an environment-invalid attempt. A
  separate full session after a real engine path preflight supplies the reported
  score. The failed attempt and its usage remain archived.
- Cleanup retained that stopped attempt's workflow/CU `42`: the agent is idle,
  but backend execution history still reports execution `410` as nonterminal.
  The cleanup preflight therefore refused to delete it. It belongs only to this
  private stack. Two empty resources from failed setup attempts (`3`, `23`) are
  likewise retained; no shared-stack resources are involved.
- Historical bindings live in agent memory; restarting/clearing loses those
  bindings. Full result files are retained separately, with no quota/garbage
  collector yet. The milestone supports scalar native tables and local shared
  storage. It is not a production persistence design.

Reproduce scoring and cache-aware summaries with `summarize-task-study.py`;
it asserts identical paired prompts and reconciles recorded token classes with
reported model costs. `run-task-study.py` records fixture hashes, source revision,
fresh primary sessions and two fresh full-session recoveries for every failure.

## Artifacts

- [Machine-readable results](task-history-results.json): primary and recovery
  totals, per-session usage, paired-task categories, and the history ablation.
- [Raw artifact bundle](../../../benchmark/longds/system_scratch/TaskHistoryMilestone/artifacts.tar.gz)
  and [checksum/index](../../../benchmark/longds/system_scratch/TaskHistoryMilestone/index.json).
  This local bundle is gitignored. It includes development attempts, final traces,
  configurations, fixture/gold files, real CSV inputs, failed environment attempt,
  retained tables, and validation logs. Credentials and stack environment files
  are excluded.
- Current retained storage across development and final runs: 1,219 Arrow files,
  4,437,782 content bytes. Filesystem allocation and engine tables add overhead;
  none of this storage is priced into the model-cost comparison.

```bash
python3 agent-service/benchmark/multiturn/summarize-task-study.py \
  --code /tmp/texera-task-history/v2-code/manifest.json \
  --dataflow /tmp/texera-task-history/v3-tasks/manifest.json \
  --output /tmp/diagnostic-summary.json
```
