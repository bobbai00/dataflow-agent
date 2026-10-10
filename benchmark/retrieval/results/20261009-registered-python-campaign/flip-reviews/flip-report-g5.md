# Flip report, group 5: Terra stats→both (flow off vs flow on, statistics on in both)

Nine gains, one loss. Call numbers count the `dataflow` tool calls in each attempt, starting at 1. Quotes are copied from the observations or code the model received. The off arm for environment-hard-9 is the rerun `20261009-rerun-terra-environment-hard-9`. It used agent revision e8bd686e3; the 4-arm run used bee35f498, and both have the same `working_tree_sources_sha256`. The original 4-arm stats attempt gave the same answer as the rerun.

---

### Terra astronomy-hard-10 — stats→both GAIN — VARIANCE
Which OMNI2/Sat_Density variable correlates most strongly with Swarm-A's hourly altitude change from 2018-10-01 to 10-10? Gold: `['Proton_flux_>30_Mev', -0.193]`. Off arm (stats) answered `['Proton_flux_>30_Mev', -0.191]` (f1 0.5). On arm (both) answered `['Proton_flux_>30_Mev', -0.193]`.

Gold plan: Parse the PL47 positions from the SP3 files and compute altitude = |r| − 6371.0. Take the hourly mean, then `diff()`. Slice OMNI2 and Sat_Density to 10-01..10-10, take hourly means and `dropna`. Fill values such as 9.99e+32 are kept. Inner-join the three tables on the hour, compute the Pearson r of each column against delta_alt, and take the largest |r|.

Hinge: stats arm, call 5 (`rank_hourly_correlations`). The code `d = d[np.isfinite(d[dval]) & (d[dval] < 1e-10)]` drops the density fill-value rows, and then `o.merge(d, on='_hour', how='inner', ...)` runs. Hours whose density readings were all fill values disappear from the sample of every variable. That leaves 209 paired hours instead of 215, and r = −0.19124. The both arm (calls 4–5) instead set fill values to NaN with `d.loc[... >= 1e20, ...] = np.nan`. The hour stays in the join, correlations are computed pairwise, and the result is 215 pairs with r = −0.19344.

Evidence at hinge:
```text
both arms (stats call 3 / both call 2), same statistics row:
  | Orbit Mean Density (kg/m^3) | float64 | 0 | 4,196 | 9.34323999901021e-14 to 9.99e+32 |
stats call 5 result:
  | Proton_flux_>30_Mev | -0.191243748694876 | 209 | 0.191243748694876 |
both arm, flow lines before its decision were scan counts only:
  - flow: Scan parsed selected sources; files selected=10/10, omitted=0; output=4330 rows.
both call 4 code:  # Density observations are 10-minute values. Sentinel fill values are not physical density.
both call 5 result: | Proton_flux_>30_Mev | -0.19344252820628 | 215 |   ...   | Orbit Mean Density (kg/m^3) | -0.00554643744932835 | 209 |
  - flow: correlate_hourly_sources input rows=[1441,4330], output=50; row/column mapping unknown.
```
Why: Both arms read the same statistics row showing the 9.99e+32 sentinel, and both removed it. The stats arm removed whole rows before an inner join, which shrank all 50 correlations to 209 hours. The both arm masked the values, so only the density column used 209 hours. That variable's r is identical in both arms, −0.005546, which confirms the mechanism. The masking choice came before any non-scan flow line. The only flow line about the custom operator is the "mapping unknown" boilerplate, and it appeared after the decision. The none and flow arms had no statistics and did no fill handling; they got 215 hours and −0.193.

---

### Terra biomedical-hard-7 — stats→both GAIN — VARIANCE
How many genes are significant by acetylproteomics? Gold: 16. Off arm answered 15. On arm answered 16.

Gold plan: The README sheet maps "Significant genes by acetylproteomics" to sheet D-SE-acetyl. That sheet is a gene list with no header, so the count is the parsed rows plus the first gene (BRD8), which pandas reads as the header: 15 + 1 = 16.

Hinge: stats arm, call 2. It ran `scan(..., format='excel', sheet='D-SE-acetyl')` with the default header, so gene BRD8 became the column name. In call 3, `aggregate(acetyl, outputs={'significant_gene_count': count()})` returned 15.

Evidence at hinge:
```text
both arms, call 1 (inspect source, not a flow line):
  | "D-SE-acetyl" | "BRD8" | retained |   ("First raw rows are raw layout hints, not parsed column schemas.")
stats call 2:  | 0 | "BRD8" | str |
               | BRD8 | str | 0 | 15 | top: CDK1 1; CEBPZ 1; DHX15 1; FBXO22 1; other: 11 (not exhaustive) |
both call 3:   set acetyl_genes: scan(..., sheet='D-SE-acetyl', header=False, names=['Gene'])
  flow lines before that choice (scan counts only):
                 - flow: Scan preview only (not full source); files selected=1/1, omitted=0; output=7 rows.   (workbook preview)
                 - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=6 rows.          (README)
  after:         - flow: "significant_gene_count" row denominator=16/16; per-group min=16, max=16; reducer=count.
```
Why: The both arm chose `header=False` on its first read of the sheet. It based that on the same inspect-source raw-row hint that the stats arm ignored. No flow line ever flags this sheet's header (it has no blank header cells). The flow-only arm made the stats arm's exact mistake while its flow lines reported `output=15 rows` and `row denominator=15/15`, and the none arm passed. Two of four arms pass, so this is a chronic flipper.

---

### Terra environment-easy-3 — stats→both GAIN — VARIANCE
Among beaches sampled in 2012, how many had a higher exceedance rate in 2013 than in 2012? Gold: 268. Off arm answered 267. On arm answered 268.

Gold plan: The beach id is Community Code + County Code + lowercase Beach Name. For each year, samples = rows and exceedances = `Violation == 'yes'`, giving a rate. Inner-join the two years and count beaches where rate_2013 > rate_2012.

Hinge: stats arm, call 2. It grouped with `groupby('Beach Name')` alone, which merges same-named beaches in different communities. That gave 1,124 beaches compared and 267 higher.

Evidence at hinge:
```text
both arms, call 1, identical statistics:
  | Beach Name | str | 0 | 1,155 |  |
  | Community Code | int64 | 0 | 221 | 1 to 351; top: 35 891; 96 686; 243 480; 351 478; ... |
stats call 2 result:  | 267 | 1124 |
both call 2: keys = ['Community Code', 'Beach Name']  ("using its community and beach name as the beach identifier")
  result:   | 268 | 1171 | 1138 |
  flow before the choice: - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=15377 rows.
  flow after:             - flow: compare_beach_exceedance_rates input rows=[15377,15388], output=1; row/column mapping unknown.
```
Why: Both arms chose the key at their first compute call, with the same data in context. The flow lines at that point were scan counts. The none and flow arms also got 268; only the stats arm used a name-only key.

---

### Terra environment-hard-20 — stats→both GAIN — VARIANCE
In 2015, what are the three most polluted beaches of the city with the least June–August rainfall? Gold: `['Bucks Creek', 'Pleasant Street', 'Forest Street']`. Off arm answered `[..., 'Schoolhouse Pond']`. On arm answered `[..., 'Forest Street']`.

Gold plan: Sum the 2015 Jun–Aug rainfall for the four cities; Chatham is lowest. Keep the 2015 tests with Community == Chatham and strip the '@' suffix from beach names. For each beach, exceedance rate = 'yes' rows / samples; take the top 3 by rate.

Hinge: stats arm, call 2. `chatham_beach_pollution` sorts by `['mean_indicator', 'total_indicator', 'Beach Name']`, meaning the mean Indicator Level rather than the violation rate. Schoolhouse Pond, with 0 violations, ranks third.

Evidence at hinge:
```text
stats call 2 result: | Schoolhouse Pond | 12 | 186 | 15.5 | 132 | 0 |
both call 2: planned both rankings, boston_by_violations and boston_by_mean_level (edit rejected: EDIT_REJECTED ... Custom settings must be Python literals)
both call 3: kept only sort(boston_pollution, by=[('violation_samples', 'desc'), ('mean_indicator_level', 'desc'), ('Beach Name', 'asc')])
             reasoning: "rank Boston beaches by failed water-quality samples"
both call 4 (Chatham): | Forest Street | 1 | 12.0769230769231 | 110 | 13 |
flow lines before the metric choice: - flow: Scan parsed selected sources; files selected=4/4, omitted=0; output=116 rows.
                                     - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=15898 rows.
```
Why: Mean indicator level versus violation count is an interpretation choice. It was made before any non-scan flow line, and the both arm itself planned both rankings and then dropped one after an error that carried no flow content. The both arm ranked by violation count, not rate; the two orderings agree on the top 3 here. Caveat: pass_pattern splits exactly on flow. The none and stats arms ranked by mean indicator and failed. The flow arm ranked by `['violations','violation_rate',...]` in call 2, after only scan-count flow lines, and passed. With one repetition per arm, a nudge from the system-prompt paragraph cannot be ruled out, but no flow content in any of the traces bears on the metric.

---

### Terra environment-hard-9 — stats→both GAIN — VARIANCE
Which Boston Harbor beaches met the Enterococcus standard (<104) in every 2020–2024 sample? Gold: `['Pleasure Bay Beach', 'Castle Island Beach', 'City Point Beach']`. Off arm (rerun) answered `['City Point Beach', 'Pleasure Bay Beach']` (f1 0.8). On arm answered `['Castle Island Beach', 'City Point Beach', 'Pleasure Bay Beach']`.

Gold plan: Read each of the 8 datasheets with `skiprows=1` and a two-row header (the site row plus Tag/Enterococcus), and melt to one row per site. Keep 2020–2024. A file qualifies if no Enterococcus value exceeds 104. The pleasure_bay_and_castle_island file holds two beaches, and the gold answer lists both.

Hinge: stats arm, call 5, kept through calls 6–7. `parse_beach_measurements` labels every sample with the file's title row, `title = next(... raw.iloc[0] ...)`. The Pleasure Bay/Castle Island file therefore collapses into "Pleasure Bay Beach, South Boston: Bacterial Water Quality", and Castle Island never appears as a beach. This arm never read the beach list: in call 1 it scanned boston-harbor-beaches.txt with `preview=1` and only inspected its source.

Evidence at hinge:
```text
stats call 2 statistics (cue present, unused):
  | Unnamed: 8 | str | 9,678 | 6 | top: < 1,277; > 11; Tag 3; Castle Island Playground 1; other: 2 (not exhaustive) |
stats call 4: records: full; 19 of 144 rows ... cut at 5,000 characters   (Carson rows 0-17 plus City Point row 0; Pleasure Bay file never shown)
stats call 7: | Pleasure Bay Beach, South Boston: Bacterial Water Quality | 231 | 86 | 0 | 100 | true |
both call 1 (guide fully scanned and retrieved): | 1 | Castle Island Beach |
both call 1 flow:   - flow: Scan: 9 header cells of `pleasure_bay_and_castle_island_beach_datasheet.csv` are blank.
both call 3: | pleasure_bay_and_castle_island_beach_datasheet.csv | 1 | ,,,,Pleasure Bay @ Broadway,,Pleasure Bay @ Flagpole,,Castle Island Playground, |
both call 4: ('pleasure_bay_and_castle_island_beach_datasheet.csv', {5: 'Pleasure Bay Beach', 7: 'Pleasure Bay Beach', 9: 'Castle Island Beach'})
```
Why: What decided this task was the beach list and the site-name row. The both arm read both on its own initiative, and its guide scan was issued in call 1, before any flow line existed. The flow header line names the file but says nothing about two beaches, and the file name containing "castle_island" was already in both arms' task prompt. The none arm (no flow) read the guide in call 2 and passed. The flow arm saw the same header line, first labelled the file "Pleasure Bay and Castle Island Beach", and split it only after re-reading the guide. Both stats-arm runs, the original and the rerun, failed the same way and never read the guide's content. That is a repeated stats-arm behaviour, but nothing in the traces ties it to either knob.

---

### Terra legal-easy-19 — stats→both GAIN — VARIANCE
What proportion of 2024 fraud reporters lost between $1 and $500? Gold: 0.523. Off arm answered 0.199. On arm answered 0.523.

Gold plan: The numerator is the sum of the $1–$100 … $401–$500 bins in the "$1 - $1,000 Range" sub-table. The denominator is "Reports with $ Loss" (987,520).

Hinge: stats arm, call 3. It used `denominator = counts[labels.eq('Number of Fraud Reports')].iloc[0]`, which is 2,600,678 (all fraud reports), giving 0.199.

Evidence at hinge:
```text
both arms, call 2, identical full table:
  | Number of Fraud Reports | 2,600,678 | null |
  | Reports with $ Loss | 987,520 | 38% of the total |
  both reasonings: "... its appropriate (reporter) denominator."
both call 3: denominator = lookup['Reports with $ Loss']   ("using all reporters who reported a dollar loss as the denominator")
both arm's only flow lines before that:
  - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=36 rows.
  - flow: Scan: 2 header cells of `2024_CSN_Fraud_Reports_by_Amount_Lost.csv` are blank.
```
Why: This is a pure choice of denominator, made from identical evidence, and the flow lines say nothing about denominators. The flow-only arm answered 0.199 like the stats arm, and the none arm answered 0.523. Two of four arms pass, so this is a chronic flipper.

---

### Terra legal-hard-17 — stats→both GAIN — VARIANCE
If 2007's report-category distribution matched 2024's, how many 2007 reports would be Auto Related? Gold: 32542. Off arm answered 32587. On arm answered 32542.

Gold plan: Multiply the 2007 total (1,070,447) by the published 2024 Auto Related Percentage (3.04%) and round: 32542.

Hinge: stats arm, call 3 (repaired in call 4). It computed `estimate = report_2007 * auto_2024 / report_2024`: the Auto Related count (197,015) divided by the 2024 total from the yearly file (6,471,708), rather than the published Percentage column. The result was 32,587.09.

Evidence at hinge:
```text
both arms' sample rows show the column:
  | Rank | Category | " # of Reports " | Percentage |
  | "1" | Credit Bureaus and Information Furnishers | 1,353,175 | 20.91% |
stats call 3 reasoning: "using the exact 2024 Auto Related share derived from the supplied category and annual-total tables"
stats call 4 result: | 1070447 | 6471708 | 197015 | 32587.0876289536 | 32587 |
both call 1 flow: - flow: Scan: 3 header cells of `2024_CSN_Report_Categories.csv` are blank; skip_lines=2 gives the header "Rank", "Category", " # of Reports ", "Percentage".
both call 2: pct_text = category_table.iloc[:, 3] ...  (doc: "published 2024 Auto Related percentage")
  result: | 1070447 | 0.0304 | 32541.5888 | 32542 |
```
Why: Using the published rounded percentage or recomputing a share from counts is an interpretation choice. The "Percentage" header that the flow hint repeats was already in both arms' sample rows, and the both arm did not use `skip_lines`; it indexed columns by position. The stats arm's "exact share" wording echoes a sentence in the statistics prompt, "Compute exact answer quantities in the graph, not from rounded summaries". The both arm had the same sentence and still used the published figure. The none and flow arms passed, so the stats arm was the only one to fail.

---

### Terra legal-hard-23 — stats→both LOSS — VARIANCE
Which state, including DC and PR, has the highest combined report density per 100K across identity theft and fraud/other reports? Gold: District of Columbia. Off arm (stats) answered District of Columbia (pass). On arm (both) answered Florida.

Gold plan: For every row of the identity-theft table, including the unranked DC and PR rows, population = reports / per-100K. Density = (identity + fraud/other reports) / population; take the maximum, which is DC. Equivalently, sum the two per-100K values: 480 + 2,509 = 2,989.

Hinge: both arm, call 2 (succeeded in call 3). `load_state_rankings` keeps only rows where `raw['rank'].str.fullmatch(r'\d+', na=False)`, which drops the unranked DC and PR rows. That leaves 50 states and Florida at 2,691. In call 4 it answered without checking the gap between 50 and 52 jurisdictions.

Evidence at hinge:
```text
both call 1 flow: - flow: Scan: 3 header cells of `2024_CSN_State_Rankings_Identity_Theft_Reports.csv` are blank; skip_lines=2 gives the header "Rank", "State", "Reports per 100K Population", "# of Reports".
both call 2 code:  raw = pd.read_csv(path, skiprows=2, dtype=str) ... raw.loc[raw['rank'].str.fullmatch(r'\d+', na=False), ...]
both call 3 flow:  - flow: combine_densities input rows=[50,50], output=50; row/column mapping unknown.
                   - flow: Limit retained=1/50, removed=49.
both call 4: "The computed top combined-density state is current and verified."
stats call 2: same cut, x.loc[x['rank_num'].notna()] -> result: 50 rows × 7 columns -> | Florida | 528 | 115840 | 2163 | 474314 | 2691 | 590154 |
stats call 3: "Check the unmatched jurisdiction labels so DC and Puerto Rico are included in the all-report density comparison."
stats call 5: | null | District of Columbia | "480" | 3,225 |  -> call 6: | District of Columbia | 480 | 3225 | 2509 | 16860 | 2989 |
```
Why: All four arms wrote the same numeric-rank filter. The none arm used `pd.read_csv(path, header=1)` plus `str.fullmatch(r'\d+')`, and the flow arm used the same `fullmatch`. So the error does not depend on the `skip_lines=2` hint that the both arm copied into `skiprows=2`. Only the stats arm ran an extra check for DC and PR and recovered. The flow lines at the hinge reported the 50-row count accurately and did not prompt a check, so flow neither misled the model nor rescued it. With none, flow and both failing and only stats passing, the stats pass is the outlier.

---

### Terra wildfire-easy-3 — stats→both GAIN — VARIANCE
Which US states fall into the most NIFC Geographic Areas? Gold: `['California', 'Nevada']`. Off arm answered `['California']`. On arm answered `['California', 'Nevada']`.

Gold plan: Dissolve the usa.gpkg counties by `adm1_name` and spatially join them to the NIFC GACC polygons with `predicate='intersects'`. Count distinct GACCs per state and take the maximum; California and Nevada tie.

Hinge: stats arm, call 5. It chose `gpd.overlay(..., how='intersection')` in EPSG:5070 with an `overlap_sq_m > 1` threshold. That raised `GEOSException: ... NaN/Inf numbers` in calls 5 and 6 (call 6 used EPSG:6933). After a diagnostics call (call 7), call 8 switched to county `representative_point()` with `predicate='within'`, which undercounts states that span several areas: California 3, Nevada 1.

Evidence at hinge:
```text
stats call 7 statistics: | minx | float64 | 0 | 3,105 | -538.0732 to -68.105016752 |
stats call 8 reasoning: "Avoid malformed antimeridian polygon overlays by assigning each county's interior representative point to NIFC area polygons"
stats call 8 result: | California | 3 |  ...  | Nevada | 1 |
both call 5 code: matched = areas.loc[areas.geometry.intersects(state.geometry), 'GACCName'].dropna().unique()
both call 5 result: | California | 5 |  | Nevada | 5 |
both arm flow lines (all custom-Python boilerplate): - flow: state_area_counts input rows=[], output=51; row/column mapping unknown.
```
Why: The divergence is the spatial predicate each arm chose at its first compute call: a projected area overlay versus plain `intersects`, which is the gold's predicate. The both arm never hit the GEOS failure, and none of its flow lines carries spatial information. The stats arm's fallback was steered by its own coordinate-bounds statistics, on a route the both arm never took. The none and flow arms passed.

---

### Terra wildfire-hard-18 — stats→both GAIN — EVAL-ARTIFACT
Controlling for weather, does more aggressive suppression make fires end faster and threaten fewer buildings? Gold: "More aggressive suppression does not help fires end faster but helps fires affect less buildings." Off arm answered: "More aggressive suppression was associated with fewer buildings threatened, but not with fires ending faster—instead, it was associated with longer fire durations" (llm_paraphrase 0). On arm answered: "More aggressive suppression was associated with fewer buildings at risk but not with fires ending faster—in fact, adjusted fire duration was longer" (llm_paraphrase 1).

Gold plan: Build Full Suppression indicators at 25/50/75%, `dropna`, and fit OLS (HC3) of duration and of prim_threatened_aggregate on each indicator plus avrh_mean, wind_med, erc_med, rain_sum and hec.

Hinge: There is no computational hinge. In call 3 both arms fit the same design: dom_strat_ind_75, the four weather variables, and year/region/cause dummies, with buildings = prim + comm + outb.

Evidence at hinge:
```text
stats call 3: | duration_days | 6657 | 20.9919234504274 | 10.5351060132082 | higher |
              | buildings_threatened | 6657 | -819.720837256573 | 659.964025026069 | lower |
both call 3:  | duration | 6649 | 51.2416851441242 | 10.5368018096398 | 20.7965357734719 | 0.726712861766101 | 4.09727162063298e-180 | ...
              | buildings_total | 6649 | 380.175166297118 | 660.764050809118 | -814.84369607012 | 231.114900318488 | 0.000422352070322951 | ...
  - flow: suppression_weather_models input rows=[6658], output=2; row/column mapping unknown.
```
Why: Same method, same numbers (+21 vs +20.8 days, −820 vs −815 buildings) and the same conclusion; the judge accepted one wording and rejected the other. The judge is inconsistent across arms as well. The none arm passed with "weather-controlled fires lasted longer". The flow arm failed with "does not appear to help fires end faster; it is associated with fewer buildings threatened".

---

## Summary

| task | direction | class | one-line reason |
|---|---|---|---|
| astronomy-hard-10 | GAIN | VARIANCE | Stats arm dropped density fill-value rows before an inner join (209 vs 215 hours). Both arm masked them to NaN. Same statistics cue; no flow content at the choice. |
| biomedical-hard-7 | GAIN | VARIANCE | Stats arm read the header-less gene sheet with a header (15). Both arm chose `header=False` on its first read. Flow-only arm failed the same way (2/4 pass). |
| environment-easy-3 | GAIN | VARIANCE | Beach key: Beach Name only vs Community Code + Beach Name, chosen at the first compute call with only scan-count flow lines. |
| environment-hard-20 | GAIN | VARIANCE | Ranked by mean indicator level vs violation count. pass_pattern splits 2–2 on flow, but no flow content bears on the choice. |
| environment-hard-9 | GAIN | VARIANCE | Stats arm never read the beach list and labelled by file title, losing Castle Island. Both arm read the guide in call 1. The none arm also passed. |
| legal-easy-19 | GAIN | VARIANCE | Denominator: all fraud reports vs reports with $ loss, from identical evidence. Flow-only arm made the same error (2/4 pass). |
| legal-hard-17 | GAIN | VARIANCE | Recomputed count share (32587) vs published 3.04% (32542). The Percentage header was visible in both arms' sample rows. |
| legal-hard-23 | LOSS | VARIANCE | All four arms dropped unranked DC/PR with the same rank filter; only the stats arm checked and recovered (1/4 pass). |
| wildfire-easy-3 | GAIN | VARIANCE | Projected area overlay crashed and fell back to county points (CA 3, NV 1) vs plain `intersects` (5, 5). |
| wildfire-hard-18 | GAIN | EVAL-ARTIFACT | Same OLS, same numbers, same conclusion; the LLM judge accepted only one wording (2/4 arms pass). |

Flow content did not decide the model's choices in any of these ten flips. At every hinge, the flow lines in context were scan file and row counts, blank-header hints, built-in aggregate or limit counts, or the custom-Python "row/column mapping unknown" boilerplate. Each flip turned on one choice: a key, a denominator, a ranking metric, a header option, how to handle fill values, a spatial predicate, or whether to read the beach list. Each was made at or before the first compute call, from data both arms shared. The model visibly used flow content once, and only cosmetically: in legal-hard-23 the both arm copied "skip_lines=2" into `pd.read_csv(..., skiprows=2)`. Arms without that hint wrote the same filter that drops DC and PR. In the same trace, accurate flow counts ("input rows=[50,50]", "Limit retained=1/50") were present when the both arm should have noticed the missing jurisdictions, and it ignored them. Flow neither misled the model nor rescued it. One pattern is worth a rerun rather than a claim: environment-hard-20 splits exactly 2–2 on the flow knob, with nothing in the traces linking flow content to the choice. As for the stats-only arm, its failures do not look like things flow fixed. In five of the nine gains (astronomy-hard-10, environment-easy-3, environment-hard-9, legal-hard-17, wildfire-easy-3), stats was the only one of the four dataflow arms to fail, each time with a different error, and the none and flow arms avoided those errors without either knob's help. Two more gains are 2-of-4 chronic flippers in which the flow-only arm also fails (biomedical-hard-7, legal-easy-19), and one is judge noise (wildfire-hard-18). The stats arm's own statistics steered two of its failing routes: dropping the 9.99e+32 density rows, and the −538…538 coordinate bounds that triggered its point fallback. In astronomy-hard-10 the both arm saw the same statistics row and masked the values instead of dropping rows. The one repeated miss is environment-hard-9, where the stats arm skipped the beach list in both of its runs. Net: in this sample the stats-only arm had bad luck, and no trace attributes the 63.5% → 71.2% gap between stats and both to flow evidence.
