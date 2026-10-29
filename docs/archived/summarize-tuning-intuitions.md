# Tuning `summarize()` for accuracy-at-lower-cost — intuitions, traces, and a tuner design

*Grounded in the KramaBench corpus: 60 runnable tasks, their gold reference pipelines
(`~/Desktop/bobflow/Kramabench/solutions/`), the recorded agent trajectories
(`llm-training-set-v1-kramabench/<task>/react_steps.json`), the real data files, and the
agent's own system prompt (`prompts/code-mode.md`).*

---

## 0. The central tension, in corpus numbers

| signal | value | source |
|---|---|---|
| tasks | 60 (28 easy / 32 hard) | ground_truth |
| exact-answer tasks (no partial credit) | **50 / 60** (numeric_exact 24, string_exact 15, list_exact 11) | ground_truth |
| multi-file tasks | **33 / 60** (up to **22 files** — environment-easy-2) | ground_truth |
| recorded pass rate | **39/60 strict exact-match** · 55/60 graded (f1/rae/paraphrase) | evaluation.json |
| hard failures (fail even the graded metric) | **5** (all in the long/thrashy bucket) | stats.json |
| tasks that **thrash** (≥3 edits to one operator) | **26 / 60 (43%)**; 12 tasks ≥8× | react_steps |
| agent steps | median 8, **max 48** | react_steps |
| input tokens per task | median 42k, **max 446k** (30× spread) | stats.json |
| **cost concentration** | top-10 tasks = **51% of all tokens** (corpus ≈ 5.3M) | stats.json |
| PASS vs FAIL profile | PASS: 8 steps / 44k tok / 12k ctx · **FAIL: 23 steps / 238k tok / 37k ctx** | stats.json |
| last-step context size | median 12k chars, p90 34k, max 58k | react_steps |

**Quirk frequency across the 60 gold solutions** (what the data actually forces the agent to do):

| quirk | tasks | % | what it forces |
|---|---|---|---|
| `colsub` (column projection) | 46 | 77% | near-universal, low signal |
| `dirtyload` (skiprows/header/sep/encoding/multi-sheet/custom parser) | **35** | **58%** | must see raw bytes at load |
| `numclean` (numbers-as-text: `$` `,` `%` units) | **31** | **52%** | value-format hint / raw sample |
| `join` (merge/concat/cross-match) | 21 | 35% | join-key stats + join alarms |
| `dropna`/sentinel | 16 | 27% | must know the sentinel (`M`, `-999`, `N/A`, `NULL`) |
| `dateparse` | 12 | 20% | — |
| `glob`/loop-over-files | 10 | 17% | the many-source blowup |
| `mixedcase` (str.lower/strip compare) | 9 | 15% | exact categorical value set |

Shapes: multi-file-join 19, single-file-multistep 15, documentation/custom-parser 11, glob-aggregate 9,
single-file-scalar 6. **`dirtyload`+`numclean` co-occur in 28 tasks** (the legal + wildfire-TSV files).
**The legal domain (18 tasks) is a uniform load-quirk minefield** — nearly all need `skiprows=2`, a
non-UTF-8 encoding, or a custom multi-block parser, plus `$`/`,`/`%` stripping, plus **trailing spaces
baked into header names** (`'Fraud '`, `' Total $ Loss'`). This domain-level regularity is itself a
tuner signal (see §3B).

Two facts drive everything:

1. **Cost is dominated by a long tail of thrashy trajectories.** The median task is cheap
   (8 steps, 42k tokens). The 416k-token max is a task that re-edited one operator 15–22
   times, re-rendering its result table every step. Cost is not spent uniformly — it is spent
   *thrashing on one stuck operator* while *re-rendering N settled operators around it.*

2. **Cost and accuracy fail together.** The top of both the thrash ranking and the
   context-size ranking is dominated by `success=false`: `wildfire-hard-7` (22 edits, fail),
   `wildfire-hard-17` (58k ctx, fail), `environment-hard-9` (54k ctx, fail), `legal-easy-25/26`
   (15–17 edits, fail). Bloat is not the price of accuracy — it is *correlated with losing it.*

So the tuner's objective — maximize accuracy, minimize tokens — is **not** a pure trade-off
across the board. There is a large **free-lunch region** (cut cost with zero accuracy risk) and
a small **insurance region** (spend a few tokens to prevent a wrong commit). The trade-off only
bites in a narrow middle. The categories below separate these three regions.

**Two decisive corroborations from the recorded trajectories** (they change *where* to aim):

1. **The free-lunch region is confirmed large and safe.** Analyzing the 5 hard failures: *none*
   was caused by context bloat or by anything being dropped. They are join dead-ends
   (`wildfire-hard-17` averaged all 2 965 RAWS stations instead of the fire subset),
   missing-file proxies (`wildfire-hard-21` substituted a wrong column for an absent `ZHVI.csv`),
   a missed sub-column (`environment-hard-9` processed Pleasure Bay but never extracted the
   Castle Island columns in the same wide file), and definition/alignment errors
   (`astronomy-hard-10` correlation sign flip). **Aggressive context reduction is low accuracy
   risk here** — and, tellingly, a full **column inventory** would have *prevented* two of these
   (the missing Castle Island column and the absent ZHVI key), so schema/stats is
   *accuracy-positive*, not merely cost-neutral.

2. **Columns, not rows, are the cost.** The result preview already caps to ~1–6 rows
   (head-2/tail-2) regardless of table length, so *rows are already cheap* — the ceiling on
   "shrink `sampleRows`" is small. The real per-block driver is **width**: a 179-column
   biomedical metadata table renders ~5 200 chars/block (≈3 000 of which is just the header
   line), re-rendered ~18× in one task. **Column-cap + column-stats-instead-of-raw dominate
   row-shrink by a wide margin.** (This reorders the levers in §5.)

**A cost-mode caveat that clarifies what `summarize()` even controls.** In these *recorded*
(older, DELTA-style) traces, 68% of input chars is **event-log history** — every Thought +
`summary=` + link confirmation, re-sent every step (85–89% on thrashy tasks) — and only 32% is
the re-rendered Current-Dataflow tables. **LATEST mode (the current default) eliminates the
event-log by construction** — it sends only the current snapshot — so under today's default the
*entire* remaining cost is exactly the per-operator table re-render that Categories A/B/D target.
In other words: choosing LATEST already banked the 68%; the summarize() params are now aimed
squarely at the residual, and the stale-source lever below is the biggest remaining prize.

---

## 1. The prescribed action sequence, and where cost/accuracy live

The system prompt (`code-mode.md`) + worked example (`example.latest.md`) prescribe a fixed
five-phase shape. Every KramaBench gold solution is an instance of it:

```
LOAD  ─▶  INSPECT  ─▶  TRANSFORM  ─▶  DEBUG (loop)  ─▶  COMMIT
(parallel   (read schema/  (decompose:    (modify the      (terminal op
 file        stats/sample;  filter→norm→   failing op in    outputs the
 loads)      re-load if     join→agg,      place, reading   answer in the
             messy)         one op each)   upstream cols)   exact shape)
```

- **Accuracy is won or lost at INSPECT and DEBUG.** INSPECT is where the agent learns the real
  columns, dtypes, categorical encodings, and grain — the facts that decide whether the filter
  cohort and join keys are right. DEBUG is where a `KeyError`/wrong-value gets fixed against the
  upstream's *actual* columns. **50/60 tasks are exact-answer**, so a single silent wrong-cohort
  or wrong-dtype at these phases = 0 credit.

- **Cost is spent everywhere else** — re-rendering every operator's result table on every step
  (LATEST) or every event (DELTA), especially large SOURCE tables that were relevant only at
  INSPECT and are dead weight by TRANSFORM.

The whole game: **concentrate detail at the frontier (the operator being inspected/debugged
right now) and starve everything that has settled — without starving the one signal that
prevents a wrong commit.**

---

## 2. How each `summarize()` parameter moves cost and accuracy

| parameter | cost lever | accuracy lever | when it earns its tokens |
|---|---|---|---|
| `result.latest.detail` (omit/shape/sample) | **huge** — a full raw block on a *wide* table is the biggest single cost | high at INSPECT/DEBUG, ~0 on settled ops | sample: frontier + dirty loads + answer op; shape: settled interior; omit: dead/blocked ops |
| **column cap** (wide-table first/last-N) | **huge on wide tables** — a 179-col header alone is ~3k chars | ~0 (you rarely need all 179) | mandatory on wide sources (biomedical 179/312, OMNI2 57, noaa 37) |
| `result.latest.tuple.sampleRows` | **small** — preview already caps to ~1–6 rows; low ceiling | matters only where raw values must be eyeballed | minor lever; don't over-invest. Keep raw rows on *loads being parsed*, trim elsewhere |
| `column.stats` + `statsMetrics` | medium (cheaper than a wide raw block) | **high** for cohort/key/plausibility — *and can prevent failures* (missing-column, poison sentinels) | the cheapest way to expose categorical encodings, join-key validity, fill-value sentinels |
| `column.schema` (+ `schemaTypes`) | tiny | high — exact column names/types | always cheap; the antidote to `KeyError`, trailing-space headers (`'Fraud '`), and *missed columns in wide files* |
| `column.valueFormatHints` | tiny | high on numbers-as-text | currency/comma/percent columns before `to_numeric` |
| `column.structuralHints` (Data hints) | small | high — grain/key/dup/dirty-load | the wrong-grain / wrong-population silent killer |
| `property.includeCode` | medium | low–medium | only when reasoning about current logic without an error |
| `property.codeHistory` / `result.history` | medium | **high on thrash** | the stuck operator only — recovers what LATEST strips |
| `trajectory.events` (none/interleaved) | **huge** (interleaved = super-linear) | medium | interleaved only when order-of-operations matters; else LATEST |
| `trajectory.reasoningReplayK` | small (K short lines) | medium — keeps the plan | small K always; larger on long multi-file plans |
| `trajectory.window`+`compaction` | caps the tail | neutral if tuned | only when the trajectory would overflow (rare: median 8 steps) |
| `flow.loaderHints` | tiny | high on dirty loads | failed `DataLoading` ops |
| `flow.errorContext` | small | **high** — the KeyError fix | errored `process` ops (shows upstream real columns) |
| `flow.cardinalityAlarms` | tiny | **high** — silent wrong-cohort | empty-output / fan-out transitions |
| `flow.joinAlarms` / `coercionAlerts` | tiny | high on join / numclean tasks | multi-file joins; `errors='coerce'` dataloss |

Read the two right columns as: **most accuracy levers are cheap** (schema, stats, the flow
alarms) and **the expensive lever is raw rows** — which is exactly the one that's dead weight
almost everywhere except the frontier. That asymmetry is the whole opportunity.

---

## 3. The intuitions, categorized

Five categories. **A + D are the free-lunch region** (cut cost, accuracy-neutral). **B + E are
the insurance region** (cheap tokens that prevent wrong commits). **C is the genuine
trade-off** (history costs, but converts thrash into convergence).

### Category A — Role-and-state-based allocation *(spatial: spend on the frontier, starve the settled)*

The value of an operator's rendered result is a function of its **role** and **state**, not
uniform. This is the single biggest lever.

- **A.1 — The frontier operator gets everything.** The operator the agent just created, just
  edited, or that just errored is where the next decision is made. Full sample + stats +
  schema + (on error) upstream error context + (on thrash) code/result history. Everything else
  is scenery.
- **A.2 — Settled interior operators decay to shape+schema.** An operator that executed OK, has
  a healthy downstream consuming it, and hasn't been touched in K steps no longer needs its raw
  rows — the transform that reads it has already been written and validated. Downgrade
  `detail: sample → shape`, keep `schema`. In the worked example, once `recent_orders` is built
  and correct, the 10 000-row `customers` sample is dead weight.
- **A.3 — Source/load operators are relevant only until their first correct consumer exists.**
  A source table's raw sample matters at INSPECT (is it parsed right?). The instant a downstream
  operator successfully consumes it, the source's job is done — downgrade to shape+schema (keep
  schema so column names stay checkable). *This is the user's stated intuition — now
  quantified:* DataLoading result blocks are **16% of all input chars**, and **84% of that is
  re-rendered ≥2 steps after the source's cleaner already exists** → **stale-source re-render ≈
  13.6% of ALL input tokens (~600k corpus-wide)**, at **90–96% stale on the worst multi-file
  tasks** (`biomedical-hard-4` ~68k wasted tokens, `wildfire-hard-21` ~63k). It is the single
  largest safe saving under LATEST mode. Corroborating evidence: the few trajectories that
  *manually* delete consumed sources (`environment-hard-11` deleted 8/8, `wildfire-hard-20` 6/6)
  show visible context drops and still pass — but only 56 of 510 operators were ever deleted
  corpus-wide, so **the agent almost never does this itself — the renderer must.**
- **A.4 — The terminal/answer operator never decays.** It *is* the answer; always full sample.
- **A.5 — Blocked operators go to shape/omit.** An operator whose upstream errored has a
  meaningless/empty result; render shape only and rely on the flow "needs attention" pointer to
  the real root cause. Rendering its empty table wastes tokens and misdirects.

> **A in one line:** detail(op) = f(role ∈ {source, interior, frontier, terminal, blocked},
> steps-since-touched, has-healthy-consumer, is-erroring). Only *frontier* and *terminal* justify
> raw rows.

### Category B — Data-shape-driven detail *(let the data's dirtiness pick raw-vs-stats)*

Whether raw rows are worth their tokens depends on the **data**, and this is knowable from the
result annotations themselves — which makes it tunable per-operator, per-file.

- **B.1 — Dirty-load files demand raw bytes at load; nothing else does.** `skiprows`
  (wildfire-easy-1 =3, legal-easy-10/25 =2), multi-index headers
  (environment-hard-11 `header=[0,1]`), wrong delimiters, unstructured text
  (astronomy regex over `.txt`). Here the **schema is a lie** until parsed right (`Unnamed: 0`,
  a value-as-header), so stats are worthless and the raw sample is mandatory — but *only at the
  load phase*, and *only for that file*.
- **B.2 — Categorical filters need the exact value set, and stats are the cheap way to show
  it.** When the answer hinges on `== 'Greece'`, `.isin(['Endometrioid','Serous'])`, or a
  yes/no flag, the agent must see the **exact** filter tokens. `column.stats` with
  `top_5/top_10` (when distinct ≤ threshold) shows the whole value distribution in *one line per
  column* — strictly cheaper and more complete than hoping the right value appears in N sample
  rows. Prefer low-cardinality stats over raw rows for categorical-filter tasks.
- **B.3 — Numbers-wearing-punctuation need a targeted signal, not a schema line.** Thousands
  commas (legal-easy-10 `.str.replace(',','')`), `$`, `%`, "12 or 14" (archeology-easy-3). The
  schema says `str` but doesn't say *why*; `valueFormatHints` is a one-line, high-precision flag
  that says "strip commas before `to_numeric`." Cheap insurance against silent coercion.
- **B.4 — Clean, wide, uniform tables: schema + selected stats, never raw rows, cap columns.**
  A 300-column numeric matrix (biomedical proteomics) adds nothing in raw rows; the schema +
  a few column stats confirm plausibility. Column-cap is mandatory here.
- **B.5 — Clean narrow lookups: a 3-row sample is fine and already cheap.** Don't over-optimize
  a tiny table.
- **B.6 — Silent-poison sentinels must be surfaced, and stats do it.** OMNI2 (astronomy) uses
  fill values `999999.99`/`99999.99`; noaa monthly uses `-999`; environment uses `M`. These
  silently corrupt any mean/aggregation. `column.stats` (min/max/mean) makes them jump out
  (`max=999999.99`) in one line — a raw sample might not even include the poisoned row.

> **B in one line:** raw-rows-value(op) is high iff the load is dirty OR a downstream filter must
> match an exact value the stats can't summarize; otherwise schema+stats dominate at a fraction
> of the cost.

**The corpus gives an empirical clean-vs-messy split the tuner can hard-code as a prior** (files
actually referenced by tasks):

- **Schema+stats sufficient → safe to drop raw rows** (Tier-1 free lunch): `worldcities.csv`
  (clean, but 45k rows — *especially* drop rows here), `water-body-testing-*.csv` (×22),
  `environmental-justice-populations.csv`, `hyperactivated.csv`, `annual_aqi_by_county_2024.csv`,
  `Wildfire_Acres_by_State.csv`, `Sat_Density/*.csv`, `new_england_states.csv`,
  `state_abbreviation_to_state.json`.
- **Must see raw bytes → keep sample at load** (Tier-3, never downgrade before a correct
  consumer): environment **beach datasheets** (3-row header, repeated paired cols, `<`
  below-detect, variable col count), **all legal CSN + per-state MSA files** (title/blank/header
  preamble; `Top_Three_…by_Year` even has a *header swapped vs its data*), wildfire **`nifc_*`
  (tab-delimited)** and **`PublicView_RAWS`** (every value unit-suffixed: `98 % `, `34 deg. F`,
  `23.8 (unk)`, + BOM + embedded newlines), **`noaa_wildfires`** (single-letter cause codes
  decoded only via a companion dictionary), **`noaa_..._monthly_stats`** (header at row 3 under a
  `-999` preamble), astronomy **OMNI2** (57 cols + fill sentinels) and **`geomag_forecast/*.txt`**
  (free-form bulletin, regex-only), biomedical **`mmc2–mmc7.xlsx`** (README sheet + sheet pick;
  `mmc2` is a *transposed* samples-as-columns matrix).
- **Wide-table column-cap mandatory:** `mmc5-B`(312), `mmc1`(179), `mmc2`(154), OMNI2(57),
  `noaa_wildfires`(37), `PublicView_RAWS`(36).
- **Not pandas-loadable at all** (the tuner should recognize and not waste a sample budget):
  `.gpkg` GeoPackages (geopandas), `.npz` (numpy), empty `ZHVI.csv`.

**Domain is a strong prior for the load-phase policy:** *legal* → always assume dirty
(skiprows+numclean+trailing-space headers), keep raw sample + schema + valueFormatHints on every
load; *biomedical* → xlsx multi-sheet + wide, cap columns, sheet-name listing matters; *wildfire*
→ heterogeneous (probe delimiter, unit-suffixed values, sentinels); *archeology/parts of
environment* → mostly clean, downgrade sources aggressively.

### Category C — Temporal / history allocation *(carry the past only when stuck)* — the real trade-off

- **C.1 — LATEST is the correct cheap default.** For the median task (8 steps, no thrash) the
  current snapshot is sufficient; interleaved DELTA history is pure overhead. Don't pay for
  history the agent doesn't need.
- **C.2 — On thrash, inject targeted history for the stuck operator only — this is the true
  thrash fix.** The recorded traces confirm a structural cause: **operator code is *never* in
  the rendered context** (no `import`, no fences, no tracebacks appear in any final context), so
  on a messy-CSV parse loop the agent **rewrites `read_csv` params blind, unable to recall what
  it already tried** — e.g. `wildfire-hard-7` rewrote its loader **22×** on "parsed as a single
  column, delimiter may not be comma"; `legal-easy-25/26/27` toggled `skiprows`/`header=`
  **15–17×** on the same title-row CSVs. Thrash tasks cost **~3.7× median** (108k vs 29k tok) —
  yet **22/26 still pass**, so thrash is overwhelmingly a *cost* problem the agent grinds
  through, not an accuracy one. Turning on `property.includeCode` + `codeHistory` +
  `result.history` + `flow.errorReflection` **for the stuck operator** (its current code + the
  diff vs the last attempt + the distinct errors) is what collapses a 15-edit loop toward ~3.
  The token math is decisive: adding ~300 chars of code to an op re-edited 15× is trivial next
  to eliminating 12 re-render cycles of the whole context. Scope it to the in-focus op only, or
  it re-inflates cost.
- **C.3 — Keep a short reasoning replay always.** `reasoningReplayK` = 5–10 short lines keeps
  the plan alive between steps (cheap); widen it for long multi-file plans where the agent
  loses track of which files it has loaded.
- **C.4 — Windowed compaction is for the tail only.** Median 8 steps never overflows; reserve
  `window`+`compress` for the 48-step outliers, where folding the settled prefix into a stats
  deck caps the tail without dropping the structure a slide-window would lose.

### Category D — Negative space *(free cuts: cost down, accuracy-neutral)*

- **D.1 — Omit deleted/superseded inspection operators entirely.** The prompt tells the agent to
  delete throwaway `inspect_*` ops; whether or not it does, their result should never render once
  a real loader exists.
- **D.2 — Tighten row caps as the pipeline narrows.** A source `sampleRows` of 3–5 is plenty
  once settled; the frontier can have 10–15; the 1-row answer op is full by definition.
- **D.3 — Column-cap wide tables** (first/last N, drop the middle) — already load-bearing for the
  300-col matrices.
- **D.4 — Drop `Properties`/`print` output unless actively debugging.**
- **D.5 — Never render both interleaved observations *and* a current-snapshot for the same
  state** — the precedence rule already enforces this; the tuner should not fight it.

### Category E — Failure-targeted decoration *(cheap accuracy insurance)*

All of these are ≤ a few lines and each targets a specific silent-failure class from the corpus:

- **E.1 `loaderHints`** on failed loads — exception-class remediation; directly shortens the
  dirty-load thrash loop (the legal-easy-25 death spiral).
- **E.2 `errorContext`** on errored `process` ops — surfaces the upstream's *real* columns, which
  is where the `KeyError` fix lives (the prompt says so; this makes it visible without a re-inspect).
- **E.3 `cardinalityAlarms`** — flags empty-output and fan-out transitions. This is the antidote
  to the **silent wrong-cohort** failure (a spurious filter that shrinks the denominator, or a
  join that explodes rows) — invisible in a scalar answer, fatal for exact-match scoring.
- **E.4 `coercionAlerts`** — catches `to_numeric/to_datetime(errors='coerce')` nulling a block of
  values (the numclean tasks).
- **E.5 `joinAlarms`** — near-zero-key-match / m:n fan-out on the 33 multi-file tasks.

> The E-rungs are the reason a *smaller* context can be *more* accurate: they replace "hope the
> model notices the anomaly in a giant raw dump" with "state the anomaly in one line."

---

## 4. Per-archetype action + parameter traces

Each archetype below is a **policy**: the action sequence (fixed by the system prompt) paired
with the `summarize()` params the tuner should apply *at each step*. Params are shown as deltas
from a lean base preset. `overrides.<op>` = per-operator. The point is that the param vector
**changes across the trajectory** as operators change role — that sequence is what a tuner learns.

**Lean base preset** (the cheap default all archetypes start from):
```jsonc
{ trajectory: { events: "none", reasoningReplayK: 8 },
  currentSnapshot: true,
  flow: { cardinalityAlarms: true, errorContext: true, loaderHints: true },  // cheap E-insurance, always on
  operators: { defaults: { result: { latest: { detail: "sample",
                                               tuple: { sampleRows: 8 },
                                               column: { schema: true, stats: false } } } } } }
```

### Archetype 1 — single-file clean scalar  *(archeology-easy-3, environment-easy-1; load→filter→agg→answer)*

| step | action | param delta | why |
|---|---|---|---|
| 1 | load file | base | need a sample to confirm clean parse |
| 2 | inspect | `overrides.<src>.column.stats=true` (top-N) | expose the categorical value set for the filter (`Country` values; `Violation` yes/no) — one line, high value |
| 3 | filter→aggregate | `overrides.<src>.result.latest.detail="shape"` | source consumed; drop its rows. frontier=the new op (sample) |
| 4 | commit | terminal op full sample; everything else shape | answer visibility only where it is the answer |

Net: after step 3 the big source table stops re-rendering. Cost stays flat instead of carrying
the 15 000-row sample to the end.

### Archetype 2 — single-file dirty-load  *(wildfire-easy-1 skiprows=3, legal-easy-10 skiprows=2, environment-hard-11 multi-header)*

| step | action | param delta | why |
|---|---|---|---|
| 1 | naive load (will look wrong) | base + `loaderHints` on | raw sample reveals `Unnamed`/value-as-header; hint suggests skiprows/sep |
| 2 | **re-load with skiprows/header/sep** (frontier=same op, thrash risk) | `overrides.<src>`: keep `detail="sample"`, add `column.structuralHints=true`; on the **2nd+ re-edit** turn on `property.codeHistory=1` + `result.history.lastK=1` | this is the thrash hotspot (legal-easy-25 failed here 15×). History shows the diff so it stops repeating; structural hints confirm the reparse |
| 3 | transform | downgrade `<src>` to `shape`; frontier moves to the transform op | source parsed correctly → sample now dead |
| 4 | commit | terminal full | |

Net: history is spent *only* on the operator that is actually stuck, and *only* once it has
re-edited — the 43% thrash tax is paid surgically, not globally.

### Archetype 3 — categorical / value-exact filter  *(biomedical `.isin([...])`, any yes/no)*

| step | action | param delta | why |
|---|---|---|---|
| 1 | load | base | |
| 2 | inspect | `overrides.<src>.column.stats=true`, `statsMetrics=["distinct","top"]`; `result.latest.detail="shape"` (rows optional) | the exact value set is the whole ballgame; top-N stats show it in one line and let you *drop* raw rows |
| 3 | filter-exact | frontier=new op, `cardinalityAlarms` on | alarm catches an over-restrictive filter (empty/near-empty output) |
| 4+ | compute | source→shape | |

Net: for value-exact tasks, stats *replace* raw rows — cheaper **and** more reliable (you see
the whole distribution, not a lucky sample).

### Archetype 4 — multi-file join  *(biomedical-hard-1, environment-hard-14)*

| step | action | param delta | why |
|---|---|---|---|
| 1 | **parallel load** all files | base; each source `sampleRows=5` | confirm each parsed; small samples |
| 2 | inspect join keys | `overrides.<each src>.column.stats=true` (`distinct`,`null`); `detail="shape"` | join-key validity = compare distinct vs row counts; raw rows unneeded |
| 3 | join | frontier=join op sample; **`joinAlarms` on**; sources→shape | catch near-zero-match / fan-out immediately; sources now dead |
| 4+ | filter/compute | keep only the join op + frontier at sample | |
| commit | terminal full | |

Net: N source tables collapse to shape+key-stats right after the join is validated — the biggest
multi-file saving.

### Archetype 5 — many-file glob-aggregate  *(environment-easy-2 = 22 files, environment-hard-9 = 9)*

| step | action | param delta | why |
|---|---|---|---|
| 1 | load all (glob / parallel) | **`sampleRows=3` on sources**; verify **one** representative fully | 22 identical-schema files — you validate the pattern once |
| 2 | inspect one, assume rest | all sources except the probe → `detail="shape"` (schema only) | 21 redundant samples are pure waste; schema confirms uniformity |
| 3 | concat/aggregate | frontier=agg op sample; `cardinalityAlarms` on | catch a mis-globbed/short file via row-count anomaly |
| 4 | commit | terminal full | |

Net: the extreme cost archetype. Naively this is 22 raw samples every step; the policy renders
1 sample + 21 schema lines. This is where source-downgrade saves the most tokens per task, at
zero accuracy cost (the files are uniform by construction).

### Archetype 6 — numeric-clean / list_exact  *(legal-easy-10 → list of years; legal `Median Fraud Loss`)*

| step | action | param delta | why |
|---|---|---|---|
| 1 | load | base + `valueFormatHints` on | flag comma/`$`/`%` columns at first sight |
| 2 | clean (strip → numeric) | `coercionAlerts` on; frontier sample | catch `to_numeric(coerce)` nulling rows silently |
| 3 | aggregate / rank | source→shape; frontier sample; `cardinalityAlarms` | list_exact = every element must be right; alarms guard the cohort |
| commit | terminal full (list is the answer) | | |

---

## 5. Safe vs. risky parameters — the tuner's priority order

Sorting the action space by risk tells the tuner where to search greedily vs. carefully.

**Tier 1 — monotone-safe free lunches (cut first, no accuracy model needed), in impact order:**
1. **decay settled source/interior operators `sample → shape` once they have a healthy
   consumer** (A.2, A.3) — *the biggest single win: ~13.6% of all tokens, ~600k corpus-wide.*
2. **omit deleted/blocked operators' results** (D.1, A.5) — most inspection ops are never
   deleted by the agent (56/510), so the renderer must drop them.
3. **column-cap wide tables** (D.3) — a 179-col header line alone is ~3k chars; the top-7 most
   expensive blocks in the corpus are all wide biomedical metadata.
4. drop Properties/print unless debugging (D.4).
5. tighten source `sampleRows` to 3–5 (D.2) — *smallest* of the Tier-1 wins (rows already
   capped to ~1–6), listed last on purpose.

These are provably accuracy-neutral in the corpus: a consumed, non-erroring source's raw rows
are never re-read, and *no* observed failure was caused by dropping anything. A tuner can apply
all of Tier 1 unconditionally and only *then* worry about the rest. (Note the ordering: the
user's original "shrink source sample size" intuition is *directionally right but is the
weakest lever* — the same intuition applied to **whole-block decay + column-cap** is where the
tokens actually are.)

**Tier 2 — cheap accuracy insurance (turn ON in the right place; near-free):**
- schema line always; `cardinalityAlarms`, `errorContext`, `loaderHints` always on (E.1–E.3)
- `column.stats` top-N on categorical-filter columns; `valueFormatHints`/`coercionAlerts` on
  numclean; `joinAlarms` on multi-file (B.2, B.3, E.4, E.5)

The risk here is *omission*, not commission: leaving these off is what causes silent wrong
commits. They cost little enough that a tuner should bias toward ON and only trim under a hard
budget.

**Tier 3 — genuine trade-offs (need the accuracy model / RL signal):**
- `detail: sample` vs `shape` on the **frontier and near-frontier** — too aggressive here loses
  the eyeball that dirty data needs (this is exactly what made our `shape-only` sweep variant
  regress: 3 steps → 15 steps and a wrong commit).
- history depth on thrash (C.2): too little doesn't break the loop, too much re-inflates cost.
- interleaved DELTA vs LATEST (C.1): only worth it when order-of-operations reasoning matters.

The trade-off the tuner actually has to *learn* is small and localized: **how much detail the
frontier needs given the data's dirtiness.** Everything else is either a free cut or cheap
insurance.

---

## 6. Implications for the tuner

**Objective.** `reward = correct − λ · tokens`. Because 50/60 tasks are exact-match, `correct`
is binary and unforgiving — so the tuner must never trade away a Tier-2 insurance rung to save
tokens. Practically: optimize tokens *subject to* keeping Tier-2 on, i.e. search Tier-1 (free)
fully and Tier-3 (frontier detail) carefully.

**State features (per step, per operator).** The policy is per-operator, so featurize each op:
role (source/interior/frontier/terminal/blocked), steps-since-last-edit, edit-count (thrash),
has-healthy-consumer, is-erroring, and *data-shape flags read from its own annotations*
(dirty-load? low-cardinality-categorical? numbers-as-text? wide? long?). Plus trajectory-level:
step index, total context tokens so far, whether any op is thrashing. These are all computable
from the dossier the `summarize()` implementation already builds.

**Action space.** Per-operator param vector (detail, sampleRows, stats+metrics, schema,
value/structural hints, includeCode, codeHistory, result.history) + trajectory params
(events, reasoningReplayK, window). The *safe reduction* is that the per-op action collapses to a
small menu keyed on role×data-shape (§4 gives the menu); the tuner picks a menu entry, not 12
free knobs.

**"Whether to re-hone."** Re-running `summarize()` with a new param vector every step is itself
free (it's pure rendering), but the *policy* need only change when an operator's role changes
(a new op created, one errored, one crossed the thrash threshold, one gained a consumer). So the
controller's decision is event-driven: recompute the param vector on those transitions, reuse it
otherwise. This keeps the policy piecewise-constant and easy to learn.

**Where the learning signal is.** Tier-1 needs no learning (apply always). Tier-2 needs a
data-shape classifier, not RL (it's a lookup: dirty-load→raw, categorical→stats, numclean→hints).
The only real RL/search budget goes to Tier-3: the frontier-detail dial and thrash-history depth.
That is a *tiny* action space — which is the good news: the expensive part of the objective is
concentrated in one or two continuous dials, and the rest is a rule-based reduction the corpus
already tells us how to set.

**A subtlety the reward must encode: thrash is a cost failure the accuracy signal won't see.**
Because thrashy tasks still *pass* 22/26 of the time, a pure accuracy reward is blind to the
22× parse loops that burn most of the corpus's tokens. The `−λ·tokens` term is what makes the
tuner care — and the *action* that most reduces it is not trimming rows but **turning on
code-history early enough to prevent the loop** (C.2). So the highest-value thing the tuner can
learn is a *threshold*: at what edit-count (or on which error signatures — "parsed as 1 column",
`KeyError`) to flip code-history on for an operator. That single learned threshold plausibly
captures a large fraction of the achievable token savings, because thrash tasks are 3.7× cost
and 43% of the corpus.

**Cost-mode reminder for whoever runs the tuner.** The recorded corpus is DELTA-mode (68% of
its cost is the re-sent event log). The current default is LATEST, which already removed that —
so re-measure the baseline under LATEST before tuning, or the event-log savings will look like
the tuner's win when they were the mode default's. Under LATEST the tuner's real surface is
exactly A/B/D (per-operator table rendering) plus the C.2 thrash-history threshold.

**Curriculum.** Start the tuner on the free-lunch region (Tier-1 only) to bank the token savings
with zero accuracy risk; add Tier-2 as always-on; then let it search Tier-3 on the thrashy hard
tasks (the 26/60 that dominate cost), where the accuracy-cost frontier actually lives.

---

### Appendix — the sharpest single illustrations from the corpus

- **legal-easy-25 (fail, 15 edits, 1.6k→18k chars):** dirty-CSV loader re-edited 15× in DELTA,
  each re-load re-rendering the result, context climbing monotonically, never converging. →
  Archetype 2 policy (loader history on 2nd edit + loaderHints) is aimed exactly here.
- **environment-easy-2 (22 files):** the many-source blowup. → Archetype 5 (1 sample + 21 schema).
- **our `shape-only` sweep variant:** stripping raw rows globally turned a 3-step exact-correct
  run into a 15-step wrong commit — the proof that Tier-3 over-aggression on the frontier costs
  accuracy, and the reason detail must be *targeted*, not globally low.
- **archeology-easy-3 (`"12 or 14"` ranks) / legal-easy-10 (`'Fraud '` trailing space, thousands
  commas):** value-format + exact-schema tasks — schema line and valueFormatHints are the cheap
  signals that prevent the wrong parse.
```
```
