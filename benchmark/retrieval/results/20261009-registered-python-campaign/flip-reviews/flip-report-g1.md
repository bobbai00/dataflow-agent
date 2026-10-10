# Flip report g1: Luna, none→flow, 8 losses

All 8 flips share the same shape: Luna, knob = flow, off arm = none (pass), on arm = flow (fail). The flow arm's system prompt differs only by one added paragraph: "Flow statistics describe measured built-in effects, ... Across a custom Python boundary, row/column correspondence to the requested output remains unknown. ... Return diagnostics as columns when needed; absent or bounded evidence is not exhaustive." No flow-arm failure was a budget failure: the runs took 3–7 model calls and 21–59 s.

Call numbers follow the dump_trace.py rendering. `[cN]` marks the call whose code or observation a quoted line comes from. "Other runs" means the other Luna runs of the same task in pass_pattern: stats, both, both@100k, both@sample2k, both@basecaps, both@samplesPrompt.

---

### Luna archeology-easy-11 — none→flow LOSS — VARIANCE
Question: what is the mean latitude of capital cities, taking only the most populous capital where a country has several (4 dp)? Gold: 17.4274. Off arm answered: 17.4274. On arm answered: 17.7924.

Gold plan: read worldcities.csv; keep `capital == "primary"`; within each `country`, keep the row with the largest `population`; take the mean `lat`.

Hinge: flow arm, call 4. `capitals = table.loc[table['capital'].notna()]` treats every non-null capital tier (primary, admin, minor) as a capital, drops rows with null population, and keeps the most populous row per country. That selects 227 countries from 10,850 rows. Checked against the data, the selection holds 196 primary, 30 admin and 1 minor city. The none arm (call 3) used `table['capital'].eq('primary')` and deduplicated on iso3, giving 237 capitals for 237 countries.

Evidence at hinge:
flow arm:
```
[c3] - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=44691 rows.
[c3] | Tokyo | 35.6897 | Japan | primary | 37732000 |
[c3] | Delhi | 28.61 | India | admin | 32226000 |
[c4] capitals = table.loc[table['capital'].notna()].copy()
[c4] | 17.7923960352423 | 227 | 10850 |
[c4] - flow: capital_latitude_summary input rows=[44691], output=1; row/column mapping unknown.
```
none arm:
```
[c2] | Tokyo | Tokyo | 35.6897 | 139.6922 | Japan | JP | JPN | Tōkyō | primary | 37732000 | 1392685764 |
[c2] | Delhi | Delhi | 28.61 | 77.23 | India | IN | IND | Delhi | admin | 32226000 | 1356872604 |
[c3] result = table.loc[table['capital'].eq('primary')].copy()
[c3] | 17.4274160337553 | 237 | 237 |
```
Why: Both arms saw the same sample, which shows `primary` and `admin` values side by side. One read "capital" as any non-null tier and the other as `primary` only. The only flow lines in context were a scan row count and custom-Python boilerplate, and neither says anything about the capital column. The flow arm's own diagnostic column (10,850 "capital" rows for 227 countries) went unremarked. The stats arm (flow off) made the same `capital.notna()` choice even though its statistics showed "all: minor 7,263; admin 3,625; primary 250", and pass_pattern is 5 passes and 4 failures across 9 runs, so this task is a chronic flipper.

---

### Luna astronomy-hard-9 — none→flow LOSS — VARIANCE
Question: which lag from 0 to 48 h maximizes r² between the TLE semi-major-axis change for SATCAT 43180 and the hourly OMNI2 ap index in May 2024? Gold: 24. Off arm answered: 24. On arm answered: 21.

Gold plan: read OMNI2 2024 as fixed-width, with ap = word 50. Compute the TLE semi-major axis from mean motion with mu = 398600.4418. Restrict to the May window, take the change between successive TLEs, round epochs to the hour and average per hour. For each lag, shift ap forward by that lag and correlate it with the change; answer with the lag of maximum r².

Hinge: flow arm, call 4. `ap=float(p[38])` carries the comment "AP is documented field 39 (0-based 38)". In the OMNI2 spec, word 39 is Kp and ap is word 50. The observation for that same call 4 included the spec line "50 I4 999 ap-index nT", but the arm answered 21 in call 5 without acting on it. Rerunning the arm's own `compute_lags` with `p[49]` gives lag 24 (r² 0.770), so the field index is the whole error. The none arm also guessed wrong at first (`p[33]`) and corrected itself from the same spec line.

Evidence at hinge:
flow arm:
```
[c3] records: full; 82 of 329 rows, 2 of 2 columns (retained records, not a random sample; cut at 5,000 characters)
[c4] # OMNI hourly record: whitespace fields; AP is documented field 39 (0-based 38), fill 999.
[c4] | 50       I4   999      ap-index                     nT |
[c4] - flow: compute_lags input rows=[], output=49; row/column mapping unknown.
[c4] | 21 | 0.250733438390594 | 122 | -0.500732901246357 |
[c5] "The complete lag scan shows the maximum r-squared at lag 21 hours."
```
none arm:
```
[c3] # OMNI fixed-width-ish whitespace records; AP is field 34 in standard OMNI2 layout.  ...  ap=float(p[33])
[c3] | 166 | 50       I4   999      ap-index                     nT |
[c3] | 41 | 0.111831675235671 | 114 | -0.334412432836566 |
[c4] "The specification identifies AP as word 50, so correct the parser to use the 50th whitespace field and recompute the lag ranking."  ...  ap=float(p[49])
[c4] | 24 | 0.770254716257022 | 121 | -0.877641564795687 |
```
Why: Both arms read the spec into the same 5,000-character cap, which ends before the format table, so both guessed the ap column from memory. Both then had "50 I4 999 ap-index nT" in context. The none arm acted on it; the flow arm accepted its Kp-based table. The flow lines at the hinge are the custom-Python boilerplate and say nothing about field positions. Only 2 of the 8 dataflow runs pass, and the six failing runs gave lags 21, 34, 44, 31, 32 and 31.

---

### Luna biomedical-hard-5 — none→flow LOSS — VARIANCE
Question: what is the median number of variants per Mbp for the serous tumor samples (4 dp)? Gold: 2.6563. Off arm answered: 2.6563. On arm answered: 2.4241.

Gold plan: from the mmc1 metadata table, keep `Case_excluded == 'No'` and histology Endometrioid or Serous, and take the serous `idx` values. Look those idx up in the mmc7 sheet "B-APM subtypes" and take the median of `2**Log2_variant_per_Mbp`.

Hinge: flow arm, call 4, set up by call 2, which loaded only the mmc1 sheet. `table.loc[table['Histologic_type'].eq('Serous'), ...]` uses mmc1's own `Log2_variant_per_Mbp`, with no `Case_excluded` filter and no join to mmc7. That yields 13 samples, including S043 (Case_excluded = Yes, absent from mmc7, 1.4954 variants/Mbp), and the median falls to 2.4241. The none arm (call 3) inner-joined mmc1 histology to mmc7 "B-APM subtypes" on idx, which drops S043 implicitly and leaves 12 samples. Neither arm filtered `Case_excluded`.

Evidence at hinge:
flow arm:
```
[c2] - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=153 rows.
[c4] result = table.loc[table['Histologic_type'].eq('Serous'), ['idx', 'Histologic_type', 'Log2_variant_per_Mbp']].copy()
[c5] - flow: serous_variant_rates input rows=[153], output=13; row/column mapping unknown.
[c5] - flow: Aggregate groups=1 from 13 rows; group size min=13, max=13.
[c5] | S043 | Serous | 1.49535603700468 |
[c5] | 2.42414860748811 | 13 |
```
none arm:
```
[c3] merged = left.merge(right, on='idx', how='inner', validate='one_to_one')      # right = mmc7 'B-APM subtypes'
[c3] | 12 | 2.65634674940648 | 2.0835913313901 | 4.18885448834352 |
```
Why: In call 1 both arms saw the same sheet listing, including "B-APM subtypes" with `Log2_variant_per_Mbp`. The flow arm used the metadata sheet's copy of the rate instead; the none arm's join to mmc7 reproduced the gold's population without ever filtering on exclusion. The flow lines report row counts (153 → 13) and carry no information about excluded cases. The stats arm (flow off) returned the identical 2.4241, and only 4 of the 8 dataflow runs pass, so this task is a chronic flipper.

---

### Luna environment-hard-13 — none→flow LOSS — VARIANCE
Question: on how many 2024 days at Constitution Beach did one sampling point meet the standard (< 104 Enterococcus) while another did not? Gold: 11. Off arm answered: 11. On arm answered: 12.

Gold plan: reshape the two-header-row CSV into one row per date and location and keep 2024 dates. For each date, count locations with Enterococcus > 104, then count the dates with 1 or 2 such exceedances.

Hinge: flow arm, call 5. `meets = points.lt(threshold)` followed by `has_not = (~meets).any(axis=1)` counts a missing reading as "does not meet". May 22, 2024 has North 10, Middle 10 and South NaN, so it counts as mixed and the total becomes 12. The none arm wrote the same expression in call 2 and also got 12. Its own diagnostic column `classified_rows` (83 of 84 rows fully measured) exposed the missing reading, and in call 4 it added a `valid = points.notna()` mask, which gave 11.

Evidence at hinge:
flow arm:
```
[c5] meets = points.lt(threshold)  ...  has_not = (~meets).any(axis=1)
[c5] - flow: mixed_standard_summary input rows=[1880], output=1; row/column mapping unknown.
[c5] | mixed_days | rows_in_year | days_in_year | rows_with_mixed_status |
[c5] | 12 | 84 | 84 | 12 |
[c5] - flow: mixed_standard_summary: row/column mapping unknown; equal row counts do not prove preservation.
```
none arm:
```
[c2] mixed = meets.any(axis=1) & (~meets).any(axis=1)  ...  'classified_rows': int((points.notna().sum(axis=1) == 3).sum())
[c3] | 12 | 84 | 83 |
[c4] "Ensure missing measurements are not treated as failing the standard, then recompute the mixed-day count."
[c4] | 11 |
```
Why: Both arms first wrote the same bug that treats NaN as failing. What separated them was the diagnostic column each chose to return: the none arm's counted fully measured rows and exposed the gap, while the flow arm's did not. Every flow line on this computation is custom-Python boilerplate. both@basecaps (flow on) failed with the identical `meets.any(axis=1) & (~meets).any(axis=1)` code, while both, both@100k, both@sample2k and both@samplesPrompt passed; 6 of the 8 dataflow runs pass.

---

### Luna legal-easy-26 — none→flow LOSS — VARIANCE
Question: which states had "Identity Theft" as their top report category? Gold: Arizona, California, Massachusetts, Ohio, Oklahoma, Rhode Island. Off arm answered: those six states. On arm answered: all 50 states (f1 0.214).

Gold plan: read the state top-ten CSV, skipping the title rows. Within each state, sort by `# of Reports` descending and keep the state if its first category is Identity Theft.

Hinge: flow arm, call 2. `result[result['Category'].eq('Identity Theft')][['State']].drop_duplicates()` keeps every state that has Identity Theft anywhere in its top ten, which drops the "top" condition. That returned 52 jurisdictions; in call 3 the arm removed DC and Puerto Rico and answered with 50 states. The none arm (call 2) took the first listed category per state with `rows.drop_duplicates('state', keep='first')`.

Evidence at hinge:
flow arm:
```
[c1] - flow: Scan: 3 header cells of `2024_CSN_State_Top_Ten_Report_Categories.csv` are blank; skip_lines=2 gives the header "State", "Category", "# of Reports", "Percentage".
[c2] "The scan treated the report title rows as headers, so reload it with the data header after the two title rows and select exact Identity Theft category rows."
[c2] return pd.read_csv(path, skiprows=2)  ...  result = result[result['Category'].eq('Identity Theft')][['State']].drop_duplicates()
[c2] - flow: identity_theft_states input rows=[524], output=52; row/column mapping unknown.
[c3] "The complete checked result contains all 50 states plus District of Columbia and Puerto Rico; return only the 50 U.S. states requested."
```
none arm (no hint; it parsed the raw `Unnamed` columns):
```
[c2] "Parse the repeated state sections, take each state's first category row, retain states whose first category is Identity Theft"
[c2] first = rows.drop_duplicates('state', keep='first')
```
Why: The header hint was correct, and it did set the route: the flow arm reloaded with `skiprows=2`. The error, though, is in the selection logic written in the same call, and it does not depend on that route. both@100k saw the same hint, reloaded with the identical `pd.read_csv(path, skiprows=2)`, kept the "top" condition with `groupby('State', sort=False, as_index=False).first()`, and passed. both@sample2k never reloaded, made the same "any row" filter (52 states), and then corrected itself ("Correct the population to each jurisdiction's first listed category") with only boilerplate flow lines in view. This is the only failure among the 9 runs, so it is not a chronic flipper. KNOB-ROUTE would fit a literal reading, since the hint changed the load step, but the same route passed elsewhere and the same misreading happened without it.

---

### Luna legal-hard-1 — none→flow LOSS — VARIANCE
Question: what is the mean number of identity-theft reports across metro areas with 2023 population above 1M, where 2023 population is interpolated from the 2020 census and the 2024 estimate, names are normalized, and unmatched areas are dropped? Gold: 12964.8727. Off arm answered: 12964.8727. On arm answered: 12751.9643.

Gold plan: concatenate the per-state MSA CSVs and drop duplicate rows. Take the HTML table "The 387 metropolitan statistical areas of the United States" and set 2023 = 2020 + 3/4 × (2024 − 2020). Normalize names (lowercase, strip the MSA suffix, remove non-alphanumerics), inner-join, keep pop2023 > 1M, and take the mean of `# of Reports`.

Hinge: flow arm, call 3. `load_population` concatenates every HTML table that has both "2024 estimate" and "2020 census" columns, which also pulls in the Puerto Rico MSA table: the output has 393 rows, and its sample already shows "Guayama, PR MSA". In call 5 the >1M set therefore includes "San Juan–Bayamón–Caguas, PR MSA" (pop2023 2,046,929; 1,042 reports), for 56 areas. Removing San Juan from the arm's own numbers gives (714,110 − 1,042) / 55 = 12,964.8727, exactly the gold. The none arm used only `table_id == 1` from its first computation (call 7), where duplicate cross-state rows gave 76 rows and 13778.13; it de-duplicated them in call 8, leaving 55 areas.

Evidence at hinge:
flow arm:
```
[c2] | 2 | 1 | "1 \| San Juan–Bayamón–Caguas, PR MSA \| 2,035,484 \| 2,081,265 \| −2.20% \| San Juan–Bayamón, PR Combined Statistical Area" |
[c3] - flow: load_population input rows=[], output=393; row/column mapping unknown.
[c3] | Guayama, PR MSA | 68442 | 64546 |
[c5] - flow: match_eligible input rows=[393,608], output=56; row/column mapping unknown.
[c5] | San Juan–Bayamón–Caguas, PR MSA | 2081265 | 2035484 | 2046929.25 | 1042 |
[c5] | 12751.9642857143 | 56 | 714110 |
```
none arm:
```
[c7] p=pop.loc[pop['table_id'].eq(1), ['Metropolitan statistical area','2024 estimate','2020 census']].copy()
[c7] | 13778.1315789474 | 76 | 412 | 452 | 40 |
[c8] m=t.merge(p[['key','area','population_2023']], on='key', how='inner').drop_duplicates('key')
[c8] | 12964.8727272727 | 55 | 363 | 452 | 89 |
```
Why: Whether Puerto Rico MSAs belong in the population is a table-selection choice made inside a custom loader, where the only flow lines are the "row/column mapping unknown" boilerplate. The flow arm actually avoided the none arm's first error (duplicate cross-state rows) by deduplicating on key from the start. pass_pattern does lean against flow-on runs: 5 of 6 fail, against 0 of 2 flow-off runs. Those five failures give four different wrong answers (12751.96, 13778.13, 19038.87, and 4358.58 twice), so no single knob-induced error explains them.

---

### Luna legal-hard-2 — none→flow LOSS — VARIANCE
Question: which metro area has the highest identity-theft rate per 100,000, using interpolated 2023 population and normalized names? Gold: Miami-Fort Lauderdale-West Palm Beach FL Metropolitan Statistical Area. Off arm answered: Miami-Fort Lauderdale-West Palm Beach, FL Metropolitan Statistical Area. On arm answered: Philadelphia-Camden-Wilmington, PA-NJ-DE-MD Metropolitan Statistical Area.

Gold plan: same sources as legal-hard-1. Drop duplicate report rows, inner-join on the normalized key, compute rate = reports / pop2023 × 100,000, and take the argmax.

Hinge: flow arm, call 6. `i.groupby('key', as_index=False).agg(report_msa=('report_msa','first'), reports=('reports','sum'))` adds up the identical rows that a multi-state MSA repeats in each of its state files. Philadelphia appears in 4 state files, so it gets 113,752 = 4 × 28,438 reports and a rate of 1,803 per 100k, ahead of Miami's 869. The arm answered from that table. The none arm wrote the same sum in call 6, to fix a `validate='one_to_one'` MergeError, and got the same table with Philadelphia first. In call 7 it checked the repeats, found them identical, and in call 8 replaced the sum with de-duplication, which gave Miami.

Evidence at hinge:
flow arm:
```
[c6] i = i.groupby('key', as_index=False).agg(report_msa=('report_msa','first'), reports=('reports','sum'))
[c6] - flow: rank_identity_rates input rows=[423,816], output=20; row/column mapping unknown.
[c6] | Philadelphia-Camden-Wilmington, PA-NJ-DE-MD Metropolitan Statistical Area | 113752 | 6309079.25 | 1802.98892267045 | 1 |
[c6] | Washington-Arlington-Alexandria, DC-VA-MD-WV Metropolitan Statistical Area | 78756 | 6397002.25 | 1231.1391636606 | 1 |
[c6] | Miami-Fort Lauderdale-West Palm Beach, FL Metropolitan Statistical Area | 55457 | 6378074.25 | 869.49442459062 | 1 |
[c7] "The ranked, matched results are complete and show the highest computed identity-theft rate for Philadelphia-Camden-Wilmington, PA-NJ-DE-MD."
```
none arm:
```
[c5] error CALLBACK_RUNTIME: MergeError: Merge keys are not unique in left dataset; not a one-to-one merge
[c6] fraud = fraud.groupby('key', as_index=False).agg(fraud_msa=('fraud_msa','first'), reports=('reports','sum'))   -> Philadelphia 113752 first
[c7] "Verify whether repeated cross-state entries are duplicated records or distinct numeric entries before accepting the highest-rate result."
[c7] | CHICAGO NAPERVILLE ELGIN IL IN | Chicago-Naperville-Elgin, IL-IN Metropolitan Statistical Area | 37486 | Illinois.csv |   (same 37486 in Indiana.csv)
[c8] "The state files repeat multi-state MSAs identically, so replace summation with de-duplication of identical area/report rows and recompute the true highest rate."
```
Why: Both arms wrote the same per-key sum. The none arm reached it while fixing a MergeError that had already made the duplicates visible, and then spent a call verifying them; the flow arm summed from the start and never checked. No flow line mentions duplicates, because the aggregation runs inside Python. Across runs, every Philadelphia answer comes from a run that summed per key (flow, both, both@100k, both@samplesPrompt), and every Miami answer from a run that de-duplicated (stats, both@sample2k, both@basecaps) or verified (none). The task splits 2 passes and 3 failures across the near-identical "both" runs, so it is a chronic flipper. Philadelphia appears only in flow-on runs (4 of 6, against 0 of 2 flow-off), and the traces do not explain that association.

---

### Luna wildfire-hard-5 — none→flow LOSS — VARIANCE
Question: on average, how many more annual fires does NOAA report than NIFC since 2000 (to the nearest whole number)? Gold: −1039. Off arm answered: −1039. On arm answered: −3049.

Gold plan: read the NOAA monthly CSV (skip 3 lines) and sum fires by year. Read the tab-separated NIFC file and strip the commas from its counts. Inner-join on Year (2000–2024), take the mean of NOAA − NIFC, and round.

Hinge: flow arm, call 4, committed in call 6. The arm averaged each source separately with `aggregate(... mean ...)`, then combined the two one-row results with `join(noaa_avg, nifc_avg, how='cross')` and returned `NOAA_average - NIFC_average`. NOAA's 26 years include a partial 2025 (3 months, 16,080 fires) while NIFC has 25 years, which gives −3048.85. On the 25 matched years the same data give −1038.64. The none arm used `join(noaa_annual, nifc_annual, on='Year', how='inner', validate='one_to_one')` and averaged the yearly differences.

Evidence at hinge:
flow arm (at the decision, the only flow content was `[c3] - flow: Scan parsed selected sources; files selected=1/1, omitted=0; output=42 rows.` plus scan-preview lines; after execution in call 6):
```
[c4] "... aggregate NOAA monthly counts by year, and compare post-2000 averages."  ...  set comparison: join(noaa_avg, nifc_avg, how='cross')
[c6] - flow: Aggregate groups=26 from 303 rows; group size min=3, max=12.
[c6] - flow: Filter kept=26/26, rejected=0, null predicates=0 (a None verdict drops the row).
[c6] - flow: Filter kept=25/42, rejected=17, null predicates=0 (a None verdict drops the row).
[c6] | 66335.3461538462 | 26 | 69384.2 | 25 | -3048.85384615384 |
```
none arm:
```
[c4] set matched: join(noaa_annual, nifc_annual, on='Year', how='inner', validate='one_to_one')
[c7] | 25 | -1038.64 |
```
Why: The method choice, a difference of two separately averaged series instead of a mean of matched-year differences, was made before any relevant flow content existed. After execution the flow lines were correct and pointed straight at the problem: one year has only 3 months, and the two filters kept 26 years against 25. The arm answered anyway. The stats arm used the same built-in filter and aggregate route without the flow paragraph but joined on Year, as did all the other runs, so the route is not the cause. This is the only failure in pass_pattern.

---

## Summary

| task | direction | class | one-line reason |
|---|---|---|---|
| archeology-easy-11 | LOSS | VARIANCE | `capital.notna()` counted admin and minor cities as capitals; the stats arm (flow off) made the same choice |
| astronomy-hard-9 | LOSS | VARIANCE | parsed Kp (word 39) as ap and ignored the "50 ... ap-index" spec line in its own observation; the none arm made a similar guess and corrected it |
| biomedical-hard-5 | LOSS | VARIANCE | used mmc1's own rate with no Case_excluded filter, so excluded S043 entered; the stats arm gave the same 2.4241 |
| environment-hard-13 | LOSS | VARIANCE | counted a NaN reading as failing; the none arm wrote the same bug and caught it with its own diagnostic column |
| legal-easy-26 | LOSS | VARIANCE | dropped "top" (Identity Theft anywhere in the top ten); the header hint changed only the load, and the same route passed in both@100k |
| legal-hard-1 | LOSS | VARIANCE | concatenated the Puerto Rico MSA table; adding San Juan accounts exactly for 12751.96 vs 12964.87 |
| legal-hard-2 | LOSS | VARIANCE | summed cross-state duplicate rows (Philadelphia 4×); the none arm wrote the same sum but verified it |
| wildfire-hard-5 | LOSS | VARIANCE | subtracted separate means over 26 vs 25 years (partial 2025); flow lines flagged it afterwards and were ignored |

Across these 8 losses, no flow line prompted a wrong decision, and none of the failures came from budget. Seven of the eight hinges sit inside custom Python functions (a loader, a selection, a groupby), where the flow arm sees only "input rows=[N], output=M; row/column mapping unknown". The eighth (wildfire-hard-5) is a graph-design choice made before any relevant flow line existed. The knob's content changed what the model did exactly once: in legal-easy-26 the scan header hint made the agent reload the CSV with `skiprows=2`, which was correct and unrelated to the error that followed. Once, in wildfire-hard-5, the flow lines described the error exactly after the fact ("group size min=3, max=12"; "Filter kept=26/26" against "kept=25/42"), and the model answered anyway. So the knob neither caused these failures nor caught them. The failing decisions are semantic misreadings: capital tier, ap column, which table holds the cohort's rate, NaN handling, "top", table scope, duplicate rows and year alignment. The same model makes them with flow off: the stats arm repeats the archeology and biomedical errors, and the none arm itself first made the environment and legal-hard-2 errors, plus a similar wrong-column guess on astronomy, before its own diagnostic columns or verification calls caught them. Two asymmetries deserve more reps, because the traces neither explain nor rule out a knob effect. legal-hard-2 answers Philadelphia (by summing) only in flow-on runs (4 of 6, against 0 of 2 flow-off). legal-hard-1 fails in 5 of 6 flow-on runs against 0 of 2 flow-off, but with four different wrong answers.
