# Representative cases — inaccuracy & token cost, and the golden fix

> ⚠️ **Status note (see `STATUS-context-optimization.md` §5).** The token-cost cases
> (C1–C4) were measured on *recorded* traces captured under an **older renderer**;
> some are already mitigated by current defaults (50-col display cap; small tables
> render full). Treat the cost numbers as historical and re-measure on the current
> renderer. The accuracy cases (A1–A2) and the ACTION pathologies (Part 3) still hold.

Every case is grounded in the real trace + gold solution + source data (see
`docs/trace-analysis-findings.md` for the corpus-wide aggregate). Each is tagged
by **lever**: **CONTEXT** (what the renderer/selector shows) vs **ACTION** (what
the agent does). This split matters — a context fix cannot repair a bad action,
and vice-versa.

---

## Part 1 — Accuracy cases

### A1. `wildfire-hard-17` — wrong join key (answer 3317.4 vs gold 4830.9) · lever: CONTEXT
**What happened.** The RAWS station file has three ID columns:
`WX ID` (16.7M–19.9M), `Station ID` (16.7M–19.8M), `NWS ID` (**1,196–661,001**).
The fire key `station_verified_in_psa` ranges ~20K–482K — overlapping **NWS ID only**.
The agent tried `WX ID`, `Station ID`, and last-5-digit tricks, printed the ID
*ranges* to "confirm no match," then fell back to the mean elevation of **all 2965
stations** → 3317.4. Gold: `stations['NWS ID'].isin(fires['station_verified_in_psa'])` → 4830.9.
The context rendered `NWS ID` only as one cell (NaN) of a truncated `(2965, 34)`
sample; nothing showed its *range*.
**Golden fix (CONTEXT).** On a column that is a **join-key candidate** (numeric,
id-like, feeding a `merge`/`isin`), render per-column stats — `NWS ID: non-null=2127,
min=1196, max=661001` beside `WX ID: min=16.7M`. The overlap becomes obvious. This
is the single fail→pass lever in the 60-task corpus.

### A2. `environment-hard-15` — mixed-case filter (correct only by luck) · lever: CONTEXT
**What happened.** Gold: `df['Violation'].str.lower() == 'yes'`. Agent hardcoded
`(x == 'Yes')`. The 2021 file is `{'NO': 14835, 'YES': 1167, 'No': 15, 'Yes': 3}` —
the agent counted **3 of ~1170** violations, silently zeroing 1167 rows. It got the
right beach only because Damon Pond ranked top regardless.
**Golden fix (CONTEXT).** On a **low-cardinality categorical used in a filter**,
render `Column stats: Violation → {NO:14835, YES:1167, No:15, Yes:3}`. The mixed
casing is then visible and the agent writes `.str.lower()`. (Same lever as A1:
stats on the *decision-critical* column.)

### A3. `environment-hard-9` — dropped a sub-population · lever: ACTION (not context)
**What happened.** Gold = 3 beaches incl. `Castle Island Beach`; agent returned 2,
folding Castle Island into `Pleasure Bay Beach`. The agent's OWN operator summary
says "handle multiple Enterococcus sampling locations (Broadway, Flagpole, Castle
Island…)" — it *named* the location, the column was fully visible.
**Golden fix (ACTION).** A transform decision: split the combined file's
per-location columns into their named beaches instead of aggregating to one. No
render change produces the missing item — this is a modeling action, not a context
gap. (Honest floor: most failures are here.)

### A4. `astronomy-hard-10` — fabricated time axis · lever: ACTION (not context)
**What happened.** Right variable, wrong correlation (+0.147 vs −0.193). The
altitude-change operator **invented** an evenly-spaced hourly axis from filenames
instead of parsing the real SP3 `*` epoch lines + `resample('1h').diff()`, so the
merge mis-aligned and flipped the sign.
**Golden fix (ACTION).** Parse the real timestamps. A computed artifact; no
render change yields −0.193.

---

## Part 2 — Token-cost cases

### C1. `biomedical-hard-4` — wide table re-rendered (dominant pattern) · lever: CONTEXT
**What happened.** The clinical table `(153, 179)`: its **header line alone is 3,127
chars, re-rendered on 18 of 22 steps ≈ 56K chars** of pure header, while the gold
solution uses **4 columns**. This `full-table → shape` waste is the corpus's #1
pattern (36 labels).
**Golden fix (CONTEXT).** Once a source is consumed by a healthy downstream →
render `shape` (schema line), not the table. AND cap the schema line itself at ~50
columns for very wide tables (an uncapped 179-col schema line is still heavy — the
residual biomedical cost the current clamp misses).

### C2. `legal-easy-25` — ellipsis hid the answer (under-render → thrash) · lever: CONTEXT
**What happened.** The military-fraud loader rendered as a 25-row sample **with `…`
hiding the middle**; the branch sub-block containing "U.S. Space Force" was not in
the render, so the agent reloaded ~16 times (22 steps, 483K tokens) trying to reach
it.
**Golden fix (CONTEXT).** For a **short** table (≤ ~40 rows) render it in **full** —
never ellipsis-hide the middle of a small table. Here *more* detail once is the cost
fix. (Contrast: a 15k-row table should stay head/tail-capped.)

### C3. `legal-hard-30` — frozen upstream re-rendered every retry · lever: CONTEXT
**What happened.** An 8-step `verifyResult` retry loop (steps 10–17) re-rendered the
entire **frozen 7-operator upstream DAG** (~3800 chars) each iteration → 602K tokens
on a boolean answer.
**Golden fix (CONTEXT).** During a run of no-op/verify steps that don't change an
operator, collapse **unchanged upstream** ops to `shape` — only the operator under
active work stays detailed.

### C4. `astronomy-easy-5` — swallowed errors rendered as `(0,0)` · lever: CONTEXT (+ ACTION)
**What happened.** ~12 attempts silently returned `Output table shape: (0, 0)` (an
in-loop `try/except` swallowed the skyfield exception) with **no error text**; the
agent rebuilt the API blind ~10× (49 steps, 445K tokens).
**Golden fix.** CONTEXT: surface the captured exception, not an empty `(0,0)` shape.
ACTION: don't swallow exceptions in operator code.

---

## Part 3 — ACTION pathologies (the token cost's root cause)

Context tuning only *trims the render* of these ops; the real fix removes them.

### AC1. Agent almost never deletes — 6% delete rate · lever: ACTION
**Evidence.** Across 60 traces: **894 create/modify calls, 58 deletes (6%); 53/60
tasks delete nothing.** `astronomy-easy-1` created 28 ops, deleted 0; `environment-
hard-9` kept 8 raw loaders + a redundant explorer + a full traceback re-rendered
across 7 steps. The system prompt tells the agent to delete inspection ops once the
real loader exists — it doesn't.
**Golden fix (ACTION / SYSTEM).** Since the agent won't, the system should:
auto-collapse or GC operators with **no downstream consumer, not the terminal
answer, not touched in K steps** (inspection/dead ops). Renderer-side: `omit` them
(cheap, safe — the selector already has the role). DAG-side (cleaner): actually
delete them so they stop executing too.

### AC2. Duplicate-instead-of-modify · lever: ACTION
**Evidence.** `legal-easy-19` created **12 differently-named loader ops for ONE file**
(`readRawFile`, `readRawCsv`, `readFullCsv`, `readCompleteFile`, `parseCompleteData`,
`extractRanges`, …); `astronomy-easy-1` made **18 loader ops for 4 files**. Retrying
by creating a NEW operator id (instead of modifying the existing one) fills the DAG
with near-duplicates that ALL render under `latest`.
**Golden fix (ACTION / SYSTEM).** (a) Nudge modify-over-create when a new op's code
targets a file/columns an existing op already loads. (b) Renderer fallback: detect
near-duplicate loaders (same file/code) and render only the latest, `omit` the
siblings. (c) The convergence guard (`maxOperatorEdits`) already discourages same-op
thrash; extend the spirit to cross-op duplication.

---

## The lever map (what fixes what)

| symptom | representative | lever | golden fix |
|---|---|---|---|
| wrong join key | wildfire-hard-17 | CONTEXT | stats on join-key candidate columns |
| mixed-case filter | environment-hard-15 | CONTEXT | value_counts on filter categoricals |
| wide re-render | biomedical-hard-4 | CONTEXT | consumed→shape + cap schema-line width |
| ellipsis hid answer | legal-easy-25 | CONTEXT | render short tables full |
| retry re-renders DAG | legal-hard-30 | CONTEXT | freeze unchanged upstream in no-op runs |
| swallowed error `(0,0)` | astronomy-easy-5 | CONTEXT+ACTION | surface exception; don't swallow |
| never deletes dead ops | 53/60 tasks | ACTION | GC/omit unconsumed non-terminal ops |
| duplicate loaders | legal-easy-19 | ACTION | modify-not-create; collapse duplicate loaders |
| dropped sub-population | environment-hard-9 | ACTION | correct transform (no context lever) |
| fabricated axis | astronomy-hard-10 | ACTION | correct transform (no context lever) |
