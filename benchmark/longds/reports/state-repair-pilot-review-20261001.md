# State-repair pilot: historical reads work; benefit remains unproven

Candidate: `d649d7648`. Dataflow retains one persistent graph and append-only
history, with historical inspect, retrieve and fork enabled in the history arm.
The experiment adds no task catalog. See
[the frozen plan](state-repair-experiment-plan-20261001.md) and
[machine-readable results](state-repair-pilot-results-20261001.json).

## Retrieval capability

All three views were enabled in both native arms:

| View | Observation |
| --- | --- |
| `full` | Retained records within 100,000 characters; no sample row limit |
| `sample` | Records within 2,000 characters and 50 rows |
| `sample_stats` | The same bounded sample plus coverage-labeled statistics within a separate 2,000-character budget |

The history arm can use these views for a saved result with `task_id`.
Retrieve never executes. A capped or truncated full observation remains
explicitly incomplete; it is not an unlimited export. Downstream operators
process the complete table. Increasing a read budget cannot recover records
that were absent from the retained materialization. Samples are not guaranteed
to be uniform random samples. Missing statistics are labeled unavailable.

## Natural LongDS pilot

One Luna repeat, restaurants questions 1–8 and Kiva 1–4: 36 answers across
three arms. Original Appendix E.2 correctness prompt, DeepSeek V4 Pro;
original Appendix E.3 error annotation, Codex gpt-5.5/xhigh. All six annotation
bundles passed validation. Error annotations cover failed answers only.

| Arm | Restaurants | Kiva | Combined | Estimated solver cost | Cached input |
| --- | --- | --- | --- | --- | --- |
| Native control | 3/8 | 0/4 | 3/12 | $0.058409 | 92.7% |
| Native history | 2/8 | 3/4 | 5/12 | $0.060570 | 92.8% |
| Original DSGym | 3/8 | 0/4 | 3/12 | $0.024345 | 89.6% |

These are cache-aware token estimates, excluding judging, annotation and
incomplete setup attempts. They are not provider invoices. Native history
costs 3.7% more than native control and about 2.5 times DSGym here. DSGym
also made early requests without executing useful code, so lower cost partly
reflects less completed analysis. Cost parity is not achieved.

**The natural history arm made no historical inspect, retrieve or fork calls.**
The two additional correct answers cannot be attributed to historical recovery.
The tool comparison includes its usage prompt, so solution construction and
random model variation also differ. One repeat over twelve questions does not
establish an accuracy gain.

### What the traces show

**Restaurants: preserving complete populations matters.** Control Q1 answers
the top-eight request correctly, but its `first_watch_list` operator emits only
eight rows. There is no separate materialized full watch population. In Q3 it
combines this report with other limited reports and works with 19 units rather
than the reference 30. This is a real loss of reusable working state, even
though Q1 passes the correctness judge.

History Q1 retains 70 scored eligible units, 19 watch units and a separate
eight-row report. That is better state construction. Its Q3 nevertheless
applies `limit(15)` directly to the eligible population without sorting the
commission metric. It produces 31 relevant units and the wrong advance
membership. Later answers inherit that mistake. Historical retrieval would
not correct an unsorted ranking by itself.

**Kiva: incorrect formulas dominate control.** Control Q1 percentile-ranks
completion gap where the requested blend uses raw completion gap. It also
initially aggregates completion as an unweighted mean rather than the ratio
of funded and requested totals. Scale adjustments consume several repair
steps. These are calculation and definition errors, not evidence of a stale
engine result.

Control Q1 also reports borrower-reliance numbers that disagree with its
latest retrieved table in four of five rows. Those reported values match an
adjacent score column in the wide TSV observation. Column confusion is the
best supported explanation; stale cache attribution is unsupported. A small
named-field report would reduce this answer-reading problem.

**Kiva history Q1 separates numeric correctness from answer coverage.** The
five identities and all five early-pressure values match the reference. The
original judge still returns zero because the answer omits raw supporting
fields such as loan count, completion percentage, waiting days and term
months, and instead supplies transformed components. The exact numeric
match is real; the required-field interpretation needs a separate audit. Do
not replace the official score with a claim that every requested field passed.

DSGym's early failures largely concern tool execution and instruction
following. Some later restaurant answers recover through fresh computation.
These traces do not demonstrate that script agents cannot preserve state.

### Original error labels

| Arm | Primary statistical/domain | Primary instruction | Primary state | Primary cascade | State as any label |
| --- | --- | --- | --- | --- | --- |
| Native control | 3 | 0 | 3 | 3 | 4 |
| Native history | 0 | 3 | 0 | 4 | 0 |
| DSGym | 0 | 9 | 0 | 0 | 0 |

All 25 failed answers were classified. Fewer state labels in the history arm
are useful diagnostic evidence, but no historical calls occurred and failure
types differ. Passing Q1 answers can still discard state, which is why we
also inspect intermediate populations independently of failure classification.

Partial-credit rubrics were frozen before predictions. Some answer-shape
mappings remain incomplete, so there is no aggregate partial-accuracy claim.
Requested-field coverage and exact computed values should be reported
separately from original binary judgment.

## Controlled state mechanism check

This synthetic four-question episode is separate from LongDS accuracy and
does not replace the planned validated LongDS checkpoint experiments:

1. First population, `score = 2 * value + 1`: total 15.
2. Replace the population and formula, `score = 3 * value + 42`: standing total 357.
3. Apply the first formula to the current population temporarily: total 157.
4. Recover the standing total 357 and the original total 15.

References were independently computed with pandas. Six sessions, 24
answers, original correctness judge and original error annotation; all six
annotation bundles passed validation.

| Model | Native control | Native history | DSGym | Control cost | History cost | DSGym cost |
| --- | --- | --- | --- | --- | --- | --- |
| Luna | 4/4 | 4/4 | 3/4 | $0.003162 | $0.003753 | $0.002713 |
| Terra | 4/4 | 4/4 | 4/4 | $0.035467 | $0.045296 | $0.039304 |

Luna retrieves Task 1's saved total. Terra inspects Task 1's formula before
the temporary computation and retrieves its saved total afterward. Both bind
the old formula to the current population correctly and preserve the standing
baseline. Neither uses fork; inspect followed by edit suffices here. The one
DSGym Luna failure receives an instruction-following label.

Historical reads work with real models. Equal native accuracy means this
fixture establishes capability, not improvement. History costs 18.7% more
than control on Luna and 27.7% more on Terra; Terra history also exceeds the
script cost by 15.2%.

## Repairs, anomalies and isolation

- A live provider rejected `uniqueItems` in the execute-tool schema before
  generation. Candidate `d649d7648` removes the unsupported schema keyword
  and validates duplicate targets locally before mutations. Regression,
  1,196 Bun tests, typecheck and a live provider preflight passed.
- Setup failures and the terminated partial script attempt are retained
  separately. Unrecorded in-flight usage is unknown, not zero.
- Native aggregate rejects boolean `sum`/`mean`; agents cast and repair.
  This is interface/type friction. There is no newly demonstrated numerical
  engine failure in these traces.
- The action monitor records unavailable reads after failed execution and
  one repeated rejected edit. No infinite loop was confirmed. Prefix caching
  is strong in this cohort; it does not eliminate a larger context's cost.
- Engine logs contain statistics-writer `ConcurrentModificationException`
  on closing. Preserve this telemetry anomaly; the current evidence does not
  tie it to an incorrect analytical result.
- All runs use the private `texera-state-repair-20261001` stack. Five existing
  container IDs and start timestamps were unchanged at pilot launch.
  JVM heap limits apply. Requested systemd memory accounting was not
  observable from this environment, so it is not reported as a verified hard
  memory cap. Controllers also check available memory and disk directly.
- Pilot script state capture left hidden audit variables in its kernel.
  No influence on an answer was established, but those variables could retain
  frame references. The broader adapter uses a temporary namespace; a
  regression failed on the original capture and passes on the isolated capture.

## Follow-up decision

The cost and accuracy gates are unresolved. Preserve this candidate and run
**one broader diagnostic Luna repeat**, covering the five predeclared scopes:
restaurants 1–8, Kiva 1–26, survey 1–30, Netflix 1–36 and NFL 1–42.
This is 426 answers across three conditions, with two solver jobs at a time.
Keep the same retrieval budgets and shared adapted user messages. Do not
launch repeats two and three or broad Terra confirmation until this repeat
receives a manual state-and-cost review.

The longer scopes contain explicit rollback requests absent from the short
pilot. Check whether the agent actually selects a historical producer, binds
the requested formula/population correctly, and avoids corrupting the standing
branch. Audit early formula errors separately so their cascades do not masquerade
as retrieval failure. Continue original binary judging, original error
classification, selected field-level checks, cache accounting and loop/error
monitoring. Independently validated LongDS checkpoints remain outstanding.

Pilot control/artifacts: `logs/longds-state-pilot-20261001` and
`/var/tmp/texera-state-pilot-20261001`. Controlled episode:
`logs/longds-state-mechanism-20261001` and
`/var/tmp/texera-state-mechanism-20261001`. Broader controller/artifacts:
`logs/longds-state-broader-20261001` and
`/var/tmp/texera-state-broader-20261001`.
