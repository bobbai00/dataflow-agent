# Flip report, group 2 (Luna): none→flow gains and stats→both losses

All 11 flips compare flow off with flow on. Runs live under `benchmark/retrieval/runs/20261009-luna-4arms/system_scratch/DataflowSystemLuna_20261009_luna_4arms_evidence_data{0,1}_flow{0,1}_Rep1/<task>`. Variant runs (both@100k, both@sample2k, both@basecaps, both@samplesPrompt) were read only where noted. Two mechanisms were checked against the data files: environment-easy-6 (exact `'Yes'` gives 0.8434%, casefold gives 5.1354%) and archeology-hard-7 (box 295, radius 274).

---

### Luna environment-hard-11 — none→flow GAIN — VARIANCE
The question asks for the mean 1-day rainfall before Pleasure Bay Beach samples exceeding 104 Enterococcus/100 mL. Gold: 0.37. Off arm answered: 0.40. On arm answered: 0.37.

**Gold plan:** read the datasheet (skip the title row; two header rows), melt the three sampling sites, and drop "Castle Island Playground". Keep the rows of both Pleasure Bay sites (Broadway and Flagpole) with Enterococcus > 104 (24 rows), then take the mean of `1-Day Rain` (0.372).

**Hinge:** in none call 4, `load_pleasure_bay` names the columns `pleasure_bay_tag, pleasure_bay_enterococcus, flagpole_tag, flagpole_enterococcus, …`. The predicate `failed_sample` tests only `row['pleasure_bay_enterococcus']`, which is the Broadway site. The result is 22 rows with mean 0.4041; the two Flagpole exceedances (508 and 157) are lost.

**Evidence at hinge:**
- none, call 3 observation (no knob): `| 1 | ,,,,Pleasure Bay @ Broadway,,Pleasure Bay @ Flagpole,,Castle Island Playground, |`. The arm saw both Pleasure Bay sites and wrote code for Broadway only.
- flow, call 1 observation, which is everything it had before its call-2 decision:
  `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=862 rows.`
  `- flow: Scan: 9 header cells of `pleasure_bay_and_castle_island_beach_datasheet.csv` are blank.`
  `| null | null | null | null | Pleasure Bay @ Broadway | null | Pleasure Bay @ Flagpole | null | Castle Island Playground | null |`
  Call 2 code: `for site, col in [('Broadway','broadway_enterococcus'),('Flagpole','flagpole_enterococcus')]`.

**Why:** both arms saw the same site header row. The flow arm decided to include Flagpole in call 2, when its only flow lines were a file/row count and a blank-header count; the useful filter flow lines (`kept=24/1185`) came after that decision. Two flow-on variants, both@100k and both@basecaps, saw the identical "9 header cells … are blank" line and the same sample row, and still coded Broadway only (both answered 0.40). Pass pattern: the both configuration passes 3 of 5, so this task is a chronic flipper.

---

### Luna environment-hard-20 — none→flow GAIN — VARIANCE
The question asks for the 3 most polluted 2015 beaches in the city with the least June–August rainfall. Gold: ['Bucks Creek', 'Pleasant Street', 'Forest Street']. Off arm answered: ['Bucks Creek', 'Pleasant Street', 'Schoolhouse Pond']. On arm answered: the gold list.

**Gold plan:** for each of the 4 cities, sum Jun+Jul+Aug 2015 rainfall; Chatham is the minimum (8.71). Take the 2015 testing rows for Community == Chatham. Per beach, exceedance rate = count(Violation == 'yes') / samples. The top 3 by rate are the answer.

**Hinge:** none call 3, `least_rainfall_beaches`, defines "most polluted" as mean Indicator Level: `sort_values(['MeanIndicator','MaxIndicator','Violations','Beach Name'], …)`. Schoolhouse Pond (mean 15.5, 0 violations) therefore beats Forest Street (1 violation in 13 samples).

**Evidence at hinge:**
- none: no flow lines. It chose the metric from the schema (`Indicator Level float64`, `Violation str`) and the sample rows.
- flow, call 3 observation before its ranking code: `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=15898 rows.` and `- flow (testing): see action 2 / testing.` Call 4 code: `sort_values(['Violations', 'Violation Rate', 'Max_Indicator', 'Beach Name'], …)`.

**Why:** this is an interpretation choice of metric (mean indicator level versus violations), and the only flow content on screen was a row count. The stats arm, which has flow off, also ranked by violations and passed. smolagents ranked by mean indicator, as the none arm did. Pass pattern: 7 of 8 dataflow runs pass, and the none arm is the lone outlier.

---

### Luna legal-hard-15 — none→flow GAIN — VARIANCE
The question asks for total 2024 identity-theft reports from cross-state metropolitan and micropolitan statistical areas. Gold: 243377. Off arm answered: 1281434. On arm answered: 243377.

**Gold plan:** read every State MSA Identity Theft CSV (skip 2 lines) and concatenate. A row is cross-state when the code after the comma contains "-". Drop duplicate rows, because each cross-state area is repeated in every member state's file. Sum the reports: 43 areas, 243,377.

**Hinge:** none call 5, `sum_statistical_area_reports`, keeps every row matching `(?:Metropolitan|Micropolitan) Statistical Area`. It applies no cross-state condition and no deduplication: 452 rows, 1,281,434. The call-4 reasoning had said "determine how cross-state statistical areas are labeled", but the call-5 code dropped that criterion.

**Evidence at hinge:**
- none, call 4 observation (no knob): `| Columbus, GA-AL Metropolitan Statistical Area | 1,302 |` and `| LaGrange, GA-AL Micropolitan Statistical Area | "453" |`. Call 5 reasoning: "retain rows labeled as Metropolitan or Micropolitan Statistical Areas, parse report counts, and compute the total."
- flow, before its call-5 filter: `- flow: load_identity_raw input rows=[], output=816; row/column mapping unknown.` Call 5 code: `str.contains(r',\s*[A-Z]{2}(?:-[A-Z]{2})+')`, which gives 94 rows and 593,524.
- flow, before its call-6 deduplication: `- flow: cross_state_reports input rows=[816], output=94; row/column mapping unknown.` and `- flow: "source_files" nonnull=94/94; … reducer=count_distinct.` The records showed `Alabama.csv | 6 | Columbus, GA-AL …` and `Georgia.csv | 9 | Columbus, GA-AL …`. Call 6 reasoning: "The same cross-state statistical area appears in multiple state files, so deduplicate area names."

**Why:** the none arm dropped a stated criterion while writing code. The flow arm kept it, and its deduplication came from duplicate area names it could read in the records listing. At both of its decisions the flow lines were "mapping unknown" boilerplate and aggregate denominators. Pass pattern: stats (flow off) passes, and the both configuration passes 3 of 5, so this is a chronic flipper.

---

### Luna legal-hard-17 — none→flow GAIN — VARIANCE
The question asks how many 2007 reports would be Auto Related under the 2024 category distribution. Gold: 32542. Off arm answered: 36597. On arm answered: 32542.

**Gold plan:** take the 2007 total (1,070,447) from Report_Count.csv and multiply it by the Auto Related `Percentage` cell (3.04%) in Report_Categories.csv (skiprows=2). Rounded, this is 32542.

**Hinge:** none call 3 computes `share = auto / total_categories`, where `total_categories = cat_rows[reports_col].sum()` = 5,762,587. That is the sum of the 29 listed categories, and it excludes the 7% coded "Other Misc." The given Percentage is based on 6,471,708 reports. The none share is 3.419%, giving 36597.

**Evidence at hinge:**
- none, call 2 `sample` view (5 rows, so no footnote visible): `| Rank | Category | " # of Reports " | Percentage |` and `| "1" | Credit Bureaus and Information Furnishers | 1,353,175 | 20.91% |`.
- flow, call 2: the `full` view was requested in the same call as the scan, so before any flow line about this file. Its observation contained:
  `- flow: Scan: 3 header cells of `2024_CSN_Report_Categories.csv` are blank; skip_lines=2 gives the header "Rank", "Category", " # of Reports ", "Percentage".`
  `| "7" | Auto Related | 197,015 | 3.04% |`
  `| Percentages are based on the total number of 2024 Sentinel reports (6,471,708).  7% of the total were coded "Other Misc." …`
  Call 3 code: `percentage_col = categories.columns[3]` … `/ 100`.

**Why:** both arms saw the Percentage header. The none arm chose to renormalize over the listed categories; the flow arm read the given percentage from the full table, and it had chosen the full view before any flow line about the file. The flow arm's code addressed columns by position and did not use the `skip_lines` hint. both@basecaps saw the same hint and still computed 197015/6471708, which gives 32587 (fail). Pass pattern: stats passes, and the both configuration passes 4 of 5.

---

### Luna legal-hard-29 — none→flow GAIN — VARIANCE (but the pass pattern lines up with the knob; see Why)
The question: among states with 5 or more metro areas, which single-state metro has the largest share of its own state's fraud reports? Cross-state areas count in the denominator. Gold: Atlanta-Sandy Springs-Roswell, GA Metropolitan Statistical Area. Off arm answered: San Juan-Bayamón-Caguas, PR Metropolitan Statistical Area. On arm answered: Atlanta.

**Gold plan:** read all State MSA Fraud files except PuertoRico (a territory) and DistrictofColumbia. Keep states with at least 5 area rows. Share = reports / state-file total, with cross-state rows included in the total. Take the top single-state area per state, then the overall maximum: Atlanta, 77.5%.

**Hinge:** none, call 5 code and call 6 answer. The code applies no state/territory restriction. The ranked table leads with PuertoRico's San Juan, and the arm answers it.

**Evidence at hinge:**
- none, call 5 observation (no knob):
  `| San Juan-Bayamón-Caguas, PR Metropolitan Statistical Area | PuertoRico | 9133 | 11424 | 5 | 79.9457282913165 |`
  `| Atlanta-Sandy Springs-Roswell, GA Metropolitan Statistical Area | Georgia | 167515 | 216056 | 13 | 77.5331395564113 |`
- flow, call 5 code: `abbrev = {…,'New Jersey':'NJ',…,'Puerto Rico':'PR',…}` maps file-derived names such as `State='PuertoRico'`. The eligibility test `Codes[0] == StateAbbr` is therefore NaN-false for 12 files: PuertoRico, DistrictofColumbia and 10 multi-word states such as NewJersey and NorthCarolina (I checked the file list). San Juan never enters the ranking, and none of the other dropped states beats Atlanta.
- flow lines on screen: `- flow: load_msa_reports input rows=[], output=452; row/column mapping unknown.` and `- flow: rank_single_state_metros input rows=[452], output=258; row/column mapping unknown.` The model never mentions Puerto Rico.

**Why:** in this pair the flow arm got the right answer because a dictionary key did not match, which silently dropped Puerto Rico. Its flow lines were boilerplate, and no knob content caught the error. The pass pattern, however, does not look like noise. Flow-off runs are 0 of 2 (both answered San Juan, as did smolagents); flow-on runs are 6 of 6. In three flow-on variants (both@100k, @sample2k, @basecaps) the model saw the same San Juan/PuertoRico top row as the off arms, with only `row/column mapping unknown` and `Limit retained=1/299` flow lines, and then explicitly re-checked: "confirm whether the apparent winner is a territory rather than a U.S. state". Any knob effect here would have to come from the prompt paragraph or general framing, not from a measured flow line. This flip is not clean evidence for such an effect, but the task deserves a repeated run.

---

### Luna archeology-hard-7 — stats→both LOSS — VARIANCE
The question asks how many modern cities over 100k population lie within 0.1 degrees of a Roman city. Gold: 274. Off arm (stats) answered: 274. On arm (both) answered: 295.

**Gold plan:** keep worldcities rows with population > 100000. Run a KD-tree ball query with radius 0.1 in Euclidean (lng, lat) degrees around the Roman cities, and count the modern rows with at least one match: 274.

**Hinge:** both call 3, `count_nearby_cities`, uses `(np.abs(dlat) <= 0.1) & (np.abs(dlon) <= 0.1)`. That is a 0.2°×0.2° box, not a 0.1° radius, and it gives 295 (the data check gives box 295, circle 274).

**Evidence at hinge:**
- both, before call 3: `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=1388 rows.` and `… output=44691 rows.`. After: `- flow: count_nearby_cities input rows=[1388,44691], output=1; row/column mapping unknown.`
- stats, call 3 (no flow): `np.any((dlat * dlat + dlon * dlon) <= threshold * threshold, axis=1)`, giving 274.

**Why:** the divergence is a method choice for "within 0.1 degrees", made with only scan counts on screen. 295 is the modal answer: none (no knobs), flow, both, both@sample2k, both@basecaps and smolagents all gave 295, and both@100k and both@samplesPrompt gave 292. The stats arm is the only pass among 8 dataflow runs, so its pass is the outlier, not the both arm's loss.

---

### Luna environment-easy-6 — stats→both LOSS — VARIANCE
The question asks for the mean yearly exceedance rate for marine beaches, 2002–2023, to 2 decimals. Gold: 5.14 (percent). Off arm (stats) answered: 5.14. On arm (both) answered: 0.84.

**Gold plan:** for each yearly file from 2002 to 2023, keep Marine rows and compute rate = count(Violation.lower() == 'yes') / rows. Average the 22 rates and report in percent: 5.14.

**Hinge:** both call 3, `marine_rate_summary`, sets `exceedance = (data['Violation'] == 'Yes')`. The match is case-sensitive and misses 'yes' (10,148 rows) and 'YES' (1,900 rows). The mean is 0.8434%; with casefold it is 5.1354%.

**Evidence at hinge:**
- both, call 2, statistics for the 2022 file only: `| Violation | str | 0 | 2 | all: No 15,276; Yes 810 |`. Flow lines: `- flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=16086 rows.` At the result: `- flow: marine_rate_summary input rows=[319911], output=1; row/column mapping unknown.`
- stats, call 4: after a type-union error forced an `all_text=True` scan of all 22 files, its statistics showed `| Violation | str | 0 | 7 | top: no 230,993; No 44,445; NO 29,673; yes 10,148; other: 4,652 (not exhaustive) |`. Its code: `.str.strip().str.casefold().eq('yes')`.

**Why:** the both arm profiled one representative year, whose statistics showed exactly "No"/"Yes", and hard-coded 'Yes'. The stats arm profiled the union and saw seven spellings. The content that misled was a statistics table, which both arms receive; the flow lines were scan counts and boilerplate. Pass pattern: only stats passes among dataflow runs. none and the other flow-on runs answered 0.05, which is the correct fraction in the wrong unit, so the stats pass is the outlier.

---

### Luna environment-hard-9 — stats→both LOSS — VARIANCE
The question asks which Boston Harbor beaches met the standard 100% of the time, 2020–2024. Gold: ['Pleasure Bay Beach', 'Castle Island Beach', 'City Point Beach']. Off arm (stats) answered: the gold list. On arm (both) answered: ['Pleasure Bay Beach', 'City Point Beach'].

**Gold plan:** read 8 datasheets, melt the sites, keep 2020–2024, and pass a beach if no Enterococcus value exceeds 104. The combined pleasure_bay_and_castle_island sheet yields both "Pleasure Bay Beach" and "Castle Island Beach", the names used in boston-harbor-beaches.txt.

**Hinge:** in both calls 4–5, the arm loaded only the 8 datasheets and never read the harbor list in full. `beach_compliance` labels the combined sheet `'Pleasure Bay Beach'`, so the answer omits Castle Island Beach.

**Evidence at hinge:**
- both: its only view of the list was the preview `| boston-harbor-beaches.txt | 0 | Constitution Beach |`, with `- flow: Scan preview only (not full source); files selected=1/1, omitted=0; output=1 rows.` The combined file's title is `Pleasure Bay Beach, South Boston: Bacterial Water Quality`. Result: `| Pleasure Bay Beach | 231 | 0 | 0 | true |`.
- stats, call 3: the harbor list loaded via sample_stats shows `| Castle Island Beach |`, `| Pleasure Bay Beach |`, `| City Point Beach |`. Its code named the sheet 'Pleasure Bay and Castle Island Beach', and the answer split it into the two listed names.

**Why:** what decided the naming was whether the agent read the harbor list in full; that was a route choice, made with only "preview only" flow lines on screen. Pass pattern: only stats passes. none (no knobs) and every flow-on run gave a two-beach answer; both@100k used the name "Pleasure Bay and Castle Island Beach".

---

### Luna legal-hard-1 — stats→both LOSS — VARIANCE (but the pass pattern lines up with the knob; see Why)
The question asks for the mean identity-theft reports over MSAs whose interpolated 2023 population exceeds 1M. Gold: 12964.8727. Off arm (stats) answered: 12964.8727. On arm (both) answered: 13778.1316.

**Gold plan:** from the HTML table "The 387 metropolitan statistical areas", compute 2023 = 2020 + 0.75 × (2024 − 2020). Normalize names (strip the suffix and non-alphanumerics). Read all State MSA Identity Theft CSVs and drop duplicate rows, since cross-state areas repeat once per state file. Inner-join, keep population > 1,000,000, and take the mean of reports over 55 areas.

**Hinge:** both call 5, `compute_identity_average`, runs `rep=pd.concat(frames)` and merges with no deduplication. Each cross-state metro counts once per member state, so the mean runs over 76 rows. Call 6 then answers, although its own row shows 76 rows against 55 areas.

**Evidence at hinge:**
- both, call 5: `| 452 | 76 | 13778.1315789474 | 1047138 | 55 |` (columns: matched_report_rows, matched_population_rows, average_reports, sum_reports, areas). Flow lines: `- flow: compute_identity_average input rows=[], output=1; row/column mapping unknown.` Call 6 reasoning: "matched 55 eligible metropolitan areas and returned an average of 13778.1315789474".
- stats, call 2, statistics note: `- note: full table: duplicate rows=359, all-null rows=156, …`. Call 4 code: `theft=pd.concat(frames,ignore_index=True).drop_duplicates('key')`, giving 55 rows and 12964.8727.

**Why:** the both arm skipped deduplication and misread its own 76-versus-55 diagnostic; the flow lines at the hinge were custom-Python boilerplate. It had loaded one representative CSV first and never saw the 359-duplicates note, but the none arm (no flow) also inspected one file first and still passed. Flow-off runs pass 2 of 2 and flow-on runs 1 of 6, but the five flow-on failures come from four different custom-Python mistakes:
- both: no deduplication (76 rows).
- both@sample2k: duplicate listings summed (19038.87).
- flow: the 6-row Puerto Rico table pulled into the population (56 areas, 12751.96).
- both@basecaps and both@samplesPrompt: name normalization matched only 24 areas (4358.58).

None of these traces shows a flow-line cause. The 1-of-6 versus 2-of-2 split is suggestive at this sample size but unexplained.

---

### Luna legal-hard-15 — stats→both LOSS — VARIANCE
The question asks for total 2024 identity-theft reports from cross-state statistical areas. Gold: 243377. Off arm (stats) answered: 243377. On arm (both) answered: 593524.

**Gold plan:** as in the gain section above: cross-state rows, deduplicated, summed; 43 areas, 243,377.

**Hinge:** in both calls 4–6, `classify_cross_state` keeps 94 cross-state rows with no deduplication. Call 6 answers 593524 although its aggregate shows `| 593524 | 94 | 43 |` (total_reports, area_rows, areas).

**Evidence at hinge:**
- both, call 5:
  `- flow: "areas" nonnull=94/94; per-group min=94, max=94; reducer=count_distinct.`
  `- flow: classify_cross_state input rows=[660], output=94; row/column mapping unknown.`
  `| area | str | 0 | 43 | top: Philadelphia-Camden-Wilmington, … 4; Washington-Arlington-Alexandria, … 4; Cincinnati, … 3; …`
  Answer reasoning: "The executed aggregate is complete and reports the requested cross-state Metropolitan/Micropolitan total."
- stats, call 5: a full listing sorted by area with adjacent duplicate pairs (`Allentown-Bethlehem-Easton, PA-NJ … | 2414` twice) and its own column `duplicate_area_rows = 51`. Call 6: "The matched rows repeat each cross-state area across source files, so deduplicate by area."

**Why:** both arms had the duplication in front of them. The both arm saw it only as counts (areas=43, top-value counts of 3–4) after retrieving a 5-row sample_stats view; the stats arm saw adjacent repeated rows. The one flow line on the count_distinct output reports a non-null denominator (94/94), not the distinct count, and nothing in the trace shows the model reading it as 94 areas. The flow arm saw the same kind of line (`"source_files" nonnull=94/94; … reducer=count_distinct`) and deduplicated anyway. both@sample2k failed the same way with even more explicit flow content on screen: `"reports_sum" … per-group min=2, max=4` for a per-area aggregate, and its own `distinct_areas = 43`. It answered "over all 94 qualifying … area rows". Pass pattern: the both configuration passes 3 of 5, so this is a chronic flipper.

---

### Luna legal-hard-2 — stats→both LOSS — VARIANCE
The question asks which MSA has the highest identity-theft reports per 100k (2023 interpolated population). Gold: Miami-Fort Lauderdale-West Palm Beach FL Metropolitan Statistical Area. Off arm (stats) answered: Miami. On arm (both) answered: Philadelphia-Camden-Wilmington, PA-NJ-DE-MD Metropolitan Statistical Area.

**Gold plan:** as legal-hard-1, but rate = reports / pop2023 × 100,000, with duplicate rows dropped; the argmax is Miami (869.5).

**Hinge:** in both calls 5–6, `theft.groupby(['key','csv_name'])['reports_num'].sum()` adds Philadelphia's four identical state-file listings (4 × 28,438 = 113,752), giving a rate of 1802.99. The arm answered with it.

**Evidence at hinge:**
- both, call 6: `| Philadelphia-Camden-Wilmington, … | Philadelphia–Camden–Wilmington, PA-NJ-DE-MD MSA | 113752 | 6245051 | 6330422 | 6309079.25 | 1802.98892267045 | 363 | 368 | 387 |`. Flow: `- flow: compute_identity_rate input rows=[], output=1; row/column mapping unknown.` In call 2 it had seen the same statistics note as the stats arm: `- note: full table: duplicate rows=359`.
- stats, call 4: `reports.drop_duplicates('key', keep='first')` with the comment "Identical metro entries across files represent repeated state-table listings; retain one report value per normalized metro". Result: Miami 869.49, and Philadelphia 450.75 with `report_listings 4`.

**Why:** summing repeated listings versus keeping one is a coding choice in custom Python, and the flow content at the hinge was boilerplate. The none arm (no flow) made the same sum, putting Philadelphia at 113752, then recovered with a dedicated check ("Verify whether repeated cross-state entries are duplicated records or distinct numeric entries"). Pass pattern: the both configuration passes 2 of 5. both@sample2k and both@basecaps used keep-first deduplication and passed; flow, both, both@100k and both@samplesPrompt summed.

---

## Summary

| task | direction | class | one-line reason |
|---|---|---|---|
| environment-hard-11 | none→flow GAIN | VARIANCE | Off arm coded Broadway only; the site choice came before any flow line, and two flow-on variants made the same Broadway-only error |
| environment-hard-20 | none→flow GAIN | VARIANCE | Off arm ranked "polluted" by mean Indicator Level instead of violations; the stats arm (flow off) also passed |
| legal-hard-15 | none→flow GAIN | VARIANCE | Off arm dropped the cross-state criterion; the on arm's filter and deduplication came from the records, with only "mapping unknown" flow lines |
| legal-hard-17 | none→flow GAIN | VARIANCE | Off arm renormalized over the listed categories instead of using the Percentage column; the failing both@basecaps saw the same header hint |
| legal-hard-29 | none→flow GAIN | VARIANCE (pass pattern lines up with knob) | On arm dropped Puerto Rico through a dict-key mismatch with only boilerplate flow lines, yet flow-on runs pass 6/6 and flow-off 0/2 |
| archeology-hard-7 | stats→both LOSS | VARIANCE | Box (\|dlat\|,\|dlon\| ≤ 0.1) instead of a radius; 295 is the modal answer, including none, so the stats pass is the outlier |
| environment-easy-6 | stats→both LOSS | VARIANCE | Case-sensitive `== 'Yes'` after a 2022-only statistics profile showed "No/Yes"; flow lines were scan counts |
| environment-hard-9 | stats→both LOSS | VARIANCE | Never read the full harbor list and labeled the combined sheet "Pleasure Bay Beach"; only the stats arm passes |
| legal-hard-1 | stats→both LOSS | VARIANCE (pass pattern lines up with knob) | No deduplication (76 rows against 55 areas); the 5 flow-on failures have 4 distinct custom-Python mechanisms |
| legal-hard-15 | stats→both LOSS | VARIANCE | No deduplication despite its own areas = 43 of 94 rows; the flow arm saw the same count_distinct line and deduplicated |
| legal-hard-2 | stats→both LOSS | VARIANCE | Summed Philadelphia's 4 repeated listings; the none arm made the same sum and recovered |

**What the flow content did to the model's decisions:** in these 11 flips, no flow line was the reason for a decision, right or wrong.

- **The flow lines at the hinges carried nothing useful.** In all 11 flips, the decision either sat inside a registered Python function or came before any substantive flow line. The flow lines on screen were scan file/row counts, "row/column mapping unknown", "equal row counts do not prove preservation", aggregate non-null denominators, or a blank-header/`skip_lines` hint.
- **The same flow content led to opposite outcomes,** which shows it did not decide them. The "9 header cells are blank" line appears in passing and failing environment-hard-11 runs. The "Percentage" header hint appears in passing and failing legal-hard-17 runs. The count_distinct "nonnull=94/94" line appears in passing and failing legal-hard-15 runs.
- **When flow content did expose the error, the model ignored it.** both@sample2k's `per-group min=2, max=4` shows every area is duplicated, and it still answered 593524.
- **The content that did move decisions was data the model read directly:** record listings with visible repeats, the harbor beach list, and statistics tables (the other knob). In environment-easy-6 a single-file statistics profile misled the both arm; in legal-hard-1 and legal-hard-2 the stats arm's deduplication came after a `duplicate rows=359` note.
- **Two tasks remain unexplained.** legal-hard-29 (flow-on 6/6 versus flow-off 0/2) and legal-hard-1 (flow-on 1/6 versus flow-off 2/2) split along the flow knob, and the traces do not explain why through measured flow lines. In legal-hard-29, three flow-on variants re-checked the Puerto Rico winner with only boilerplate flow lines visible, so any effect there would come from the prompt paragraph, not from the measurements. Both tasks are worth repeated runs before anyone claims a mechanism.
