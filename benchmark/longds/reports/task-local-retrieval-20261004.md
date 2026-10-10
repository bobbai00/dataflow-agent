# Task-local retrieval verification — 2026-10-04

Task retrieval now returns the operators doing the selected task's computation
and compact references to unchanged earlier inputs. The captured replay is
74.2% smaller. A matched Luna continuation improves official semantic scores
from 1/2 to 2/2, but uses more calls, costs 22.8% more, and produces one malformed
JSON answer. Requiring both semantic correctness and valid JSON leaves both
arms at 1/2. This verifies compact retrieval, not a general accuracy or cost win.

The baseline is our previous native ReAct implementation at `4ba0c2c01`.
This experiment does **not** compare with DSGym or DS-Agent.
Detailed measurements, original answers, references, judge reasoning,
source hashes and limitations are in the
[JSON report](task-local-retrieval-20261004.json).

## Implementation

- Selected answer branches show introduced/changed operators and affected
  downstream computation. Unchanged earlier computation becomes an input
  reference naming its operator, owning task, saved revision, result identity,
  availability, row count and scope. Full saved graphs remain on the server.
- A model can expand a particular input through its owning task and operator
  ID. Implementations are optional and apply to local operators; a requested
  result view returns selected root tables, not every intermediate table.
- Matching considers the entire incoming computation and materialized result
  identity. Changed ancestors and fresh executions are not hidden by unchanged
  consumer definitions. Restoring an older rule stays visible when it changes
  the preceding task's computation. Metadata comes from the owning snapshot.
- Answers reading an earlier saved result, including through a fork, can have
  zero local operators. Answer roots from different saved versions remain
  separate and preserve their original values.
- Computed answers are instructed to declare `operator_ids`. Undeclared
  result reads stay explicit candidates, without automatic graph/table
  expansion. Named roots remain available for legacy answers.
- Multi-task graph inspection requires named `operator_ids`. Single-task
  unscoped inspection remains available. Prompt examples explain selective
  expansion, scope checks, reuse, repair and saved versions in general terms.

This uses ordinary ReAct and existing history actions. It adds neither a model
ledger nor a benchmark-specific rule. It operates with saved-state tools
enabled; the benchmark arms' other settings were held equal.

## Controlled replay

Thirteen recorded task inspections from the restaurant and Goodreads sessions
were rendered before/after using identical captured workflows, source roots,
result identities and original samples. Each captured computation hash was
checked against its saved workflow. There were no model or engine calls.

| Total over identical inspection requests | Before | After |
|---|---:|---:|
| Operator definitions | 396 | 41 |
| Saved input references | 0 | 7 |
| Result samples | 61 | 6 |
| Observation characters | 509,802 | 131,576 |

These are repeated inspection totals, not unique session operators. The 74.2%
reduction measures text, not billed tokens or solver cost. Missing answer
declarations now produce candidate lists; a further selection call is needed
and is **not** included in the same-request total above.

The previous Task 6 inspection expanded exploratory read roots into 71
definitions and 12 result samples (79,084 characters). Explicitly selecting its
recorded final table, `subsidy_top8_t6`, returns **11 local operators, five saved
inputs and one result sample** (14,888 characters). Its input references point
to computations owned by tasks 1, 2, 3 and 5. This is an 81.2% smaller selected
receipt; including the 3,301-character candidate-discovery receipt makes it
18,189 characters across two calls. Further upstream expansion remains
available and may add text and calls.

## Four-answer live pilot

The selected LongDS session was
`business/nyc_restaurants_data_food_ordering_and_delivery/task2`.
Both arms replayed the same recorded Task 1 actions and agent-generated answer
through the real engine, without new model calls. All **16 initial operator and
incoming-computation fingerprints matched** before either arm solved questions
2 and 3. The replayed answer may retain prior mistakes; it is not a gold seed.

There was one two-question continuation per arm and four paid answers total,
with no retries or selective exclusions. Both arms used `gpt-5.6-luna`, medium
reasoning, native DELTA, the dependency task index, saved-state tools and no
ledger. Statistics exposure and flow evidence were off; profile collection was
on. Views were `sample`/`full`, capped at 2,000/5,000 characters. Each question
allowed 40 model calls with 8,192 output tokens per call, and no input clipping
or automatic compaction. Benchmark references and dependency annotations did
not enter solver inputs.

| Measure | Previous retrieval | Task-local retrieval |
|---|---:|---:|
| Completed answers | 2/2 | 2/2 |
| Official semantic passes | 1/2 | 2/2 |
| Valid JSON answers | 2/2 | 1/2 |
| Semantic pass **and** valid JSON | 1/2 | 1/2 |
| Model calls | 9 | 14 |
| Input tokens | 204,820 | 308,954 |
| Output tokens | 4,663 | 5,451 |
| Cached input tokens | 162,480 | 261,523 |
| Estimated solver cost | $0.017313 | $0.021258 |
| Solver elapsed time, summed over questions | 68.5 s | 113.1 s |

Estimated cost increased 22.8%, calls 55.6%, and elapsed time 65.1%. These are
cache-aware estimates using the repository's existing per-million-token rates:
$0.20 input, $0.02 cached input, $0.25 cache writes and $1.20 output. They are
solver estimates, not provider invoices; judging is excluded. All four answers
completed, so no failed/unattempted-task costs were removed. On question 2,
which both arms passed, the new arm still cost 27.6% more.

Official LongDS binary judging used `deepseek/deepseek-v4-pro` and the existing
question-focused protocol. Question 2 passes in both arms. Question 3 fails in
the baseline and passes semantically in the new arm. The new answer is missing
its final closing JSON brace; its original text is preserved. Both question-2
answers also contain incorrect extra uncertainty indices, which the official
judge ignores because the question asks for units and pressure signals. Thus
official passes do not establish correct intermediate arithmetic or strict
answer-format compliance.

## What the traces explain

For question 3, the baseline's `operating_decision` reads pressure flags from
`first_watch_only`, a correctly computed **19-unit selected subset**, and fills
missing flags with false and pressure counts with zero. The decision query
needs flags for all **30 relevant units**. It incorrectly returns 8 advance,
10 diagnose and 12 hold.

The new arm's `relevant_metrics` joins those 30 units to `watch_counted`, the
complete **70-unit eligible lookup**, then groups decisions. It returns the
reference counts: 3 advance, 15 diagnose and 12 hold, with correct leading
examples and reasons. This supports a semantic reuse/input-coverage explanation;
it is not a stale-snapshot or rollback error.

The baseline repaired one process MissingColumn error in question 3. The new
arm repaired one union-schema mismatch in question 2 by projecting common
columns. The additional calls also include candidate discovery, targeted
inspection and verification. Smaller receipts alone did not reduce total
provider input, loop calls or cost. Representation, prompt guidance and
inspection constraints changed together; this pilot cannot isolate their
individual effects, and later solver graphs diverge.

## Verification and reproducibility

The final code passed **1,366 Bun tests**, type checking, formatting and
generated-reference freshness checks. Ten new subgraph cases include changed
ancestors, fresh result identities, shared inputs, selective expansion,
owning-snapshot metadata, restoring an older rule and direct historical roots.
The five-task live-engine fixture passed eight checks with zero model calls:
five local operators plus one pinned input, saved result 14 after current
inputs changed, old/current sums 6/60, separate answer versions, graph scoping,
forks/restores, deletion and explicit unknown-task errors. All allocated pilot
and verification agents, workflows and computing units were removed.

Two fixture mistakes were retained in the artifacts and corrected: an invalid
sort expression, and a missing `operator_id: null` in extended inspection.
They did not trigger paid solver retries or require relaxing runtime schemas.

The paid pilot ran the frozen source recorded in `pilot-protocol.json` and
`runtime.patch`. Final owning-metadata, restore and foreign-root corner fixes
were verified afterward without additional model answers. All **27 captured
replay text files remained byte-identical** after those fixes; the final
live-engine fixture exercised the new cases. The JSON report records the
source differences, so the paid results are not presented as a rerun of the
final commit.

Raw artifacts are saved under
`/var/tmp/dataflow-task-local-20261004/`: frozen pilot protocol/patch, per-arm
prompts, answers, traces, token counts, judgments and cleanup; replay receipts;
and `live-engine-final-fixed/` verification receipts. The report JSON preserves
the four judged answers and references independently of that temporary path.
The reusable verification entry points are
`agent-service/benchmark/e2e/task-context-run.ts`,
`agent-service/benchmark/multiturn/replay-task-retrieval.ts`, and
`agent-service/benchmark/multiturn/run-task-local-pilot.ts`.

The next question is whether declaring answer sources and batching necessary
inspection can reduce these extra calls while retaining complete working
inputs. Further experiments should separate retrieval size, semantic
correctness, formatting and all-attempt cost; this pilot does not justify a
larger accuracy or efficiency claim.
