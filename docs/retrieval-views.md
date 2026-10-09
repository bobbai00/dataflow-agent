# Retrieval views and automatic flow evidence

Native agents choose a `view` on each `retrieve` action:

```json
{
  "reasoning": "Check the output's missing values and range.",
  "actions": [
    {"type": "retrieve", "operator_ids": ["joined", "checks"], "view": "sample_stats"}
  ]
}
```

The current registered protocol retrieves a nonempty list of operator IDs.
The view and optional columns apply to every target; each target has its own
status and result block, so a missing or stale target does not hide valid reads.
Use separate actions when results need different views or column selections.

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

The default views are `sample_stats` and `full`. The prompt starts with samples
and statistics; when they suffice, no full read is needed. Project relevant
columns and compute aggregates in the graph before requesting individual
records. The default full display cap is 5,000 characters. Workbook header
inspection uses a one-row preview; increasing its length reads data rows from
each sheet as well.

For complete column discovery, inspect `target:"schema"` with `operator_id`.
This reads the stored result schema independently of record and statistics
budgets. For workbook discovery, execute `scan(..., preview=1)` and inspect
`target:"source"` to read retained paths, sheet names, and first raw rows. Neither
inspection opens files or executes. Both use optional `offset`/`limit` pages
(default 200 entries, limit 1–200) and return `next_offset` when more retained
entries remain. Source inspection distinguishes known sheet names from a complete
workbook list; raw rows are layout hints, not parsed schema. Missing, failed, or
stale materializations must be executed before these inspections can succeed.

Data statistics describe an explicitly requested operator's output table.
`flowEvidence` independently exposes operator runtime measurements: filter
retention and rejections, join matches and unmatched keys, cast failures, scan diagnostics, and aggregate
denominators. Execution receipts report each newly executed operator's own
measurements even when its table was not requested. Retrieval adds bounded
summaries from the requested operator's producing ancestors. Its
`flowEvidenceCharLimit` is independent of the record and data-statistics budgets.
The measurements describe executed operations; they do not certify that the
calculation answers the task.

Traversal follows exact producing input versions, visits at most 32 nodes to
depth eight, and selects at most three ancestor summaries within the flow
budget. It can cross custom Python operators because their input dependencies
are explicit. Measurements from before custom processing are labeled with
unknown row/column correspondence to the requested output; graph ancestry does
not prove that particular rows survived. Stale, failed, or unbound results do
not contribute ancestor measurements.

The measured filter contract is `filter(t, predicate="name", settings={})`.
The named registered function receives a read-only row mapping and returns True,
False, or a scalar missing value. True retains the row; False/null rejects it,
with null verdicts counted separately. Output columns and retained row order
are preserved. The execution records columns actually read by the predicate.
Filtering inside an unrestricted table function remains opaque, as do custom
pandas joins and conversions: they do not inherit built-in filter/join/cast
measurements. Names and docstrings cannot establish those semantics.

### Bounded failure and key examples

With profile collection enabled, Filter retains three first-encountered distinct
source values for each of up to eight predicate-read columns, plus their counts
and the remaining `otherCount`. Counts cover **all rejected rows**, including
null-verdict drops, even if a column was read only conditionally. Null is distinct
from a literal `"null"` string. These distributions do not establish why an
individual row was rejected.

Cast retains examples for at most eight
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
  "fullResultCharLimit": 5000,
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

If `retrievalViews` is omitted, the default exposes `sample_stats` and `full`.
Explicit `retrievalViews` controls availability; the legacy `dataEvidence`
boolean does not change it. Thus `dataEvidence: false` alone is not a data-off
configuration. In the native action interface, data statistics are shown only
when the selected view is `sample_stats`. Historical runs must use their
recorded revisions.

The three new character limits default to 5,000 / 2,000 / 2,000 respectively
and accept integers from 128 through 100,000. `maxResultRows: 0` leaves sample
size bounded only by characters. Row limits apply to sample views only.

## Storage, execution and history

Every native execution retains results up to 100,000 characters, independently
of `fullResultCharLimit` and the available views. A smaller display cap therefore
preserves the bounded materialization for later reads. Native cell transport uses up to 20,000 characters,
the backend ceiling. This implementation fetches the bounded result during
execution; Retrieve renders it without a backend execution or a new row fetch.
Increasing a limit later does not recover records absent from an earlier
materialization. Incomplete observations remain labeled as such.

The selected view never changes the graph, producing version, or cache key.
DELTA receipts preserve every action's exact observation. Snapshot views retain
the last successful observation per operator in the call, provided no later
action invalidated that result. Profile collection is separate from exposure
and must be configured before operators are created.

Native timings remain saved telemetry rather than automatic model-facing
evidence. With collection enabled, `native.operations.timing.operatorBodyMs`
measures successful operator work, definition replay, source I/O, and native
counters. The optional `filterRejectedValuesMs` is a separately measured pass
excluded from body time. Profile `cost.collectionMs` measures accumulation;
optional `cost.snapshotMs` measures building its immutable summary. These fields
exclude input/output validation, JSON encoding/trimming, transfer, and persistence.
Unknown phases remain absent; cached results keep their original measurements.

## Experiments

The pilot driver in `benchmark/retrieval/run.py` crosses four policies with
automatic flow evidence off/on: fixed `full`, fixed `sample`, fixed
`sample_stats`, and model-selected views. It records actual settings, prompt,
schema, traces, producing versions, official KramaBench scores and costs. The
original task evaluator is unchanged; full pass means official score >= 1.0.
Independent repetitions retain failures and use no outcome-selected retries.

The matched `evidence_data{0,1}_flow{0,1}` arms offer sample/full when data is off
and sample_stats/full when it is on, with flow independently toggled. All four
collect full-row profiles internally, so they compare exposure rather than
profiling overhead. Pass `--full-result-char-limit 5000` to use the current
service display cap; the runner's historical default remains 100,000. Current
inspection/filter contracts do not change the interpretation of frozen earlier
campaigns.

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
