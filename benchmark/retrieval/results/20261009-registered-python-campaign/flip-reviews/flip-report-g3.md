# Flip report g3: Luna stats→both gains (flow knob off→on, statistics on in both arms)

Scope: 7 flips from `flips-g3.json`. Off arm = `stats` (evidence_data1_flow0), on arm = `both` (evidence_data1_flow1), run `20261009-luna-4arms`.
Call numbers count the model's dataflow tool calls in order (call 1 = first call).

Cross-run checks read the same task in the other Luna runs named in pass_pattern. `both@samplesPrompt` = run `20261009-luna-prompt-samples-2`; its results match the pass_pattern entries. I gathered the per-run answers with a temporary scratch helper script, since deleted.

Two mechanisms were recomputed from the input data (read-only, inline Python) and match the traces to six decimals:
- wildfire-hard-6: r with NIFC 2004 zeroed vs with `*` stripped.
- astronomy-hard-10: n and r for an exact-timestamp merge vs an hourly groupby.

---

### Luna archeology-easy-11 — stats→both GAIN — VARIANCE
Question: mean latitude of capital cities, keeping only the most populous capital where a country lists several; 4 dp. Gold: 17.4274. Off arm answered: 17.1667. On arm answered: 17.4274.

Gold plan: `worldcities.csv` (plain CSV) → filter `capital == "primary"` → per `country`, the row with max `population` (np.argmax) → mean `lat` → round to 4 dp.

Hinge: arm stats, call 3. `capitals = table[table['capital'].notna()]` keeps primary + admin + minor rows (7,263 + 3,625 + 250 = 11,138). It then keeps the most populous row per country (`sort_values(['country','population']) … drop_duplicates('country')`). So wherever an admin or minor city is larger than the national capital, it replaces it; the arm's own sample showed `Delhi … India … admin 32226000`. Result: 238 countries, mean 17.16669. The both arm (call 4) wrote `return row['capital'] == 'primary'`, then sorted by population desc, ran distinct on `iso3` and took the mean: 237 rows, 17.42742. The both arm hit no similar slip.

Evidence at hinge:
- stats (context for call 3, from call 2): `| capital | str | 33,553 | 3 | all: minor 7,263; admin 3,625; primary 250 |`. No flow lines (knob off).
- both (context for call 4): the same statistics line. Its only flow lines so far: `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=44691 rows.` The filter line `- flow: Filter kept=250/44691, rejected=44441, null predicates=0` appeared only after the predicate had been written.
- both@100k (flow on) after its own notna filter: `- flow: Filter kept=11138/44691, rejected=33553 …` and `- flow: predicate column "capital": … output (full=11138 rows) null=0/11138, distinct(nonnull)=3.` It still answered 17.0351.

Why: Both arms read the identical statistics table listing the three capital levels. Reading "capital cities" as any designation or as `primary` is a coin flip that happens in both knob settings:
- flow on: flow (notna, 17.7924) and both@100k (notna, 17.0351) fail.
- flow off: none (`eq('primary')`) passes.

In both@100k a flow line measured exactly the over-inclusive filter (3 distinct capital values kept), and the model ignored it. Flow content does not explain the gain.

### Luna astronomy-easy-1 — stats→both GAIN — VARIANCE
Question: MAE of SWPC's 3-day Ap forecast issued March 9, 2025, for March 10–12; integer. Gold: 15. Off arm answered: 16. On arm answered: 15.

Gold plan:
- Forecast: the 0309 file's line `Predicted Ap 10 Mar-12 Mar 025-020-012` → [25, 20, 12].
- Observed: `Observed Ap DD Mar NNN` from the 0311/0312/0313 files → [10, 10, 32].
- MAE = (15 + 10 + 20) / 3 = 15.

Hinge: arm stats, call 5, a repair of call 4's `KeyError: '0309'`. The call-4 draft had keyed forecasts by product (`forecast[product_id]`), which was the right design, but its regex `Predicted Ap (\d+ Mar)-(\d+ Mar)-(\d+) (\d+)-(\d+)-(\d+)` never matched. The call-5 rewrite dropped the product key and wrote every file's forecast into one date-keyed dict: `for i, value in enumerate(vals): forecast[f'{start+i} Mar'] = value`. The March 11 issue (`Predicted Ap 12 Mar-14 Mar 010-015-018`) then overwrote 12 Mar's 12 with 10. Errors 15/10/22 → 15.67 → 16. The both arm (call 3) restricted parsing to the 0309 product on its first attempt.

Evidence at hinge:
- stats: all 100 lines were in context, including `| 7 | Predicted Ap 10 Mar-12 Mar 025-020-012 |` and `| 7 | Predicted Ap 12 Mar-14 Mar 010-015-018 |`. Its own result row `| 12 Mar | 10 | 32 | 22 |` was accepted. No statistics tables were rendered (every retrieve used `full`).
- both: the same 100 lines. Flow lines: `- flow: Scan parsed selected sources; files selected=4/4, omitted=0; output=100 rows.` and, after the computation, `- flow: geomag_mae input rows=[100], output=1; row/column mapping unknown.` Code: `if product.endswith('0309geomag_forecast.txt'): … re.search(r'Predicted Ap 10 Mar-12 Mar (\d{3})-(\d{3})-(\d{3})', pred)`.

Why: The error is a repair-time coding slip inside a custom function. Nothing knob-specific sat at the hinge: the flow lines were file counts and custom-op boilerplate, and neither arm rendered statistics. pass_pattern agrees: none (flow off) passes, and both@samplesPrompt (flow on) fails with a different error (it used `Estimated Ap` instead of `Observed Ap`, giving MAE 9).

### Luna astronomy-hard-10 — stats→both GAIN — VARIANCE
Question: which OMNI2 / Sat_Density variable has the strongest Pearson r with Swarm-A's hourly altitude change over 2018-10-01..10; answer [name, r to 3 dp]. Gold: ["Proton_flux_>30_Mev", -0.193]. Off arm answered: ['Proton_flux_>30_Mev', -0.194]. On arm answered: ['Proton_flux_>30_Mev', -0.193].

Gold plan:
- Altitude: SP3 `PL47` positions → |r| − 6371 → hourly mean, dropna, diff, dropna.
- OMNI2: 10/01–10/10, hourly mean, dropna.
- Sat_Density: per file 10/01–10/10, concatenate, hourly mean, dropna.
- Inner join on the hour, dropna, Pearson r per column, take max |r|.

Hinge: arm stats, call 4. `merged=omni.merge(dens,on='Timestamp',how='inner')…`, where `dens` is the raw 10-minute concatenation of the October density files, with no hourly aggregation or dedup. Consecutive files share their boundary row: wu570 ends with `2018-10-04 00:00:00,1.546002283031983e-13` and wu571 starts with the same row; likewise at Oct 7 and Oct 10. So three hours enter the correlation twice: n = 218 (215 + 3), r = -0.19445. The both arm (call 3, kept through call 7) floored density timestamps to the hour and averaged by hour (`.dt.floor('h')`, then `groupby('time').mean()`), which collapses the duplicates: merged_rows 216, r = -0.19344. Recomputed from the data: exact merge n = 218, r = -0.194452; hourly groupby n = 215, r = -0.193443. The duplicates sit at exactly 2018-10-04, 10-07 and 10-10 00:00.

Evidence at hinge:
- stats: the call-3 execute receipt listed only `- **sp3_lines** (inspect_sp3, completed) … result: 35 rows × 2 columns`; the density and OMNI scans appeared only as schemas. Result: `| Proton_flux_>30_Mev | -0.194451857822036 | 218 |`.
- both: `- **density_raw** (scan, completed) … result: 4,330 rows × 2 columns` with `- flow: Scan parsed selected sources; files selected=10/10, omitted=0; output=4330 rows.` Call-3 reasoning: "Build a reproducible loader that parses all hourly inputs …". No flow line mentions duplicates or file overlap.
- both, calls 3–6, were crash repairs unrelated to density: resample on a non-datetime index, `P47` vs `PL47`, and KeyErrors. Result: `| Proton_flux_>30_Mev | -0.19344252820628 | 50 | 77760 | 216 | 240 | 240 | 216 | 216 |`.

Why: Whether the custom function hour-aggregates density is an independent coding choice. The both arm even calls the inputs "hourly", and none of its flow lines flags the overlap. The choice flips within flow-on runs:
- flow, both@basecaps and both@samplesPrompt made raw-timestamp merges and produced the identical r = -0.194451857822036 (n = 218 where shown).
- both@sample2k passed with a floor + groupby (n = 215).
- Overall the task fails in 6 of 8 Luna runs, so this both pass is the minority outcome.

The 0.001 gap is small, but it comes from a real row-duplication error rather than answer formatting, so it is not EVAL-ARTIFACT.

### Luna legal-easy-19 — stats→both GAIN — VARIANCE
Question: proportion of fraud reporters who lost $1–$500 in 2024; 3 dp. Gold: 0.523. Off arm answered: 0.199. On arm answered: 0.523.

Gold plan: from the report CSV, numerator = sum of the `$1 - $100` … `$401 - $500` rows in the "$1 - $1,000 Range" block (516,308); denominator = `Reports with $ Loss` (987,520); answer = numerator / denominator.

Hinge: arm stats, call 4. `denominator = rows.loc[rows[label].eq('Number of Fraud Reports'), count].iloc[0]` takes 2,600,678, all fraud reports including those with no loss, giving 0.1985. The numerator (516,308) was correct.

Evidence at hinge:
- stats: the full 36-row table, including `| Number of Fraud Reports | 2,600,678 | null |` and `| Reports with $ Loss | 987,520 | 38% of the total |`.
- both: the same full table and the same statistics. Flow lines before the choice: `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=36 rows.` and ``- flow: Scan: 2 header cells of `2024_CSN_Fraud_Reports_by_Amount_Lost.csv` are blank.`` Call-4 reasoning: "divide it by the 987,520 reports with loss". The filter flow lines (`Filter kept=1/36 …`) arrived only after the denominator was chosen.

Why: The denominator is an interpretation made from identical rendered rows. The only flow content before the decision was a scan count and a blank-header note. pass_pattern: stats is the only failing Luna run, and none (flow off) passes.

### Luna legal-hard-29 — stats→both GAIN — KNOB-HELPED
Question: among states with 5 or more metro areas, which metro area lying in a single state has the largest share of its state's fraud reports (the denominator includes cross-state areas)? Gold: Atlanta-Sandy Springs-Roswell, GA Metropolitan Statistical Area. Off arm answered: San Juan-Bayamón-Caguas, PR Metropolitan Statistical Area. On arm answered: Atlanta-Sandy Springs-Roswell, GA Metropolitan Statistical Area.

Gold plan:
- Sources: the per-state files in `State MSA Fraud and Other data`, excluding `PuertoRico.csv` (a territory) and the District of Columbia; `read_csv(skiprows=2).dropna()`.
- Keep states with at least 5 rows.
- Share = reports / state total, with cross-state and micropolitan rows included in the total.
- Single-state = no `-` in the state code. Take the top share per state, then the max across states.

Hinge: arm stats, call 3. `rank_single_state_msas` loops over all 52 files (`for path in sorted(glob.glob(pattern))`) and tests only `fullmatch(r'[A-Z]{2}')` on the state code; it never checks that a file is a state. Puerto Rico has exactly 5 MSAs, so it is eligible, and San Juan (79.95%) beats Atlanta (78.06%). Call 4 answered San Juan. A secondary divergence, counting and summing only "Metropolitan Statistical Area" rows, does not change the winner.

The both arm (call 4) built `state_codes={'Alabama':'AL', …, 'Wyoming':'WY','DistrictOfColumbia':'DC'}`, which has no Puerto Rico entry, and required `(x['codes']==x['expected_code'])`, so Puerto Rico's rows dropped out. `PuertoRico.csv` holds only those 5 MSAs (total 11,424), so San Juan's 79.95% would also have beaten Atlanta's 77.53% under the both arm's denominator. The map was the decisive step.

Evidence at hinge:
- stats: first row `| San Juan-Bayamón-Caguas, PR Metropolitan Statistical Area | PuertoRico | 9133 | 5 | 11424 | 79.9457282913165 |`, followed by the reasoning "The ranked result is complete and identifies the highest eligible single-state metropolitan area."
- both (before call 4): `- flow: Scan preview only (not full source); files selected=5/52, omitted=47; output=5 rows.`, `- flow: Scan parsed selected sources; files selected=52/52, omitted=0; output=764 rows.`, `- flow: load_msa_reports input rows=[], output=452; row/column mapping unknown.` No line names Puerto Rico, and the both arm's reasoning never mentions territories.
- Three other flow-on runs did see San Juan on top, next to only boilerplate flow lines (`- flow: compute_top_msa: row/column mapping unknown; equal row counts do not prove preservation.`; `- flow: Limit retained=1/299, removed=298.`), and then re-checked:
  - both@sample2k: "Exclude Puerto Rico because the question asks for states, …"
  - both@basecaps: "Exclude the Puerto Rico territory because the question asks for states, …"
  - both@100k: "…confirm whether the apparent winner is a territory rather than a U.S. state before finalizing the requested state-based result."
- Flow prompt paragraph (on arms only): "Compare these measurements with the requested population."

Why: The Puerto Rico decision splits exactly along the flow knob across the 8 Luna runs:
- Flow off: 0 of 2 exclude it. none and stats both saw San Juan on top and answered it.
- Flow on: 6 of 6 exclude it. flow, both and samplesPrompt did so with a state-abbreviation map built before seeing results; 100k, sample2k and basecaps did so with an explicit re-check after seeing San Juan.
- If the two failures were placed at random among the 8 runs, the chance they land exactly on the two flow-off runs is 1/28.

No measured flow line in any run named Puerto Rico. In the flow and samplesPrompt runs, too, only scan counts and custom-op boilerplate preceded the state map. The knob content that can carry this is the flow prompt paragraph's population instruction, possibly helped by the generic custom-Python caveats, and the re-check wording ("the requested state-based result") echoes it. This is the weakest form of KNOB-HELPED: the carrier is inferred from behavior across 8 runs, not quoted at this arm's decision.

### Luna wildfire-hard-6 — stats→both GAIN — VARIANCE
Question: Pearson r between the annual (NOAA − NIFC) fire-count difference and the annual (NOAA − NIFC) acres difference; 3 dp. Gold: 0.519. Off arm answered: 0.148. On arm answered: 0.519.

Gold plan:
- NOAA: monthly CSV (skiprows=3) → year = Date[:4] → annual sums of fires and acres.
- NIFC: tab-separated → strip `,` and `*` → int.
- Inner join on Year (2000–2024, 25 years), take the differences, compute Pearson r.

Hinge: arm stats, call 5. `b['nifc_acres'] = pd.to_numeric(b['Acres'].astype(str).str.replace(',', '', regex=False), errors='coerce')`, followed by a groupby sum. NIFC's 2004 value is `*8,097,880`, so it became NaN, the sum made it 0, and 2004's acre difference became NOAA's full 2004 acreage. Recomputed: with 2004 zeroed r = 0.148402; with `*` stripped r = 0.518594. Both match the arms exactly.

Evidence at hinge:
- stats: it never retrieved NIFC values; call 2 showed only the schema `| 2 | "Acres" | str |`. Its result `| 25 | 0.148402373225172 |` was accepted.
- both (call 1, `sample_stats` on `nifc_raw`): `| Acres | str | 0 | 42 | top: *8,097,880 1; 1,148,409 1; 1,323,666 1; 1,329,704 1; other: 38 (not exhaustive) |`, plus the flow line `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=42 rows.` Call-3 code: `.str.replace('*', '', regex=False).str.replace(',', '', regex=False), errors='raise')`.

Why: The on arm was fixed by statistics content, which comes from the knob both arms had; the stats arm never requested it, and `errors='coerce'` hid the bad cell. The flow lines were scan counts. pass_pattern: stats is the only failing Luna run. none and flow (no statistics) never saw the asterisk either, but they used `errors='raise'`, hit the parse error, and stripped non-digits.

### Luna wildfire-hard-7 — stats→both GAIN — VARIANCE
Question: which geographic area had the most anomalous year by Z-score in total (human + lightning) acres burned, and which year? Gold: Northwest, 2020. Off arm answered: Northwest, 2001. On arm answered: Northwest, 2020.

Gold plan: two tab-separated NIFC tables; strip `*` from headers; for each area column (excluding Year and Total), `N/A` → NaN, remove commas, convert to numeric; total = human + lightning; z = (x − mean) / std per area; the max |z| gives area and year.

Hinge: arm stats, call 3. `long['acres'] = pd.to_numeric(long['acres'], errors='coerce')` without removing thousands separators, so every value of 1,000 or more (written like `719,771`) became NaN and summed to 0. Only cells under 1,000 survived, such as lightning Northwest 2001 = "394". It also melted `Total` as an area. Call 4 returned `| Northwest | 2001 | 394 | 15.76 | 78.8 | 4.8 | 4.8 |`, and call 5 answered it without questioning a regional mean of 15.76 acres.

Evidence at hinge:
- stats: before writing the parser it saw only header lines (`"Year\tAlaska\tNorthwest\t…\tTotal"`), never a data value.
- both (call 2, `sample_stats`): records `- Year: 2024, Alaska: 3,512, Northwest: 719,771, …` and statistics `| Northwest | str | 0 | 24 | top: 105,544 1; 112,098 1; 115,842 1; 126,381 1; …`. Its only flow lines: `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=24 rows.` Call-3 code applies `.str.replace(',', '', regex=False)` before `to_numeric`, giving `| Northwest | 2020 | 5134120 | … | 4.04464417240335 |`.

Why: Same pattern as wildfire-hard-6. The stats arm wrote a coercing parser without looking at any values; the both arm looked first (records plus statistics) and saw the commas. The flow content was a row count. pass_pattern: stats is the only failing Luna run; none and flow pass.

---

## Summary

| task | direction | class | one-line reason |
|---|---|---|---|
| archeology-easy-11 | GAIN | VARIANCE | Off arm kept every capital level (`capital.notna()`), on arm kept `== 'primary'`, after the same statistics line. Flow-on runs (flow, both@100k) also chose notna; both@100k ignored a flow line showing the filter kept 3 capital levels. |
| astronomy-easy-1 | GAIN | VARIANCE | Off arm's crash repair merged all issues' forecasts by date, so the Mar 11 issue overwrote 12 Mar (10 instead of 12). Flow lines were file counts; both@samplesPrompt (flow on) fails differently. |
| astronomy-hard-10 | GAIN | VARIANCE | Raw-timestamp merge double-counted 3 overlapping density rows (n 218, r -0.1945) vs an hourly groupby (n 215, r -0.1934). Three other flow-on runs made the same merge and got -0.194. |
| legal-easy-19 | GAIN | VARIANCE | Denominator "Number of Fraud Reports" vs "Reports with $ Loss", chosen from the same full table. Filter flow lines came after the choice; none (flow off) passes. |
| legal-hard-29 | GAIN | KNOB-HELPED | Off arm kept Puerto Rico (San Juan 79.95%); on arm's 50-state + DC map dropped it. No flow line names Puerto Rico, but the decision splits 0/2 vs 6/6 by flow, and 3 flow-on runs re-checked "the question asks for states". Likely carrier: the prompt's "requested population" sentence (inferred). |
| wildfire-hard-6 | GAIN | VARIANCE | Off arm never looked at NIFC values; `errors='coerce'` turned `*8,097,880` into 0 (r 0.148). On arm saw it in a statistics table both arms could request. |
| wildfire-hard-7 | GAIN | VARIANCE | Off arm never looked at values; `errors='coerce'` without comma stripping zeroed all acres ≥ 1,000 (Northwest 2001, mean 15.76). On arm saw "719,771" in sample_stats; its flow lines were a row count. |

**What the flow knob's content did.** Across these seven gains, the measured flow lines decided nothing.
- At every hinge, the on arm's flow content was scan file and row counts ("files selected=…, output=… rows") or custom-Python boilerplate ("row/column mapping unknown").
- The informative flow lines (filter kept/rejected, join unmatched keys) appeared only after the decisive predicate, key or denominator was already coded.
- In the one case where a flow line measured the faulty step itself (archeology both@100k: "Filter kept=11138/44691 … distinct(nonnull)=3"), the model kept the wrong filter.

Six of the seven are VARIANCE, where the stats arm made a one-off choice or slip that other runs make or avoid regardless of flow:
- notna vs primary (archeology-easy-11);
- a repair that let a later forecast overwrite (astronomy-easy-1);
- a raw-timestamp merge that duplicated overlapping density rows (astronomy-hard-10);
- an all-reports denominator (legal-easy-19);
- `errors='coerce'` on values it never looked at (wildfire-hard-6 and wildfire-hard-7). In both wildfire tasks the on arm was rescued by statistics or record content, which the stats arm could equally have retrieved.

The only knob-aligned effect is legal-hard-29. There the Puerto Rico decision splits cleanly by flow (0/2 vs 6/6), yet no flow line ever names Puerto Rico. That points to the flow system-prompt paragraph ("Compare these measurements with the requested population") prompting a population-membership check, not to flow measurements. Net: in this group the flow knob helped at most once, through prompt framing rather than measured evidence; the other six gains are variance in the stats arm.
