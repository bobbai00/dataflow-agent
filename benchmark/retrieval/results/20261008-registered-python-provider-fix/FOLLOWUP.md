# Observation, failure, and caching follow-up — 2026-10-08

This follow-up answers the questions raised after the [system audit](SYSTEM_AUDIT.md)
and records the approved local patches. The numerical results below come from
the saved model runs, before these patches. No new provider calls were made.

## What execution exposes for the 179-column table

In original Luna and corrected DeepSeek biomedical step 2, execution reports
`153 rows × 179 columns`, lists the first 16 column names/types, and ends the
column list with `… +163 more`. It also reports scan completion and source/row
counts. It does not expose the complete schema or table rows.

The same-call `sample_stats` retrieval reports:

```text
records: sample_stats; 1 of 153 rows, 50 of 179 columns
(retained records, not a random sample; cut at 2,000 characters)
statistics: full table, 153 of 153 rows, 27 of 179 columns
```

All 179 names/types are retained internally. `Age` appears within those 50
retrieved columns, allowing the tasks to proceed. Earlier raw previews sometimes
exposed all names in an untyped header (DeepSeek did; Luna's sampled header was
clipped). This is not a reliable full-schema inspection contract. The inspection
gap is still open; this follow-up did not add a schema API or enlarge automatic
execution observations.

## Why the original errors repeated

The original nonblank JSON Schema pattern was `\S`. Some serving providers
constrained the whole generated string to this pattern, producing one-character
reasoning, operator IDs, and answers. Thus valid graph definitions could be
followed by execution of the wrong target, such as `1` or `*`. Later calls had
the same constrained schema, so ordinary feedback could not reliably elicit a
correct target. The paired provider probe and corrected six-task campaign
establish this mechanism; the anchored pattern is already fixed.

Repeated-failure protection would have limited wasted calls, not repaired the
schema. The registered path's missing guard remains a separate hardening item;
this follow-up explains it without implementing a new stopping policy. The
corrected runs' remaining failures were different: whitespace-bearing column
names, footer/null conversion, and retrieval before execution. Those were
repaired normally.

## Atomic edits and partial execution

Atomicity belongs to **one edit action**, including its Python definitions and
graph declarations. If any part is invalid, none of that edit commits. Earlier
successful edit actions remain. A failed edit skips subsequent actions, avoiding
execution against a definition the model tried but failed to install.

Execution does not roll back successful results. Disjoint requested upstream
groups already continue after a group fails. Siblings sharing an ancestor use
one engine controller, so a failure may interrupt a healthy sibling; explicitly
requesting that sibling can execute it afterward.

The new patch permits later requested execute/read actions in the **same call**
after an execution failure:

```text
execute [bad]       → error
execute [good]      → runs
retrieve [bad,good] → per-target error and successful result
```

Later edits remain skipped; once an edit is skipped, subsequent executions are
also skipped so they cannot use the old graph as though that edit succeeded.
Repair definitions in the next call. The overall call remains an error while
preserving each action's outcome. Cancellation still stops further actions.
The prompt, tool description, design document, and generated references now
describe this behavior.

“Source refresh” means rereading external inputs—such as a CSV replaced at the
same path—while the graph definition remains unchanged. It is different from
invalidating results after editing a function. These benchmark inputs were
static; no refresh implementation was added. Immutable session inputs remain
the simple operating assumption until an explicit, snapshot-preserving refresh
contract is chosen.

## Prompt caching, calls, and cost

Measured cohort: the original Luna/Terra/Sol/Opus runs and corrected Qwen/DeepSeek
runs, three tasks each. All **67 adjacent wire-request pairs** preserve the
previous message array exactly as a prefix, with zero tool-schema changes.
Registered functions are introduced through appended messages rather than
changes to the tool catalog. The gateway's Anthropic routes also configure cache
breakpoints for the stable prefix.

These cache fractions are observed read tokens divided by total input tokens,
including initial calls; they are not cold-start model rankings. Input/output
totals below sum all calls in a task, including repeated cached input. They are
not maximum context lengths.

| Model | Calls per task | Cache-read fraction | Mean input/task | Mean output/task | Frozen-rate estimate, all 3 tasks |
| --- | --- | ---: | ---: | ---: | ---: |
| GPT 5.6 Luna | 3–4 | 78.4% | 27,178 | 709 | $0.007349 |
| GPT 5.6 Terra | 3–4 | 74.0% | 38,838 | 679 | $0.102238 |
| GPT 5.6 Sol | 3 | 63.1% | 42,231 | 556 | $0.252371 |
| Claude Opus 4.8 | 3–6 | 78.4% | 131,944 | 1,072 | $0.768885 |
| Qwen3.8-27B | 8–12 | 83.6% | 107,951 | 1,948 | $0.060476 |
| DeepSeekV4.1-Flash | 4–6 | 77.9% | 50,418 | 1,198 | $0.015069 |

Provider-reported totals are available for Qwen ($0.023575) and DeepSeek
($0.010152), separately from the public-rate estimates. Scoring and infrastructure
costs are excluded. Cache reads and writes are disjoint subsets of input;
reasoning is already included in output and is not charged again.

**Accounting limitation:** saved OpenAI responses expose cache reads but omit
cache-write counts. The historical estimate treats remaining unclassified input
at the ordinary input rate; it cannot establish exact cache-write billing. The
accounting patch now records `cache_usage_reporting` and
`cost_estimate_assumptions`, distinguishing missing/null counters from explicit
zero while preserving original counters, estimates, and provider-reported cost.
Missing optional classifications do not invalidate captured total usage. Old
campaign artifacts were not rewritten.

The [official OpenAI caching documentation](https://developers.openai.com/api/docs/guides/prompt-caching)
confirms that caching reuses matching prompt prefixes; it reduces repeated
processing/cost but does not remove logical context or model calls. Actual
captured usage, rather than prefix equality alone, establishes cache hits here.

### What to reduce next

The largest avoidable input growth came from wide raw workbook previews, not
prefix instability. The pilot overrides the current 5,000-character full-view
display default with **100,000 characters per operator**.

| Biomedical model | Preview rows per sheet | Raw preview text, two results | Next request input |
| --- | ---: | ---: | ---: |
| Opus | 30 | 72,064 + 29,369 characters | 75,932 tokens |
| Sol | 20 | 48,309 + 19,804 characters | 40,563 tokens |
| Corrected Qwen | 10 | 24,598 + 10,211 characters | 29,418 tokens |

Each preview row embeds all source fields in one raw line; the metadata header
alone is 3,701 characters. Multiple sheets multiply the row count. These models
then performed parsed scans of selected sheets anyway. Opus's large observation
added 65,515 cache-write tokens before later requests could reuse it.

Use a smaller display cap in the next campaign, keep the separate 100,000-character
transport retention, and start workbook discovery with one to three preview
rows before increasing it for a genuine layout question. Batch edit → execute →
retrieve whenever their arguments are already known. Qwen unnecessarily split
some of those actions across calls; data-dependent repair still needs another
model decision. The existing runner hardcodes its historical 100,000-character
experiment setting, so changing the service default alone does not alter that
campaign. Preserve the chosen cap in each future manifest.

## Implemented in this follow-up

- Compact scan identity survives wide-profile truncation; optional source-detail
  omissions and missing identities are distinct. Verified single-worker identity
  survives unavailable statistics. Multiple-worker native provenance remains
  explicitly unknown.
- Registered Python records bounded witnessed pandas reads/events with definition
  cell and line attribution. Arbitrary Python lineage remains unknown.
- Schema compilation has a 15-second deadline and respects cancellation. Engine
  phase metrics persist in `execute.output.execution_runs`, including failures
  and independent groups, without entering Markdown observations.
- Statistical extrema retain precision; batched retrieval no longer repeats its
  schema. Exact-column hints only apply to witnessed, unambiguous DataFrame
  lookup failures; arbitrary dictionary KeyErrors and ambiguous names are left
  unchanged.
- Explicit execution can continue after a prior execution failure, subject to
  the skipped-edit boundary above. Cost estimates disclose missing cache classes.

The complete-schema inspection API, a repeated-failure stopping policy, source
refresh, and new registration/transfer/persistence timing spans remain separate
work. No live service restart or paid model rerun is claimed for these patches.

Validation: the full Bun run passed 1,454 tests; 17 local-server tests initially
could not bind sandboxed loopback ports. Rerunning their three files with
loopback permission passed all 21 tests (including those 17), covering all
1,471 tests successfully across the runs. The 36 Python profile tests and 16
accounting/campaign tests passed; TypeScript typecheck and diff checks passed.
Focused runtime/profile tests also passed after final formatting.
