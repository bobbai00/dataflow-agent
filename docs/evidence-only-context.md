# Evidence-only context checkpoint

> **Superseded on 2026-09-22.** The JSON batch tool, the V1/V2 catalogs and
> `nativeToolMode` / `nativeCatalogVersion` described here were replaced by the
> expression program of [native-expression-mode.md](archived/native-expression-mode.md).
> The two evidence booleans are unchanged; the example settings below predate
> the single catalog.


Branch: `refactor/evidence-only-context`, based on `feat/native-python-dataflow`
at `a056ae975`, which includes dependent operator batching and explicit observe.
This is a breaking context/API cleanup, not a relabeling of previous evaluations.

For the detailed current implementation reference, including formulas,
collection limits, shared-budget selection, and actual model-context examples
for all four configurations in DELTA/LATEST, see
[Data and flow evidence: computation and model context](data-flow-evidence.md).
The verification statements below describe the original cleanup checkpoint;
they are not a live campaign-status report.

## Supported contract

The only **evidence exposure** controls are `dataEvidence` and `flowEvidence`,
both booleans, both false by default. Layout and sample-size controls remain
independent. The four comparison configurations are:

| Arm | dataEvidence | flowEvidence |
| --- | --- | --- |
| No evidence | false | false |
| Data only | true | false |
| Flow only | false | true |
| Combined | true | true |

Use the same Python-native V2 operator catalog, tool schemas, model, result
budget, and physical profile collection setting for all four arms. Example:

```json
{
  "agentMode": "native",
  "nativeProfileCollection": true,
  "parallelToolCalls": false,
  "contextMode": "delta",
  "maxOperatorResultCharLimit": 2000,
  "dataEvidence": true,
  "flowEvidence": true
}
```

`nativeProfileCollection` is an engine collection control, not a third context
channel. Set it before creating operators; changing compiled collection policy
on an existing V2 workflow remains prohibited. Enabling exposure cannot invent
measurements that were not collected. Python client names are `data_evidence`
and `flow_evidence`; explicit false values survive serialization.

The [operator specification](native-python-dataflow-plan.md) remains the catalog
reference. Its historical level-based exposure mapping is superseded by this
document. Operators use typed parameters and Python functions, not SQL.

## What was removed

- Public `flowLevel`, `dataLevel`, `columnStats`, `valueFormat`, `dataHints`,
  `coercionTelemetry`, `rowLineage`, `statScopes`, and their old renderer aliases.
- The level registry/expansion, old column-statistics and structural/format
  decorators, loader/error/graph overlays, and moving end-of-context error list.
- Old statistics options on recall and render preferences, old role-policy
  statistics switches, and legacy stat-derived result diffs/selection features.
- The unsupported heuristic that output versus smallest-input row counts
  establish a join's exact unmatched-row count.
- Prompt instructions and examples advertising any removed overlay or tool
  parameter. `inspectResult` remains unavailable in every mode.

Creation and PATCH reject removed settings, even false/zero values. There is no
silent migration to the new booleans, and rejected PATCH requests are atomic.
Nested legacy column/flow rendering overrides are rejected as well.

Raw engine DTOs, dashboard inspection and historical trace parsing may still
contain `columnStats`: they are not context switches. The non-V2 schema adapter
can extract column names/types from old engine metadata; it does not render
metric values. V2 uses its typed result schema and versioned profile envelopes,
never these old display strings. Tests inject poisoned old fields and compare
the actual next-model messages byte-for-byte in both layouts and all four arms.

## Context-cost changes

Schema, sample records and enabled evidence share one per-result character
budget. This is not a new independent statistics allowance.

1. Complete small tables have priority; redundant data summaries are omitted.
2. For incomplete views, samples reserve up to 25% of the budget, or 75% for raw
   file previews. Remaining room is allocated to selected facts and more rows.
   Preview rows retain prefix order to expose headers beneath preambles.
   Long sampled string cells are visibly clipped (120 preview / 160 other).
   Complete tables are not clipped by this rule.
3. Raw preview transport columns do not get column-distribution facts; those
   facts describe line transport, not the parsed data the model needs.
4. Full result/input version bindings remain in immutable audit metadata;
   repeated hash/execution labels are no longer printed beside every result.
5. Unchanged null counters are not repeated as transformation evidence.
6. The prompt's operator field index no longer duplicates the full semantic
   descriptions already supplied by tool schemas. Dependent batch examples and
   explicit-observe guidance remain.

These are measured-byte and behavior changes, **not yet a demonstrated new
cost/accuracy result**. A fresh, separately named evaluation is required.

## Observation and error invariants

- Only `observe` retrieves successful operator contents. A batch can create an
  arbitrarily ordered dependency chain using the existing scheduler, and ask
  to see only its final operator. Cached observation does not execute it again.
- DELTA preserves event-owned result versions and evidence choices; later
  settings or failures do not rewrite previous messages. LATEST renders current
  explicitly observed results. Hidden receipts do not leak successful tables.
- Errors bypass result hiding and both evidence switches. Root errors retain
  diagnostic details. A blocked consumer uses a short root-error reference only
  when that matching root diagnostic is available in the same snapshot; otherwise
  it retains the details so the model does not lose its only explanation.
- Invalid input tables are labeled `INPUT_*`, with input index and producer ID,
  before a consumer function runs. Actual invalid outputs remain `OUTPUT_*`.
  This avoids telling the model to rewrite a consumer that never executed.
- Flow facts use version-matched inputs. UDF semantics remain unknown; matching
  input/output row counts are not proof of row identity or scientific validity.

## Verification and experiment isolation

Run from `agent-service`: `bun test` and `bun run typecheck`. Tests cover HTTP
validation, strict booleans, all four evidence arms in DELTA/LATEST, actual model
messages, observation ownership and compaction, dependent batching, budgets,
preview headers, root-error handling and real Python input/output contracts.
The KramaBench client adds `tests/test_evidence_only_settings.py` (five tests;
run with `python -m unittest discover -s tests -p test_evidence_only_settings.py`).

Final local verification: 1,058 agent-service tests passed (89 files, eight
snapshots), TypeScript checking passed, and all five new Python client tests
passed. Obsolete overlay suites were removed along with their implementations;
new negative tests verify rejected settings and absence from model context.

The old benchmark workspace, services and result directories are unchanged.
Historical SUTs that supply retired settings must run their historical revision;
they intentionally fail on this API rather than silently become new arms.
Future evaluations need fresh SUT names/output directories and pinned repository
and submodule revisions. Terra comparisons retain medium reasoning. No shared
service restart, new paid benchmark, or live backend E2E run was performed for
this cleanup; worker integration and message/HTTP tests run locally.
