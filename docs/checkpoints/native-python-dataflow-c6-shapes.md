<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements. See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership. The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License. You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# C6 partial: Python shape operators and local qualification

Date: 2026-09-15. Branch: `feat/native-python-dataflow`.
Shape implementation: **`2674cd458`**. Separate engine alias fix: **`e6a078f3f`**.
The batching ancestor remains `41cd8ae97`; no other workspace was modified.

This advances C6 but **does not complete integrated qualification**. No service
was started or restarted, no new live fixture ran, and no real LLM or KramaBench
run occurred. C4's expanded repair rerun, C5 live qualification, expanded error
inspection, real-model traces and C7 cost/accuracy measurements remain required.

## Delivered operators and rationale

The experimental V2 catalog now has nineteen operators. These five additions
cover generic table shape/order needs from the existing plan, not specialized
statistics or a copy of another system's entire operator catalog. They use the
same batch upsert, forward-reference scheduler and explicit `observe` protocol.
Generated Python still executes through DataLoading/DataProcessing boundaries;
there is no SQL expression API or SQL fallback.

| Operator | Public parameters after `op`, `id`, `input` | Enforced behavior |
| --- | --- | --- |
| Window | `partitionBy?`, `orderBy:[{col,desc?}]`, `columns:[{fn,col?,as,offset?}]` | Stable partition-local lag/lead/row_number/rank/dense_rank, then restore input order; one output per input row |
| Split | `column`, `into`, `separator`, `keepSource?` | Literal bounded split; padded nullable-string pieces; no row changes or implicit overwrites |
| Explode | `column`, `encoding:"json"`, `empty?` | Strict JSON-array scalar expansion, parent/element order; explicit drop/null-row policy |
| Unpivot | `columns`, `nameColumn?`, `valueColumn?` | Input-row then selected-column order, retaining null cells and other columns as keys |
| Pivot | `index`, `columns`, `values` | Unique index/pivot-key pairs only, first-seen order, measured dynamic schema; no implicit aggregation |

Exact defaults, null semantics, examples and exclusions remain in plan §§3.7–3.8.
Implementation choices made explicit there:

- Window outputs are unique new columns and all read the original input. Its
  private positional identity is independent of duplicated/non-contiguous pandas
  indexes. Null partition keys group together, null order values sort last, and
  equal order keys keep original order. Lag/lead preserve the source scalar type.
- Split never reuses an existing column name, even if dropping its source. An
  empty piece is an empty string, not a missing piece. Regex remains in callbacks.
- Explode requires one known scalar domain across all parents. Int/float and
  bool/int mixtures are errors, consistent with strict Union typing. Nonfinite
  numbers, int64 overflow, nested elements and nonstandard JSON constants fail.
  Empty/all-null output has a nullable string column; a later revision can
  change that dynamic type. `multiply`, not `add`, is its row-effect label because
  dropping empty parents can shrink the table.
- Unpivot does not run mixed rows through pandas float inference, preserving
  exact nullable int64 values above `2**53`. Conflicting known domains require
  Cast. Output names can reuse removed selected columns but not retained keys.
- Pivot rejects null category keys and colliding/empty generated names. Null
  index values are valid. Referenced fields must be distinct. An empty input
  yields only index columns and zero rows; `index:[]` has zero columns in that
  case. Duplicate pairs report their positions and a bounded key witness,
  directing the agent to Aggregate only when aggregation is intended.

UDF remains the escape hatch for rolling/custom windows, nested/mixed-array
normalization, unusual reshape operations and special-purpose analyses.

## Flow evidence and errors

No custom-statistics tool or extra evidence budget was added. The ordinary
collector transports operational metadata; C5's selector validates it against
output/input result versions and row counts before presenting it:

- Window: partition count, ties beyond the first, per-lag/lead boundary-null and
  total-null counts. Boundary absence is not confused with an already-null cell.
- Explode: input parents, output/array-element counts, empty parents, null
  elements and maximum elements per parent, respecting `empty` policy.
- Unpivot: `output = input rows * selected column count`, including null cells.
- Pivot: unique pairs, index groups, generated columns and absent cells. Check
  `unique pairs + absent cells = index groups * generated columns`. An absent
  cell is different from a present input pair whose value was null.
- Split: declared column dependencies and the enforced row/order guarantee.

Internal Explode parent/element witnesses are capped at sixteen with a
completeness flag; Unpivot stores a compact row-major mapping rule. Neither
adds synthetic user columns, infers arbitrary UDF lineage, or retains a full
unbounded row-lineage graph. They identify immediate input positions, not
complete source-file provenance. Large optional metadata can still be omitted
by the collector's existing payload budget without failing the data result.

Parameter/semantic failures use the existing revision-bound native diagnostic
channel: `WINDOW_ARGUMENT`, `SPLIT_ARGUMENT/TYPE`, `EXPLODE_ARGUMENT/JSON/TYPE`,
`UNPIVOT_ARGUMENT/TYPE`, `PIVOT_ARGUMENT/NULL_KEY/DUPLICATE`, plus common missing
column/collision errors. Preflight-invalid edits do not mutate the DAG; only
their dependent edits are blocked. Success hiding does not hide those receipts.
Expanded authenticated `inspectError` and the diagnostic-budget work in plan
§5 are **not delivered by this checkpoint**.

## Verification

Final local commands/results:

- `bun test`: **1,080 pass**, zero failures, 90 files, ten snapshots,
  6,043 assertions. `bun run typecheck`: pass.
- Native Python pytest suites (`test_native_v2_runtime.py`, `..._relational.py`,
  `..._scan.py`, `..._shapes.py`): **129 pass**, one dependency deprecation warning.
  The 52 new shape tests cover hand-computed semantics, malformed inputs,
  empty tables, type fidelity, private mapping bounds and local codecs.
- Full Python engine suite from `amber/src/main/python`,
  `../../../../.venv/bin/python -m pytest ../../test/python -q`:
  **1,129 pass**, one expected failure and one dependency deprecation warning.
- Generated-code tests execute a reversed chain containing all five shape
  operators, then revise its source while adding a new consumer through the
  unchanged DAG. The two new system-prompt examples validate and execute as
  written, producing the hand-computed answers. These are **not real LLM runs**.
- The real Python runtime and collector feed the production typed decoder,
  version storage and evidence selector across all nineteen operator types and
  thirty results, including empty shape outputs. Four exposure combinations
  remain within a 600-character result budget. Corrupt/stale shape metadata
  does not earn a relational measurement.
- A local codec test passes the five-operator chain through the engine's schema
  inference, tuples, Arrow IPC and schema-aware input reconstruction at every
  boundary, both populated and empty. Exact int64, nulls and reserved-looking
  user fields survive. This is stronger than pandas-only testing, but **not a
  distributed worker/JVM E2E test**.
- No Scala source/proto changed in this checkpoint. C5's previously recorded
  Scala/build results are not relabeled as fresh reruns.

The expanded engine run initially found an existing failure:
`TestUiParameterSupport.test_java_attribute_type_aliases_parse_like_python_names`.
It was independently reproduced on the untouched batching-parent worktree
`41cd8ae97`; that parent needed the candidate's generated proto package as a
fallback import path, while its own Python implementation/test paths stayed
first. The enum lacked public `INTEGER`/`BOOLEAN` aliases despite expecting them
in its API test. Separate commit `e6a078f3f` adds aliases of INT/BOOL, not new enum
or wire values. Added assertions preserve canonical names, iteration and wire/
Arrow mappings. The full rerun above passes; the original failure is not hidden.

Temporary logs use `/tmp/native-python-dataflow-c6-`: `shapes-python.log`,
`shapes-python-transport.log`, `python-all.log`, `shapes-ts-red.log`,
`shapes-ts-green.log`, `counter-red.log`, `evidence-red.log`,
`evidence-green.log`, `prompt-execution.log`, `bun-verified.log`,
`typecheck-verified.log`, `engine-python.log`, `parent-alias-test.log`,
`alias-red.log`, `engine-python-fixed.log`. Logs may expire; this document is
the durable sanitized checkpoint.

## Live gate and next work

`benchmark/e2e/native-shapes-run.ts` is prepared and typechecked, **not run**.
Its DELTA/LATEST cases exercise seven real debug steps each: reversed shape
chain, same-shape source revision/new consumer, cached observe, duplicate-pivot
failure with no observed successes, same-ID repair, empty dynamic schema that
invalidates a downstream column, and restoration. It checks actual service
snapshots/context, pinned history and its own workflow/CU cleanup. It launches
no services. C5's separate eight-case evidence fixture remains pending too.

The shared master was still PID 2114172 on port 8085 at verification; no candidate
agent was listening on 3011. No shared restart was attempted. Simply starting
a second master on another HTTP port is not currently a safe bypass: read-only
inspection found fixed HTTP/actor ports and global result-cleanup behavior.
No extra master or global configuration change was made. Coordinate a matching
engine idle window or explicitly establish safe compute isolation before live
qualification; do not infer idle state from a PID or an old lock file.

Next implementation task: expanded revision-pinned, authenticated error
inspection and bounded model-facing diagnostics. Then run the outstanding live
C3/C4/C5/C6 qualification against the matching C5+ engine and candidate Python,
capture actual real-LLM input messages for dependent batching/observe/repair,
and perform the planned one-task KramaBench pilot with official scores,
compile/execution pass and cache-aware cost. There is still **no measured
accuracy or cost improvement claim**, nor a claim that the full plan is done.
