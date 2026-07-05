# Context-parameter case studies (per task)

> ⚠️ **Status note (see `STATUS-context-optimization.md` §5).** These cases were
> written against the *recorded* traces in `llm-training-set-v1-kramabench/`, which
> were captured under an **older renderer**. Two claims here are now known stale:
> Case 3's "3,127-char schema line" (that run had *no* schema line; the wide table
> was capped-differently) and Cases 4–5's small-table ellipsis (those tables render
> **in full** under current defaults — `smallTableFullThreshold` was dropped). The
> accuracy cases (1–2, stats on decision-critical columns) and the Phase-1 schema
> cap still stand. Re-ground any cost number here against the current renderer.

Each case is a real KramaBench trace, grounded in the gold `.py` solution and the
actual source data. The point is to show, task by task, how a specific **context
selection parameter** would have changed the outcome — for accuracy or for token
cost — and, honestly, where no context parameter can help (the failure is an
*action*, not a rendering).

Lever legend: **[CTX]** a context/render parameter fixes it · **[ACT]** only an
agent action fixes it.

---

# Case 1 — wildfire-hard-17  ·  [CTX] accuracy

## Task
"What is the average elevation (in feet) of the weather stations used for fire-site
monitoring in the NOAA data?" Gold **4830.9**; agent **3317.4** (wrong).

## Data Source Overview
`noaa_wildfires.csv` (fire records; key column `station_verified_in_psa`, values ~20K–482K)
and `PublicView_RAWS_*.csv` (2965 stations, 34 columns). The RAWS file has THREE
id-like columns, and only one is the real join key:

| column | non-null | min | max |
|---|---|---|---|
| `WX ID` | 2961 | 16,777,533 | 19,907,847 |
| `Station ID` | 2916 | 16,777,528 | 19,891,205 |
| **`NWS ID`** | 2127 | **1,196** | **661,001** ← overlaps the fire key |

## How the agent falls short (pipeline construction)
37 steps. Pipeline: `loadWildfiresData → loadRAWSData → examineRAWSStructure ×3 →
extractUniqueStations → joinStationsWithElevation → inspectRAWSStationIds →
findMatchingStations (×several) → calculateAverageElevation → verifyAverageElevation`.
The agent tried to join on `WX ID`, then `Station ID`, then last-5-digit string
tricks; its `findMatchingStations` op even *printed the ID ranges* to "confirm no
match." Concluding no key matched, it fell back to the mean elevation of **all 2965
stations** → 3317.4. It never tried `NWS ID`, whose range overlaps the fire key.
The context rendered `NWS ID` only as one cell (NaN) of a truncated 34-column
sample — the header was present but the deciding fact (its *range*) was not.

## How context parameters help
`column.stats = true` on **join-key-candidate columns** (numeric, id-like, feeding a
`merge`/`isin`) at the deciding step:
```
NWS ID  (numeric): non-null=2127, min=1196,      max=661001
WX ID   (numeric): non-null=2961, min=16,777,533, max=19,907,847
```
Seeing `NWS ID`'s range next to the fire key's 20K–482K makes the overlap obvious →
the agent joins on `NWS ID` → 4830.9. **This is the single fail→pass context lever
in the 60-task corpus.** Cost: two stat lines, not the wide table.

---

# Case 2 — environment-hard-15  ·  [CTX] accuracy (latent)

## Task
"Which fresh-water beach is the most polluted since 2020 (highest average exceedance
rate)?" Gold and agent both **Damon Pond Beach (DCR)** — but the agent was **correct
only by luck**.

## Data Source Overview
`water-body-testing-2020..2023.csv`. The `Violation` column's casing is inconsistent
*across years*:
```
2020: {No:14009, Yes:787}
2021: {NO:14835, YES:1167, No:15, Yes:3}   ← 2021 is UPPERCASE
2022: {No:15276, Yes:810}
2023: {No:15145, Yes:1113}
```

## How the agent falls short (pipeline construction)
Clean 5-op pipeline (no thrash): `loadAllYears → exploreFreshWater →
calculateExceedanceRate → filterCompleteYears → averageExceedanceRate`. But the rate
op computed `(x == 'Yes').sum()/len(x)` — matching only 3 of ~1170 actual 2021
violations, silently zeroing 1167 rows. Gold defends with `.str.lower() == 'yes'`.
The 2-row loader sample the agent saw happened to show `Yes`/`No`, hiding that 2021
uses `YES`/`NO`.

## How context parameters help
`column.stats = true` on the **low-cardinality categorical used in the filter**:
```
Violation (str): distinct=4, top={NO:44K, No:44K, YES:3K, Yes:2K}
```
The mixed casing is now visible → the agent writes `.str.lower()`. Same lever as
Case 1 (stats on the decision-critical column); here it converts a lucky pass into a
robust one — the class of silent error that only surfaces when the data shifts.

---

# Case 3 — biomedical-hard-4  ·  [CTX] token cost

## Task
"What are the histological grades of tumors for which peptide HPKPEVLGSSADGALLVSLDGLR
was found?" Gold `['FIGO Grade 2']`, agent `['FIGO grade 2']` (case-diff, eval-OK).

## Data Source Overview
`mmc1.xlsx` clinical table = **153 rows × 179 columns**; `mmc4.xlsx` (multi-sheet).
The gold solution touches **4 columns** (`Peptide`, `Samples_With_Peptide`, `idx`,
`Histologic_Grade_FIGO`).

## How the agent falls short (pipeline construction)
23 steps. The 179-column clinical table is loaded and then, under `latest`,
**re-rendered on 18 of 22 steps — its header line alone is 3,127 chars (~56K chars
of pure header re-render)** — even though only 4 columns are ever used. (The trace is
also action-heavy: `loadMmc4Variants`/`loadMmc4NovelSplice`/`loadMmc4AltSplice`
re-created repeatedly — see Case 6 for that pathology.)

## How context parameters help
Two params, together the dominant cost pattern (36 corpus labels):
- `result.latest.detail = "shape"` once the table is consumed → drop the rows.
- **cap the schema line at ~50 columns** (Phase 1) → even `shape` on a 179-col table
  shrinks from 3,127 chars to a bounded `Schema (showing 50 of 179 cols): …`.
Zero accuracy cost (the 4 needed columns are addressed by code, not by eyeballing
the wall of 179).

---

# Case 4 — legal-easy-25  ·  [CTX] token cost (under-render → thrash)

## Task
"Which branch of the U.S. Military had the largest Median Fraud Loss in 2024?" Gold
and agent both **U.S. Space Force** — but at **483K tokens / 22 steps**.

## Data Source Overview
One ragged multi-block CSV (`…Military Consumers.csv`, 25 rows) where the branch
sub-block (rows ~7–14, containing "U.S. Space Force") sits in the middle.

## How the agent falls short (pipeline construction)
The pipeline is `loadMilitaryFraudData` **× 17** (!) then `cleanMilitaryData → …`.
The loader rendered as a head/tail sample **with `…` hiding the middle**, so the
answer-bearing branch block was never in the context — the agent reloaded ~16 times
trying to reach it. (Confirmed: the render contains `…` and does NOT contain "Space
Force".)

## How context parameters help
`smallTableFullThreshold` (Phase 1): a **short** table (≤ ~40 rows) renders in
**full** — never ellipsis-hide the middle of a small table. The branch block is
visible on step 1, the 16 reloads vanish. Here the fix is *more* detail once — the
inverse of Case 3, and why the policy can't be "always trim." (Contrast: a 15k-row
table still gets head/tail-capped.)

---

# Case 5 — legal-easy-19  ·  [CTX]+[ACT] token cost (duplicate loaders)

## Task
"Proportion (3 dp) of fraud reporters who lost between $1–$500 in 2024?" Gold and
agent both **0.523** — but at **243K tokens / 34 steps**.

## Data Source Overview
One `Fraud_Reports_by_Amount_Lost.csv` (36 rows) whose head/tail render ellipsis-hid
the `$1–$100 … $401–$500` sub-block the solution sums.

## How the agent falls short (pipeline construction)
The agent created **12 differently-named loader/parser ops for the ONE file** —
`loadFraudData, readRawCsv, readFullCsv, readRawFile, readCompleteFile,
parseCompleteData, parseAmountRanges, extractRanges, readAndParseFraudData, …`.
Because differently-named ops don't collapse under `latest`, all 12 render every
step. Root cause is two-fold: (a) [CTX] the ellipsis hid the rows (as Case 4), and
(b) [ACT] the agent retried by **creating a new operator** each time instead of
modifying one.

## How context parameters help — and where they can't
- [CTX] `smallTableFullThreshold` shows the 36-row block in full (kills the reason to
  retry) → and a "collapse near-duplicate loaders (same file) → render only the
  latest, `omit` the siblings" rule caps the render blow-up.
- [ACT] The clean fix is the agent **modifying** the existing loader instead of
  spawning `readRawCsv2` — a behavior nudge / the convergence guard, not a render
  param. This is why the token cost is partly an *action* problem (Phase 3).

---

# Case 6 — environment-hard-9  ·  [ACT] the honest floor (context CANNOT help)

## Task
"Which Boston Harbor beaches met swimming standards 100% of the time 2020–2024?"
Gold `[Pleasure Bay Beach, Castle Island Beach, City Point Beach]`; agent returned
only 2 — **missing Castle Island** (wrong).

## Data Source Overview
9 files, one per beach, incl. `pleasure_bay_and_castle_island_beach_datasheet.csv` — a
**combined** file whose columns cover two named beaches (Pleasure Bay + Castle Island).

## How the agent falls short (pipeline construction)
**74 create-ops across 18 steps, 0 deletes** — 8 per-beach loaders + a `processX`
per beach + repeated re-creations, none cleaned up. Crucially, `processPleasureBay`'s
own summary says it handled "multiple Enterococcus sampling locations (Broadway,
Flagpole, Castle Island…)" — then it **aggregated the combined file into one row
labeled 'Pleasure Bay Beach'** instead of splitting Castle Island out as its own
beach.

## How context parameters help
**They don't — and this is the important negative.** The Castle Island column, its
value, and its name were all visible (the agent even named it). The error is a
transform/aggregation *decision*; no `detail`/`stats`/`sample` setting produces the
missing beach. This is the corpus's dominant failure class (4 of 5 failures) — a
reminder that context tuning is a **cost lever with a thin accuracy edge**, not an
accuracy cure. The 74-op / 0-delete explosion IS a cost problem, but its fix is the
[ACT] delete/modify discipline (Case 5, Phase 3), not a render param.

---

## What these cases jointly show about context params
- **Accuracy** (Cases 1–2): the one real lever is **stats on decision-critical
  columns** (join keys, filter categoricals) — cheap, targeted, and it both fixes a
  wrong answer and hardens the silent-luck passes.
- **Token cost** (Cases 3–5): **consumed→shape + cap the schema line** is the big
  safe trim; but **short tables must render full** (never ellipsis-hide the answer) —
  the policy is directional, not "always less."
- **The floor** (Case 6): most failures and much of the cost are **actions** (wrong
  transforms; never deleting; duplicating loaders) that context params can only
  mask, not fix.
