# Retrieval views and automatic flow evidence

Native agents choose a `view` on each `retrieve` action:

```json
{
  "reasoning": "Check the output's missing values and range.",
  "actions": [
    {"type": "retrieve", "operator_id": "joined", "view": "sample_stats"}
  ]
}
```

| View | Records | Data statistics |
| --- | --- | --- |
| `full` | All retained records that fit `fullResultCharLimit`, without sample cell clipping | None |
| `sample` | Records within `maxOperatorResultCharLimit` and `maxResultRows` | None |
| `sample_stats` | The identical sample | Available column/table evidence within `dataEvidenceCharLimit` |

Every receipt reports the view, returned/total rows and columns, completeness,
and the producing result version. A capped `full` view is explicitly incomplete.
Backend cell truncation or unavailable records also prevents a completeness
claim. Samples use the existing stored-record selection, not uniform sampling.
Statistics retain their full/partial coverage and unknown-value labels; complete
small tables suppress redundant data statistics.

Every view labels scan previews as source previews, even if all preview rows
fit. That completeness refers to the preview output, not the source file.
`sample_stats` reports collected row/column coverage and explicitly identifies
unavailable statistics. Raw-line tables need parsing before column statistics
are meaningful; repeated raw lines are not reported as duplicate data records.
The collector currently bounds profiles by 100,000 rows, 1,000,000 cells, 128
columns and 0.2 seconds per worker. Large-table profiles can therefore cover a
prefix. Counts and ranges describe that prefix; they are not population estimates.
If profiling measured no rows of a nonempty table, its data statistics are
marked unavailable. Independently measured operator counters remain usable.

The prompt recommends sample statistics for large parsed tables, projections
to relevant columns, and graph computations before requesting large record
views. It reserves `full` for decisions that need individual records and small
final results. Workbook header inspection uses a one-row preview; increasing
its length reads data rows from each sheet as well.

`flowEvidence` independently appends bounded metadata about the requested
operator and its producing ancestors, including intermediate projections,
joins, filters and aggregates. Its `flowEvidenceCharLimit` is independent of
the record view and data-statistics budget. Traversal follows exact result
versions, includes at most three ancestors, and stops at opaque custom stages.
The metadata describes the executed calculation; it does not certify that the
calculation answers the task.

### Bounded failure and key examples

With profile collection enabled, Cast retains examples for at most eight
converted columns: the first three distinct failed values, their occurrence
counts, and the remaining failure count. Join retains up to three eligible
unmatched keys and three duplicate keys on each side. These are examples in
encounter order, not random samples or the most frequent values. Counts use
the original typed values. Display clipping never changes conversion, key
identity, join matching or counts.

Examples use the lossless scalar encoding, including decimal strings for
large int64 values and UTC timestamps. Unrepresentable values are omitted
from examples while their failures remain in the counters. Text is capped at
96 characters and compound keys at eight components; clipped examples are labeled. Join null
keys follow `nullsEqual`: excluded null keys contribute to the existing
null/unmatched-row counters, but are not eligible-key examples.

Direct retrieval can show these diagnostics within the flow budget. Selected
upstream summaries include Cast failures/examples, Join coverage and short
unmatched-key examples, and Window lag/lead offsets and boundary-null counts.
All refer to the producing result versions. Invalid or absent examples do
not suppress valid counters; old profiles remain readable. The collector
drops optional witnesses before other profile information when its payload
budget is exceeded and records `native_witness_payload_budget`.

The prompt uses synthetic fields and operator contracts to illustrate
retrieval and repair. A failed conversion does not prescribe a cleaning rule;
unmatched or duplicate keys do not automatically justify normalization or
deduplication. Those choices depend on the task and source definitions.

## Session settings

```json
{
  "agentMode": "native",
  "nativeProfileCollection": true,
  "retrievalViews": ["full", "sample", "sample_stats"],
  "fullResultCharLimit": 100000,
  "maxOperatorResultCharLimit": 2000,
  "maxResultRows": 5,
  "dataEvidenceCharLimit": 2000,
  "flowEvidence": true,
  "flowEvidenceCharLimit": 2000
}
```

`retrievalViews` determines the enum exposed in the strict tool schema. A
single-element list creates a fixed-view experimental arm. The system prompt
describes only the enabled views, their budgets and the enabled evidence.
Unavailable views reject the entire action envelope before any edits run.

If `retrievalViews` is omitted, the default exposes `full` and `sample`;
`dataEvidence: true` additionally enables `sample_stats`. Explicit
`retrievalViews` takes precedence over this default. In the native action
interface, data statistics are shown only when the selected view is
`sample_stats`. Historical runs must use their recorded revisions.

The three new character limits default to 100,000 / 2,000 / 2,000 respectively
and accept integers from 128 through 100,000. `maxResultRows: 0` leaves sample
size bounded only by characters. Row limits apply to sample views only.

## Storage, execution and history

Every native execution retains results up to `fullResultCharLimit`, regardless
of which views are available. This keeps record collection identical across
the experimental arms. Native cell transport uses up to 20,000 characters,
the backend ceiling. This implementation fetches the bounded result during
execution; Retrieve renders it without a backend execution or a new row fetch.
Increasing a limit later does not recover records absent from an earlier
materialization. Incomplete observations remain labeled as such.

The selected view never changes the graph, producing version, or cache key.
DELTA receipts preserve every action's exact observation. Snapshot views retain
the last successful observation per operator in the call, provided no later
action invalidated that result. Profile collection is separate from exposure
and must be configured before operators are created.

## Experiments

The pilot driver in `benchmark/retrieval/run.py` crosses four policies with
automatic flow evidence off/on: fixed `full`, fixed `sample`, fixed
`sample_stats`, and model-selected views. It records actual settings, prompt,
schema, traces, producing versions, official KramaBench scores and costs. The
original task evaluator is unchanged; full pass means official score >= 1.0.
Independent repetitions retain failures and use no outcome-selected retries.

```bash
benchmark/Kramabench/.venv/bin/python benchmark/retrieval/run.py \
  --output .claude/artifacts/retrieval-pilot-20261001 \
  --endpoint http://localhost:3075 --repetitions 2
```

Use an agent service frozen at the recorded revision. The six default tasks
are diagnostic cases for large tables, parsing, joins and sampling mistakes;
they are not a representative accuracy estimate for all 104 KramaBench tasks.
Freeze task selection before viewing results, retain every outcome, and inspect
traces to distinguish information effects from errors or changes in strategy.
Report cache-aware model costs separately from evaluator and engine overhead.

Summarize a completed run and export its chart:

```bash
benchmark/Kramabench/.venv/bin/python benchmark/retrieval/analyze.py .claude/artifacts/retrieval-pilot-20261001
benchmark/Kramabench/.venv/bin/python benchmark/retrieval/plot.py .claude/artifacts/retrieval-pilot-20261001
```

The [2026-10-01 pilot report](../benchmark/retrieval/results/20261001.txt)
records all 192 attempts, official scores, costs and limitations. It used the
frozen agent at `ab1020138`. A header-clipping issue discovered in its traces
was subsequently fixed in `84eb8579d`; the saved-result replay validates the
rendering fix without attributing unmeasured accuracy or cost changes to it.

The [large-data audit and pilot](../benchmark/retrieval/results/20261001-large.txt)
uses three complete original tasks selected by input size, five settings and
both models (30 attempts, one repetition). Sample statistics reduced recorded
model cost relative to full retrieval by 54% for Luna and 48% for Terra. They
did not increase full passes over sample-only in this pilot. Flow evidence had
mixed results. The report includes source checks, cache checks, repaired
timestamp serialization, the exact served prompt and remaining model errors.
