# Terra pilot: where the recorded accuracy lead comes from

The lead mainly reflects **input parsing, data coverage, calculation scope
and verification**. Saved versions and dependency retrieval are used, but
this pilot does not isolate their causal contribution to accuracy. Most
winning questions are related failures of a few shared calculations, rather
than independent demonstrations of superior state management.

This is a manual comparison of both saved traces for **all 14 questions with
different official outcomes** in the aligned Survey Q1–Q17 and Netflix
Q1–Q14 prefixes. No new solver runs, judge calls or models were used. Original
binary grades remain unchanged. The [machine-readable audit](terra-pilot-accuracy-audit-20261005.json)
contains paired outcomes, first divergences, counterfactuals, confidence and
offline verification results. Raw excerpts remain under
`/var/tmp/dataflow-terra-pilot-20261005/accuracy-audit`.

| Aligned prefix | Dataflow correct | DSGym correct | Net difference |
| --- | ---: | ---: | ---: |
| Survey, 17 questions | 14 | 10 | +4 |
| Netflix, 14 questions | 10 | 4 | +6 |
| Total | 24 | 14 | +10 |

There are **12 dataflow-only passes, two DSGym-only passes, 12 both-correct
questions and five both-wrong questions**. Every dataflow-only pass has
submitted computation in the baseline trace; this Terra result is not
explained by the earlier Luna pattern of many no-code nonanswers.

## The twelve recorded dataflow wins

| Questions | Primary observed mechanism | Interpretation |
| --- | --- | --- |
| Survey Q1 | Baseline observation exceeds context budget | Bounded observation handling, not better arithmetic |
| Survey Q13–Q15 | Literal `None` selections lost during CSV parsing | One preprocessing error reused across three questions |
| Netflix Q4, Q5, Q7 | U.S. search file omitted | Missing market directly affects coverage and later rankings |
| Netflix Q10–Q12 | Freshness measured on an earlier filtered table | Wrong denominator and downstream comparison sets |
| Netflix Q13 | Corrected tie-break is executed and checked | A concrete verification advantage in this trace |
| Survey Q5 | Judge derives comparisons from rounded reference ratios | Probable false negative for the baseline |

These are primary explanations assigned to outcome groups. Some causes
overlap: the missing U.S. market also affects later score calculations.
The table is not an additive causal decomposition or a full-prefix replay
with one error removed at a time.

**Survey Q13–Q15: the data is damaged at import.** DSGym starts with
`pd.read_csv(survey_path)`. Its default missing-value handling converts the
literal selection `None` to a missing value. Later notebook and hardware
calculations use `.notna()` and consequently report zero selections. The
model inspects the option columns, sees empty selected-value lists, and
accepts those zeros. The same raw DataFrame is reused for the subgroup
hardware question, so the error repeats.

Native Scan preserves literal text and treats empty cells as missing. A
local read of the same four raw columns reproduces the difference exactly:

| 2021 selection | DSGym's default reader | Literal-preserving reader / dataflow |
| --- | ---: | ---: |
| Men: notebook `None` | 0.00% | 27.34% |
| Women: notebook `None` | 0.00% | 28.45% |
| Men: hardware `None` | 0.00% | 49.33% |
| Women: hardware `None` | 0.00% | 57.91% |

This is a useful property of the current dataflow loader. Python can obtain
the same values with an explicit missing-value policy. It is not evidence
that operator versioning causes these three wins.

**Netflix Q4/Q5/Q7: a missing input affects later ranks.** The published
`multiTimeline.csv` has the header `Week,Netflix: (United States)`. DSGym's
Q1 loader explicitly excludes it alongside the catalogue, leaving 14 search
markets. Dataflow previews this file and maps it to United States, producing
15 markets.

Q4 then omits the largest credit gainer, United States with 488 additional
credits. The wrong joined market set carries into Q5 and Q7. Percentile
components use 14 markets rather than 15, and reported inflated/moving
markets differ. This is an input-coverage cascade, not confirmed corruption
of a historical snapshot or an incorrect rollback transport operation.

**Netflix Q10–Q12: the wrong table is reused.** The question asks to keep
the old scoring components while using the full parsed catalogue to measure
freshness. DSGym calculates freshness from `fractional_assignments`, a table
already restricted to the 2010–2019 scoring period. Dataflow connects the
freshness operator to the full title and country-detail tables, then joins
the measurement to the previous score.

For Egypt, the baseline computes fresh supply of 53.0403%, while the correct
full-catalogue calculation is 39.0244%. Q10 orders Thailand before Egypt;
the correct order starts with Egypt. The incorrect freshness table then
affects Q11's retained leaders and Q12's fixed comparison pool, where the
baseline substitutes Mexico for France. The baseline does retain named
three-year and four-year tables and restores the three-year version in Q12;
the problem is their semantics, not evidence that Python cannot keep versions.

**Netflix Q13: dataflow actually corrects its calculation.** Both agents
initially sort equal rank losses by market name, omitting the requested
uncertainty-penalty tie-break. Dataflow reads the computed result, updates
the operator to sort by rank loss, penalty and name, executes again, and
retrieves the corrected list containing South Korea.

DSGym mentions the penalty tie-break in its final reasoning but does not
execute that changed sort. It still reports France instead of South Korea.
Its printed uncertainty table already has the needed shares: South Korea
1.5737%, Turkey 1.3793%, France 1.2861%. This is a visible difference between
checking a corrected computation and describing a correction in prose.
Ordinary Python ReAct can perform the same corrective execution.

**Survey Q1: observation size blocks the baseline.** The first Python block
prints all column names and `head().to_string()` for a 293-column table.
The returned observation is 275,453 characters. Compaction cannot fit the
next request; the upstream loop records 39 local budget errors without
another provider call, then returns an empty answer and moves to Q2.
Dataflow's bounded retrieval succeeds and produces the requested five-row
summary. This is an observation/context-interface advantage in this trace.

**Survey Q5: the judge appears wrong.** Both computations use the correct
counts: 4,890 women and 20,598 men overall, and 606 women and 1,949 men in
USA. Unrounded calculations give a ratio multiple of 1.3097155 and a
percentage-point difference of 7.3526992. DSGym reports 1.31 and 7.35,
correctly rounded to two decimals.

The judge instead expects approximately 1.2917 and 7.0, obtained from the
already rounded reference ratios 0.31 and 0.24. That conflicts with the
instruction to derive quantities from unrounded values. Dataflow reports
the ratio difference rounded to 0.07 and omits the extra ratio multiple;
it passes. This recorded win should not be claimed as better computation.
The official zero remains preserved, with the inconsistency flagged separately.

## The two reverse outcomes

Survey Q4 shows that the native loader does not make selection correct by
itself. The cleaning operator replaces missing country values with an empty
string and then ranks that string as a country. Ten women in 2017 have no
country recorded. Including the blank country moves Nigeria from rank 45
to 46; excluding it reproduces the correct rank. DSGym handles this case
correctly.

Netflix Q14 is the previously documented context-loss failure. Successful
historical inspections disappear during compaction, and dataflow uses all
40 model calls before returning a limitation. DSGym uses its persistent
tables and answers correctly. Both reverse outcomes are included in the
ten-answer net difference.

## Corrections to the earlier comparison and implications

The earlier label “31 questions completed by both systems” was too strong.
Those are 31 aligned questions before the native budget stops, including
baseline Survey Q1's empty answer. There are **30 common successful final
submissions**, including the native Q14 limitation: dataflow 23 correct,
DSGym 14, at $2.45275 and $2.21903 respectively. The baseline's full run
has 38 recorded questions and 37 successful final submissions; full-prefix
official accuracy remains 19/38. No original verdict or cost is changed.

The generated budget counter also only recognizes the native error string,
so its baseline zero misses Q1. Three questions experience local budget
failure: one baseline and two native. The 39 baseline blocked steps are
not 39 paid API calls. All 345 sent solver requests retain known usage and
remain within the frozen cap; no provider error is found.

Two points of the recorded ten-answer lead should not be credited to better
numerical computation: the Q1 baseline budget failure and the Q5 judge issue.
The remaining evidence is encouraging, but strongly clustered around a few
shared preprocessing and scope decisions. Dataflow uses 66 provider calls
on its twelve winning questions versus the baseline's 44, so additional
inspection, execution and verification also accompany the lead.

This supports strengthening lossless loading, bounded observations,
separate complete working tables and answer selections, and verification
after a semantic change. A fair future comparison should give Python equally
robust input semantics and bounded observations, preserve official grades
alongside clearly labeled scoring anomalies, and isolate history/version
primitives in an ablation. No such experiment is run here, and no further
paid work or scaling is started.
