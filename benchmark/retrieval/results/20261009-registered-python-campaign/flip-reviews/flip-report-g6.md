# Flip report g6: Terra none→stats (statistics off vs on, flow off in both)

This group has 13 flips: 9 losses and 4 gains, for a net of −5 tasks for the stats-only arm. Each flip was checked against the gold solution and both full traces (`dump_trace.py`, max 20000 chars). Where the two arms differed, I also read the flow arm (data0_flow1) and the both arm (data1_flow1) for the same task. Call numbers count model calls from 1.

The stats-only system prompt differs from none in three places, confirmed from the wire logs:
- `sample_stats` replaces `sample` in the view table.
- One new paragraph, which ends "Compute exact answer quantities in the graph, not from rounded summaries."
- The "Use optional statistics" example, which ends "Rounded profile summaries are not exact final answers."

The stats-only arm gets no flow paragraph.

Three numeric claims below come from replays on the real data:
- astronomy-hard-10: the stats arm's own correlation function, run with and without its density filter.
- environment-easy-3: the beach-rate count, run under both keys.
- legal-hard-2: the two arms' name-key functions, run on the Miami names.

---

### Terra astronomy-hard-10 — none→stats LOSS — KNOB-MISLED
**Question:** For 2018-10-01..10, which OMNI2 or Sat_Density variable has the strongest Pearson r with Swarm-A hourly altitude change? **Gold:** ['Proton_flux_>30_Mev', -0.193]. **Off arm answered:** ['Proton_flux_>30_Mev', -0.193]. **On arm answered:** ['Proton_flux_>30_Mev', -0.191] (f1 0.5).

**Gold plan:**
- Parse PL47 positions from all SP3 files and compute alt = |r| − 6371.0. Take hourly means, dropna, then diff.
- OMNI2: Oct 1–10, hourly mean.
- Sat_Density: Oct 1–10, hourly mean (`resample('1h').mean().dropna()`) with **no fill-value filter**, so the 9.99e+32 fill values stay in their hourly means.
- Inner-join the three sources on hour and dropna. Compute Pearson r per column, take the largest |r|, and round to 3 places.

**Hinge:** stats arm, call 5 (`rank_hourly_correlations`), `d = d[np.isfinite(d[dval]) & (d[dval] < 1e-10)]`.
- This drops every Sat_Density row that holds the 9.99e+32 fill value before the inner merge.
- Six hours are fill-only (10-02 23h, 10-03 00h, 10-05 23h, 10-06 00h, 10-10 00h, 10-10 01h), so they disappear for all 50 variables. Paired hours fall from 215 to 209, and r moves from −0.19344 to −0.19124.
- Replaying the arm's own function without that one predicate gives −0.193443 on 215 hours, which is exactly the none arm's value.

**Evidence at hinge:**
- Stats arm, call 3 (`sample_stats` of density_raw):
  - `statistics: full table, 4,330 of 4,330 rows, 2 of 2 columns`
  - `| Orbit Mean Density (kg/m^3) | float64 | 0 | 4,196 | 9.34323999901021e-14 to 9.99e+32 |`
- Stats arm, call 5 doc: `'Pearson correlations of every OMNI2 and hourly mean valid Sat_Density variable ...'`. Result: `| Proton_flux_>30_Mev | -0.191243748694876 | 209 | 0.191243748694876 |`
- None arm, call 3 (`sample` of density): first and last records only, `| 2018-10-01 00:00:00 | 1.44313111234219e-13 |` … `| 2018-10-31 00:00:00 | 1.23828464398482e-13 |`. It never saw a range. Its call-4 code resamples density with no value filter, giving `| Proton_flux_>30_Mev | -0.19344252820628 | 0.19344252820628 | 215 |`.

**Why:** The 9.99e+32 fill value appears in exactly one place across both contexts: the stats arm's statistics range. The arm then filters exactly that value ("valid" density). As data hygiene the filter is defensible. But the gold keeps the fill-contaminated hours, and dropping whole rows rather than just the density cell moved r across the rounding boundary.

The passing none arm never saw this content. The both arm saw the identical range line and also cleaned it, but at cell level: `d.loc[d[...] >= 1e20, ...] = np.nan`, then per-column dropna. That kept 215 hours for the other variables, and it passed. So the harm comes from a decision the statistics prompted, combined with a row-level implementation.

---

### Terra biomedical-hard-7 — none→stats LOSS — VARIANCE
**Question:** How many significant genes by acetylproteomics? **Gold:** 16. **Off arm answered:** 16. **On arm answered:** 15.

**Gold plan:** The README maps "acetylproteomics" to sheet D-SE-acetyl. That sheet is a headerless gene list, and pandas consumes the first gene as the header, so the count is len(df)+1 = 16.

**Hinge:** stats arm, call 2: `scan(files=..., format='excel', sheet='D-SE-acetyl')` with the default header. The first gene, BRD8, became the column name, leaving 15 rows. Call 3, `aggregate(acetyl, outputs={'significant_gene_count': count()})`, returned 15.

**Evidence at hinge:**
- Both arms, call 1 (identical inspect source): `| "D-SE-acetyl" | "BRD8" | retained |`. The first raw row is a gene, not a header.
- None arm, call 2: `scan(..., sheet='D-SE-acetyl', header=False, names=['gene'])` → `result: 16 rows × 1 column`.
- Stats arm, call 2 observation (after the decision): schema `| 0 | "BRD8" | str |`, and statistics `| BRD8 | str | 0 | 15 | top: CDK1 1; CEBPZ 1; DHX15 1; FBXO22 1; other: 11 (not exhaustive) |`.

**Why:** The header choice was made in call 2 from the same raw-row hint both arms had, before any statistics existed. The statistics that followed showed a column named after a gene, and the arm did not correct it. Across the other arms the choice tracks nothing knob-related: the flow arm (no statistics) made the same default-header scan and answered 15, and the both arm (statistics on) used `header=False` and answered 16.

---

### Terra environment-easy-3 — none→stats LOSS — VARIANCE
**Question:** How many beaches had a higher 2013 than 2012 exceedance rate, excluding beaches with no 2012 samples? **Gold:** 268. **Off arm answered:** 268. **On arm answered:** 267.

**Gold plan:**
- beach_id = Community Code + County Code + lower(Beach Name).
- Per year: count samples, count Violation=='yes', compute the rate.
- Inner-join 2012 and 2013, then count beaches where rate2013 > rate2012.

**Hinge:** stats arm, call 2: `groupby('Beach Name')` and `merge(..., on='Beach Name')`. Keying on name alone pools same-named beaches from different towns.
- Result: 267 of 1,124 beaches compared.
- Replay on the data: Beach Name alone gives 267 of 1,124; Community Code + Beach Name gives 268 of 1,138.

**Evidence at hinge:**
- Stats arm, call 1 statistics (2012): `| Community Code | int64 | 0 | 221 | 1 to 351; top: 35 891; ...` and `| Beach Name | str | 0 | 1,155 |  |`. Call 2 doc: `'Counts Beach Name groups sampled in both years whose violation rate is higher in 2013.'`
- None arm, call 1: schema plus a 3-row sample. Call 2: `keys = ['Community Code', 'Beach Name']` → `| 268 | 1138 |`.

**Why:** This is a key-choice method decision, and the reasoning never refers to the statistics. Distinct counts do not say whether names repeat across communities. The both arm saw the identical statistics table and still keyed on `['Community Code', 'Beach Name']` (268). The flow arm did the same.

---

### Terra environment-hard-9 — none→stats LOSS — VARIANCE
**Question:** Which Boston Harbor beaches met the Enterococcus standard (<104) for 100% of 2020–2024 samples? **Gold:** Pleasure Bay Beach, Castle Island Beach, City Point Beach. **Off arm answered:** ['Castle Island Beach', 'City Point Beach', 'Pleasure Bay Beach'] (f1 1.0). **On arm answered:** ['City Point Beach', 'Pleasure Bay Beach'] (f1 0.8). The on attempt is the rerun dir; the original 4-arm stats attempt gave the same two-beach answer.

**Gold plan:**
- Per datasheet: skip the title row, read two header rows (site label, then Tag/Enterococcus), and melt to one row per site and date.
- Keep 2020–2024. A beach fails if any sample exceeds 104.
- The pleasure_bay_and_castle_island file holds two beaches, and boston-harbor-beaches.txt lists Castle Island Beach separately.

**Hinge:** stats arm, call 5 (edit rejected; re-sent in call 6, executed successfully in call 7). `parse_beach_measurements` labels every sample with the file's title row (`title = next(... raw.iloc[0] ...)`, then `'beach': title`).
- The Castle Island Playground site is therefore pooled into "Pleasure Bay Beach": 231 samples = 154 + 77.
- The arm never loaded boston-harbor-beaches.txt beyond the call-1 metadata preview, so "Castle Island Beach" never entered its context.

**Evidence at hinge:**
- Stats arm, call 2 statistics: `| Unnamed: 8 | str | 9,678 | 6 | top: < 1,277; > 11; Tag 3; Castle Island Playground 1; other: 2 (not exhaustive) |`. Call 7 result: `| Pleasure Bay Beach, South Boston: Bacterial Water Quality | 231 | 86 | 0 | 100 | true |`
- None arm, call 2: `set beach_names: scan(files='data/environment/input/boston-harbor-beaches.txt', format='lines')` → `| 1 | Castle Island Beach |`. Call 6 code: `beach='Castle Island Beach' if 'Castle Island' in site else 'Pleasure Bay Beach'`.

**Why:** Splitting Castle Island out depends on reading the beach list. Every passing run read it: none in call 2, both in call 1, and flow later. Both stats-only runs, the original and the rerun, skipped it.

The statistics did not mislead. They even surfaced "Castle Island Playground" as a site label, which the arm ignored. The both arm had the same statistics and passed. The 2-of-2 stats-only misses are worth noting, but nothing in the statistics content connects to skipping the file.

---

### Terra legal-easy-19 — none→stats LOSS — VARIANCE
**Question:** What proportion of 2024 fraud reporters lost $1–$500? **Gold:** 0.523. **Off arm answered:** 0.523. **On arm answered:** 0.199.

**Gold plan:** The numerator is the sum of the five bins $1–$100 … $401–$500 (516,308). The denominator is "Reports with $ Loss" (987,520). Report the ratio to 3 decimals.

**Hinge:** stats arm, call 3: `denominator = counts[labels.eq('Number of Fraud Reports')].iloc[0]`. That is all 2,600,678 fraud reports, not only the reports with a loss.

**Evidence at hinge:**
- Both arms, call 2: identical full table, including `| Number of Fraud Reports | 2,600,678 | null |` and `| Reports with $ Loss | 987,520 | 38% of the total |`.
- Stats arm, call 1 statistics: `| Unnamed: 1 | str | 9 | 26 | top: # of Reports 2; "$12,537,194,708 " 1; "$497 " 1; 114,336 1; other: 22 (not exhaustive) |`. This says nothing about denominators. Call 3 reasoning: "divide it by all 2024 fraud reports".
- None arm, call 3: `denominator = counts[labels.eq('Reports with $ Loss')].iloc[0]` → 0.522832955281918.

**Why:** This is a pure denominator interpretation, made with identical full-table evidence in both arms. The flow arm (no statistics) also chose 'Number of Fraud Reports' (0.199), and the both arm chose 'Reports with $ Loss' (0.523).

---

### Terra legal-easy-5 — none→stats GAIN — VARIANCE
**Question:** What is the total fraud loss summed over all payment methods, in $ millions? **Gold:** 5435. **Off arm answered:** 1929. **On arm answered:** 5435.

**Gold plan:** Parse " Total $ Loss" for the 10 payment-method rows ($2,089M → 2,089,000,000), sum them, and report integer millions.

**Hinge:** none arm, call 3: `loss.str.extract(r'^\$(\d+)M$', expand=False)`.
- The regex does not allow a comma, so $2,089M and $1,417M become NaN and are silently skipped: 1929.
- The stats arm's call 3, `loss_text.str.fullmatch(r'\$[0-9,]+M', na=False)` followed by comma stripping, keeps 10 rows: 5435.

**Evidence at hinge:**
- Both arms, call 2: identical full table, including `| Bank Transfer or Payment | 47,336 | $2,089M |` and `| Cryptocurrency | 46,899 | $1,417M |`.
- Stats arm, call 1 statistics: `| Unnamed: 2 | str | 5 | 12 | top: " Total $ Loss " 1; $1,417M 1; $180M 1; $2,089M 1; other: 8 (not exhaustive) |`

**Why:** Both arms' full retrieves showed the comma-formatted values, so the none arm's miss is a regex slip, not an evidence gap. The stats arm's reasoning never mentions the statistics. The flow arm (no statistics) also passed.

---

### Terra legal-hard-14 — none→stats GAIN — VARIANCE
**Question:** What are the top 5 distinct New England metro areas by 2024 identity-theft reports? **Gold:** Boston, Providence, Hartford, Bridgeport, Worcester. **Off arm answered:** Hartford, Bridgeport, Worcester, New Haven, Springfield (f1 0.6). **On arm answered:** the gold list (f1 1.0).

**Gold plan:** Read each New England state's MSA file (skiprows=2, dropna), concat, dedupe by Metropolitan Area, sort by # of Reports, and take the top 5. Multi-state MSAs such as Boston (MA-NH) and Providence (RI-MA) count.

**Hinge:** none arm, call 2: state filter `r'(?:, |–)(?:CT|ME|MA|NH|RI|VT)(?:,| |$)'`.
- It requires a comma, space or end of string after the state code, and it uses an en dash where the data has a hyphen. So "Boston-Cambridge-Newton, MA-NH" and "Providence-Warwick, RI-MA" are excluded.
- The stats arm's call 4 pattern, `r',\s*(?:' + state_pattern + r')(?:-|\s)'`, allows the hyphen.

**Evidence at hinge:**
- None arm before call 2: only the 5-row sample (`| Anniston-Oxford, AL Metropolitan Statistical Area | "264" |`), with no multi-state example.
- Stats arm, call 1 statistics: `| Metropolitan Areas: Identity Theft Reports | str | 156 | 404 |  |`, `| Unnamed: 1 | str | 260 | 343 |  |`, `- note: full table: duplicate rows=359, all-null rows=156`. No name values appear.
- Stats arm, call 2 `full` retrieve (a non-knob view): `| Columbus, GA-AL Metropolitan Statistical Area | 1,302 |`, `| Memphis, TN-MS-AR Metropolitan Statistical Area | 5,502 |`.

**Why:** The stats arm saw the hyphenated multi-state format through a `full` retrieve, which the none arm could equally have made. The statistics table carried no name values. The flow arm passed using only the `sample` view.

---

### Terra legal-hard-16 — none→stats GAIN — VARIANCE
**Question:** Among states with ≥2 metro areas, which has the highest concentration of identity-theft reports in one metro? **Gold:** Delaware. **Off arm answered:** Alaska. **On arm answered:** Delaware.

**Gold plan:** Per state file, `read_csv(skiprows=2).dropna()`, which drops footnote and source rows. Keep states with >1 metro row, compute share = reports / state total, and take the max.

**Hinge:** none arm, call 3. Rows are kept by `section['metro'].notna() & ~section['metro'].str.startswith('Source:')`.
- That keeps the count-less footnote "Metropolitan Areas are defined by the Office of Management and Budget …".
- `metropolitan_areas=('metro','size')` then counts the footnote, so Alaska, which has only Anchorage, qualifies with share 1.0: `| Alaska | 2 | 464 | 464 | 1 |`.
- The stats arm's call 3 keeps `areas.str.contains('Statistical Area', na=False) & nums.notna()`.

**Evidence at hinge:**
- None arm: only the 5-row sample (header row, Anniston, …, null, Source:). The footnote row never appeared.
- Stats arm, call 1 statistics: `| Metropolitan Areas: Identity Theft Reports | str | 156 | 404 |  |`, `| Unnamed: 1 | str | 260 | 343 |  |`.
- Stats arm, call 2 `full` retrieve: `| Anchorage, AK Metropolitan Statistical Area | "464" |`, then `| Metropolitan Areas are defined by the Office of Management and Budget, … | null |`.

**Why:** The stats arm saw the footnote in a `full` retrieve, not in the statistics. The null-count gap (156 vs 260 nulls) is never referenced in its reasoning. The flow arm (no statistics, `sample` view only) filtered on `part['reports'].notna()` and passed.

---

### Terra legal-hard-17 — none→stats LOSS — VARIANCE
**Question:** If 2007 had 2024's category distribution, how many 2007 reports would be Auto Related? **Gold:** 32542. **Off arm answered:** 32542. **On arm answered:** 32587.

**Gold plan:** 2007 total (1,070,447) × the published 2024 Auto Related percentage (3.04%), rounded: 32542.

**Hinge:** stats arm, call 3 (fixed and executed in call 4): `share = auto_2024 / report_2024`. This derives the share from counts (197,015 / 6,471,708 = 3.0443%) instead of using the published Percentage column, giving 32587.09.

**Evidence at hinge:**
- Stats arm: it never retrieved the full category table.
  - Call 2 statistics: `| Unnamed: 3 | str | 5 | 29 | top: 0.08% 2; 0.02% 1; 0.03% 1; 0.05% 1; other: 25 (not exhaustive) |`.
  - Call 3 reasoning: "using the exact 2024 Auto Related share derived from the supplied category and annual-total tables". Doc: `'2007 report count multiplied by the exact 2024 Auto Related fraction of all 2024 reports.'`
  - Its system prompt adds "Compute exact answer quantities in the graph, not from rounded summaries."
- None arm: call 2 `full` shows `| "7" | Auto Related | 197,015 | 3.04% |`. Call 3 uses `share = float(str(category['Unnamed: 3']).replace('%', '')) / 100` → 32542.

**Why:** This is an interpretation choice: published percentage versus exact derived share. The repeated "exact" echoes the statistics paragraph, so a prompt nudge is possible but not established, for two reasons:
- The both arm had the identical paragraph, also skipped the `full` retrieve, and still used the published percentage (32542).
- The base prompt shared by all arms already says "Retain calculation precision and round only final presentation."

The statistics table itself points nowhere near the exact share.

---

### Terra legal-hard-2 — none→stats LOSS — VARIANCE
**Question:** Which MSA has the highest identity-theft rate per 100k, with 2023 population interpolated? **Gold:** Miami-Fort Lauderdale-West Palm Beach FL MSA. **Off arm answered:** "Miami-Fort Lauderdale-West Palm Beach, FL Metropolitan Statistical Area" (judge yes). **On arm answered:** "Baton Rouge, LA MSA".

**Gold plan:**
- Concat all state MSA report files.
- From the HTML table "387 metropolitan statistical areas", compute pop2023 = 2020 + ¾ × (2024 − 2020).
- Key = lowercase name with the "metropolitan statistical area|msa" suffix stripped and **all** non-alphanumerics deleted.
- Inner join, compute reports / pop × 1e5, and take the max.

**Hinge:** stats arm, call 6: the key function `re.sub(r'[^a-z0-9]+', ' ', s).strip()`, applied after ASCII folding.
- ASCII folding deletes the HTML's en dashes, giving "miamifort lauderdalewest palm beach fl".
- The CSV's hyphens become spaces, giving "miami fort lauderdale west palm beach fl".
- So every hyphenated multi-city MSA, Miami included, fails to match: 224 matched rows versus 368 in the none arm. I replayed both key functions on the two Miami names to confirm.

**Evidence at hinge:**
- Stats arm, call 6 observation (`sample_stats` of rates, after the decision): `result: 224 rows × 5 columns`; `| population_2023 | float64 | 0 | 224 | 99971.5 to 2814008.5; ...`, meaning no metro above 2.8M people matched; top row `| Baton Rouge, LA MSA | Baton Rouge, LA Metropolitan Statistical Area | 4604 | 879631.25 | 523.401141103161 |`.
- None arm, call 4: `return re.sub(r'[^a-z0-9]', '', s)` → 368 rows; top row `| Miami-Fort Lauderdale-West Palm Beach, FL Metropolitan Statistical Area | Miami–Fort Lauderdale–West Palm Beach, FL MSA | 55457 | … | 869.49442459062 |`.

**Why:** This is a one-character normalization slip, made before any statistics on the result existed. When the statistics arrived, the 2.8M population ceiling was a visible warning that the arm did not act on. The statistics content was unrelated to the decision and, if anything, pointed at the error. The flow arm passed. The both arm failed by a different mechanism: `groupby(['metro_key','report_area'])['reports'].sum()` summed multi-state reports and led to Philadelphia.

---

### Terra legal-hard-23 — none→stats GAIN — VARIANCE
**Question:** Which state, including DC and PR, has the highest all-report density per 100K? **Gold:** District of Columbia. **Off arm answered:** Florida. **On arm answered:** District of Columbia.

**Gold plan:** Use the identity-theft and fraud/other state-ranking tables. Population = reports / rate, and density = (IT + fraud reports) / population, which is about the sum of the two per-100K rates. Include the unranked DC and PR rows. DC wins with 480 + 2,509 = 2,989.

**Hinge:** Both arms made the same error in call 2: they kept only rows with a numeric rank, which drops the unranked DC and PR rows, leaving 50 rows with Florida at 2691.
- None arm: `frame['rank'].astype('string').str.fullmatch(r'\d+')`, executed in call 3; it answered in call 4.
- Stats arm: `x.loc[x['rank_num'].notna()]`. In call 3 it reasoned "Check the unmatched jurisdiction labels so DC and Puerto Rico are included in the all-report density comparison".
- In calls 4–5 it retrieved the full columns, which show `| null | District of Columbia | "480" | 3,225 |` and the footnote "…are included in the table but are not ranked".
- In call 6 it recomputed without the rank filter: 52 rows, DC.

**Evidence at hinge:**
- Both arms after the rank filter: `result: 50 rows × 7 columns` and `| Florida | 528 | 115840 | 2163 | 474314 | 2691 | 590154 |`. Both had the question text "(including DC and PR)".
- Stats arm, call 1 statistics: `| Unnamed: 1 | str | 5 | 53 | top: Alabama 1; Alaska 1; Arizona 1; Arkansas 1; other: 49 (not exhaustive) |`. 53 distinct = 50 states + DC + PR + the header row. No reasoning cites it.

**Why:** The recovery is a self-check against the question's "(including DC and PR)" and the 50-row receipt, and the none arm had both of those in context. The both arm saw the same "53" statistics line, got the same 50-row Florida result, and answered Florida. Three of the four dataflow arms failed.

---

### Terra wildfire-easy-3 — none→stats LOSS — KNOB-ROUTE
**Question:** Which US states fall into the most NIFC Geographic Areas? **Gold:** California, Nevada. **Off arm answered:** ['California', 'Nevada']. **On arm answered:** ['California'] (f1 0.67).

**Gold plan:** Dissolve usa.gpkg counties to states by adm1_name. Reproject the NIFC areas to the states' CRS, spatial-join with intersects, count nunique GACC per state, and take the max (CA and NV tie).

**Hinge:** stats arm, call 8. It replaced the polygon overlay with county representative points: `points['geometry'] = points.geometry.representative_point()` followed by `gpd.sjoin(points, areas, predicate='within')`.
- This counts only the areas that contain some county's interior point: CA 3, NV 1.
- Precondition: in calls 5–6 the arm reprojected both layers *before* the overlay (`to_crs('EPSG:5070')`, then `'EPSG:6933'`), and both attempts failed with `GEOSException: ... CGAlgorithmsDD::orientationIndex encountered NaN/Inf numbers`.

**Evidence at hinge:**
- Stats arm, call 7 (`sample_stats` of geometry diagnostics):
  - States (EPSG:4326): `| minx | float64 | 0 | 3,105 | -538.0732 to -68.105016752 |`, `| maxx | float64 | 0 | 3,103 | -160.187619922 to 538.70432 |`, `| maxy | float64 | 0 | 3,084 | 23.571492305 to 430.27838 |`
  - Areas: `| minx | float64 | 0 | 120 | -179.231086 to 179.388742; …`
  - Call 8 reasoning: "Avoid malformed antimeridian polygon overlays by assigning each county's interior representative point to NIFC area polygons and counting distinct assigned areas per state."
- None arm, call 2: `areas = areas.to_crs(states.crs)`, then `gpd.overlay(states, areas, how='intersection', keep_geom_type=False)`, then `.to_crs('EPSG:6933')` with area > 0 → `| California | 5 |` and `| Nevada | 5 |`.

**Why:** The out-of-range coordinate ranges in the statistics are accurate, and they led the arm to diagnose "malformed antimeridian polygons" and abandon polygon intersection for a point-in-polygon proxy that undercounts Nevada. The error happened on that new route.

The route was only entered because of an earlier, knob-independent choice to reproject before the overlay; the none arm never hit that error. The both arm (statistics on) aligned the areas to the county CRS and passed in 6 calls. The stats arm used 9 calls and $0.090 against 4 calls and $0.031, well within the cap and time limit, so this is not a budget failure.

---

### Terra wildfire-hard-18 — none→stats LOSS — EVAL-ARTIFACT
**Question:** Controlling for weather, does more aggressive suppression make fires end faster and affect fewer buildings? **Gold:** "More aggressive suppression does not help fires end faster but helps fires affect less buildings." **Off arm answered:** "More aggressive suppression is associated with fewer buildings at risk, but not faster fire containment—weather-controlled fires lasted longer" (judge yes). **On arm answered:** "More aggressive suppression was associated with fewer buildings threatened, but not with fires ending faster—instead, it was associated with longer fire durations" (judge no).

**Gold plan:** HC3 OLS of duration and of prim_threatened_aggregate on the 25/50/75% full-suppression indicator plus avrh_mean, wind_med, erc_med, rain_sum and hec. Conclusion: no faster end, fewer buildings.

**Hinge:** None. Both arms regressed on dom_strat_ind_75 with weather controls and reached the gold's conclusion.
- Stats arm, call 3: linear OLS with weather plus year, region, cause, season and gt_100 controls → `| duration_days | 6657 | 20.9919234504274 | … | higher |` and `| buildings_threatened | 6657 | -819.720837256573 | … | lower |`.
- None arm, call 4: log1p OLS with the four weather controls → `| duration_days | weather_adjusted_suppression_effect_pct | 1 | 181.193613488932 |`, and about 82% fewer buildings.

**Evidence:** The cached gpt-5-mini paraphrase verdicts (`benchmark/Kramabench/benchmark/fixtures/paraphrase_cache.json`, keyed by model, answer and gold) are none True, flow False, stats False, both True. The both arm's "…fewer buildings at risk but not with fires ending faster—in fact, adjusted fire duration was longer" was accepted. The stats arm's near-identical sentence was rejected.

**Why:** The two final sentences say the same thing as each other and as the gold: not faster, fewer buildings, and the same extra "longer duration" clause. The statistics (column ranges of the wildfire table) played no part in either conclusion. The flip is the yes/no paraphrase judge reacting to wording.

---

## Summary

| task | direction | class | one-line reason |
|---|---|---|---|
| astronomy-hard-10 | LOSS | KNOB-MISLED | Statistics range "… to 9.99e+32" led to the row filter `< 1e-10`, which dropped 6 fill-only hours (215→209). r moved −0.1934→−0.1912; the gold keeps those hours. |
| biomedical-hard-7 | LOSS | VARIANCE | The default header made gene BRD8 the column name (15 vs 16). Decided before any statistics; the flow arm made the same error and the both arm did not. |
| environment-easy-3 | LOSS | VARIANCE | Keyed beaches on Beach Name only (267 of 1,124 vs 268 of 1,138). The both arm saw the same statistics and used the composite key. |
| environment-hard-9 | LOSS | VARIANCE | Never read the beach list and labeled samples by file title, pooling Castle Island into Pleasure Bay. The statistics even showed "Castle Island Playground". |
| legal-easy-19 | LOSS | VARIANCE | Denominator "Number of Fraud Reports" instead of "Reports with $ Loss", from an identical full table. The flow arm made the same choice. |
| legal-hard-17 | LOSS | VARIANCE | Used the exact count-derived share (3.0443%) instead of the published 3.04%. The both arm, with the same prompt sentence, used 3.04%. |
| legal-hard-2 | LOSS | VARIANCE | The name key turned hyphens into spaces but dropped en dashes, so Miami was unmatched (224 vs 368 matches). The statistics warned (max pop 2.8M) and were ignored. |
| wildfire-easy-3 | LOSS | KNOB-ROUTE | After a knob-independent reprojection error, the ±538° bounds statistics led to county representative points, which undercount Nevada. |
| wildfire-hard-18 | LOSS | EVAL-ARTIFACT | Same conclusion as the none arm and the gold; the gpt-5-mini paraphrase judge said no to this wording. |
| legal-easy-5 | GAIN | VARIANCE | The none arm's regex `^\$(\d+)M$` skipped $2,089M and $1,417M, which both arms saw in the full table. The flow arm passed without statistics. |
| legal-hard-14 | GAIN | VARIANCE | The none arm's state regex excluded "MA-NH" and "RI-MA". The stats arm saw multi-state names in a `full` retrieve, not in the statistics. The flow arm passed. |
| legal-hard-16 | GAIN | VARIANCE | The none arm counted the footnote row as a metro (Alaska with 2 areas). The stats arm filtered on numeric counts, and so did the flow arm without statistics. |
| legal-hard-23 | GAIN | VARIANCE | Both arms dropped the unranked DC and PR rows. The stats arm self-checked against the question; the both arm, with the same statistics line, did not. |

**What the knob's content did to the model's decisions:** In this group the net is −5 for stats (9 losses, 4 gains). Trace evidence ties two losses, and no gains, to the statistics content:
- **astronomy-hard-10:** a statistics range exposed a 9.99e+32 fill value, and the model removed it. That is sound cleaning, but the gold does not do it.
- **wildfire-easy-3:** accurate out-of-range bounds statistics steered recovery from a knob-independent projection error onto a lossy representative-point method.

The rest breaks down as follows:
- One loss (wildfire-hard-18) is a paraphrase-judge artifact.
- Six losses and all four gains are method or interpretation choices made from identical or irrelevant evidence. In each case the flow arm (no statistics) or the both arm (statistics on) made the same choice, or the opposite one, regardless of the statistics.
- That leaves roughly −2 knob-caused, −1 judge, and −2 variance (6 losses − 4 gains).

Most of the time the model read the statistics and did nothing with them. In two losses they held a visible clue that went unused: "Castle Island Playground" in environment-hard-9, and a 2.8M population ceiling that exposed missing big metros in legal-hard-2. In no case did the statistics catch an error the none arm made. When the model did act on them, it was to clean or work around data problems the profile surfaced (fill values, malformed coordinates). The gold solutions skip that step, so accurate profile facts turned into divergences from the gold.

The statistics prompt's "Compute exact answer quantities … not from rounded summaries" may have nudged legal-hard-17 toward an exact share instead of the published percentage. The both arm ignored the same sentence, so this is unproven.

**Note on repository state:** `benchmark/Kramabench/benchmark/fixtures/paraphrase_cache.json` shows as modified in the submodule, with mtime 10:39:29 today. That write did not come from this analysis: I only opened the cache to look up verdicts, and read-only.
