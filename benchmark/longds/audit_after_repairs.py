# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Audit the frozen after-repairs prefixes with explicit, reviewable rubrics.

Usage: python audit_after_repairs.py --campaign path/to/campaign.json --output report.json
This never calls an LLM, executes agent code, or changes official judgments.
Rubrics are post-hoc diagnostics for these prefixes, not benchmark-wide metrics.
"""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import mean

from partial_score import MISSING, compare_scalars, compare_table


def pick(value, selector):
    if isinstance(selector, list):
        return next((found for s in selector if (found := pick(value, s)) is not MISSING), MISSING)
    if isinstance(selector, dict):
        if "difference" in selector:
            a, b = (pick(value, x) for x in selector["difference"])
            return a - b if a is not MISSING and b is not MISSING else MISSING
        if "negate" in selector:
            v = pick(value, selector["negate"])
            return -v if v is not MISSING else MISSING
        if "nonzero" in selector:
            v = pick(value, selector["nonzero"])
            return v != 0 if v is not MISSING else MISSING
        if "equals" in selector:
            v = pick(value, selector["equals"][0])
            return v == selector["equals"][1] if v is not MISSING else MISSING
        raise ValueError(f"Unknown selector: {selector}")
    if selector == "$":
        return value
    for name in selector.split("."):
        if not isinstance(value, dict) or name not in value:
            return MISSING
        value = value[name]
    return value


def aliases(*names):
    return list(names)


def table(reference, answer, keys, fields=None, *, ordered=False, extras=None):
    return {"kind": "table", "reference": reference, "answer": answer,
            "keys": keys, "fields": fields or {}, "ordered": ordered, "extras": extras or {}}


def scalar(reference, answer):
    return {"kind": "scalar", "reference": reference, "answer": answer}


PAIR = {"country": "country", "sector": "sector"}
PARTNER = {"partner_name": "partner", **PAIR}
UNIT = {"display_name": aliases("unit_label", "$")}
MARKET = {"country": "market"}


def restaurant(n):
    if n == 1:
        return [table("top_watch_units", "first_watch_list", UNIT,
                      {"pressure_signals": "pressure_signals"}, ordered=True)]
    if n == 2:
        return [table("highest_risk_overstatements", "risky_units", UNIT,
                      {"unsafe_signals": "pressure_signals"}, ordered=True)]
    if n == 3:
        groups = []
        for group in ["advance", "diagnose", "hold"]:
            groups += [scalar(f"decision_counts.{group}", aliases(f"{group}.size", f"group_sizes.{group}")),
                       table(f"leading_{group}", aliases(f"{group}.examples", f"examples.{group}"), UNIT,
                             {"primary_reason_first": "primary_reason_first"}, ordered=True)]
        return groups
    if n == 4:
        return [scalar("moved_unit_count", aliases("moved_unit_count", "moved_units")),
                table("largest_moves", aliases("largest_absolute_rating_shift_units", "largest_rating_shift_units"),
                      UNIT, {"rating_shift": "rating_shift"}, ordered=True)]
    if n == 5:
        return [table("weakest_forward_units", aliases("weak_high_value_customer_reach_units", "weak_reach_advance_units"), UNIT, ordered=True)]
    if n == 6:
        return [table("top_subsidy_risks", aliases("subsidy_risk_pool_report", "subsidy_risk_pool"), UNIT,
                      {"main_shortfall": "main_shortfall"}, ordered=True)]
    if n == 7:
        return [table("flipped_units", "changed_service_interpretation_units", UNIT, ordered=True)]
    if n == 8:
        return [table("service_screen_diagnostics", "service_screen_sensitivity_units", UNIT, ordered=True),
                scalar({"nonzero": "service_only_change_count"},
                       aliases("crossed_subsidy_risk_boundary_only_due_to_service_screen_change", "boundary_crossed_only_because_of_service"))]
    raise ValueError("No rubric for this Restaurant question")


def netflix(n):
    if n == 1:
        names = {"usable_titles": "retained_cleaned_title_count",
                 "titles_with_added_year": {"difference": ["retained_cleaned_title_count", "missing_parsed_date_added_count"]},
                 "titles_without_country": "missing_country_count",
                 "country_detail_rows": "country_detail_row_count", "genre_detail_rows": "category_detail_row_count",
                 "director_detail_rows": "director_detail_row_count", "cast_detail_rows": "cast_detail_row_count",
                 "search_interest_countries": "countries_with_search_interest_data",
                 "missing_rating_after_fix": "missing_rating_count", "missing_movie_duration": "missing_movie_duration_count"}
        return [scalar(k, v) for k, v in names.items()]
    if n == 2:
        return [table("top_markets", "$", MARKET,
                      {"opportunity_score": "score", "demand_gap_component": "demand_gap",
                       "delayed_supply_component": "delayed_supply", "adult_share_pct": "adult_maturity_fit",
                       "movie_share_pct": "movie_orientation", "genre_count": "genre_count"}, ordered=True)]
    if n == 3:
        return [table("dominant_components", "$", MARKET,
                      {"dominant_component": "dominant_component", "dominant_score_points": "contribution_score_points"})]
    if n == 4:
        return [table("entered_top_five", "enter_top_five", {"_value": "_value"}),
                table("left_top_five", "leave_top_five", {"_value": "_value"}),
                table("largest_credit_gains", "largest_title_credit_gains", MARKET, {"credit_gain": "title_credit_gain"}, ordered=True)]
    raise ValueError("No rubric for this Netflix question")


def kiva(n):
    # Only explicitly requested quantities enter the score. Wrong additional
    # scores reported by a passing answer are retained in the extra-value audit.
    if n == 1:
        return [table("top_pressure_pairs", "top_country_sector_pairs", PAIR,
                      {"early_pressure": "early_pressure", "loan_count": "loan_count", "completion_pct": "completion_pct",
                       "avg_wait_days": "avg_wait_days", "avg_term_months": "avg_term_months",
                       "borrower_reliance": "borrower_reliance", "named_region_pct": "named_region_share"}, ordered=True)]
    if n == 2:
        fields = {"early_pressure_old": "old_pressure", "pressure_score": "new_pressure", "completion_pct": "completion_pct",
                  "low_completion_pct": "low_completion_pct", "avg_wait_days": "avg_wait_days"}
        return [table("entered", "entering", PAIR, fields, ordered=True), table("left", "leaving", PAIR, fields, ordered=True)]
    if n == 3:
        return [scalar("stable_top10_set", "top_ten_stable"),
                table("temporary_only_pairs", "no_wait_only", PAIR, {"pressure_no_wait": "no_wait_pressure", "pressure_score_main": "current_pressure"}, ordered=True)]
    if n == 4:
        return [table("largest_positive_restored_gaps", "cases", PAIR, {"temporary_minus_main": "positive_difference"}, ordered=True)]
    if n == 5:
        return [table("highest_pressure_removed", "removed_pairs", PAIR, {"pressure_score": "standing_pressure", "named_region_pct": "named_region_share"}, ordered=True)]
    if n == 6:
        return [table("returning_pairs", "returning_pairs", PAIR, {"pressure_score": "looser_current_pressure", "named_region_pct": "pair_named_region_share"}, ordered=True)]
    if n == 7:
        return [table("top_social_pressure_pairs", "top_social_theme_priority", PAIR,
                      {"social_priority": "social_theme_priority", "pressure_score": "restored_pressure", "borrower_reliance": "borrower_reliance",
                       "social_theme_pct": "social_theme_share", "theme_mapped_pct": "mapped_coverage"}, ordered=True)]
    if n == 8:
        return [scalar("stable_top10_set", "top_ten_stable"), table("temporary_only_pairs", "check_only_pairs", PAIR,
                {"social_priority_half": "sensitivity_score", "social_priority_main": "current_social_priority"}, ordered=True)]
    if n == 9:
        return [table("largest_partner_reversals", "largest_partner_score_reversals", PARTNER,
                      {"partner_score_inclusive": "inclusive_partner_score", "partner_score_specialized": "specialized_partner_score", "score_reversal": "score_reversal"}, ordered=True)]
    if n == 10:
        return [table("top_matches", "top_specialized_actionable_matches", PARTNER,
                      {"absent_from_inclusive_top10": "not_in_inclusive_top10"}, ordered=True,
                      extras={"recommendation_score": "actionable_score", "social_priority": "social_priority", "partner_score_specialized": "specialized_partner_score"})]
    if n == 11:
        return [table("inclusive_replacements", "replacement_candidates", PARTNER, {"social_alignment_gap": "gap"}, ordered=True,
                      extras={"recommendation_score_inclusive": "inclusive_recommendation_score", "social_priority": "social_priority"})]
    if n == 12:
        return [table("lost_high_social_pairs", "lost_pairs", PAIR, {"social_priority": "social_theme_priority"}, ordered=True,
                      extras={"pressure_score": "restored_pressure", "social_theme_pct": "social_theme_share", "borrower_reliance": "borrower_reliance"})]
    if n == 13:
        return [table("largest_risers", "improved_rows", PAIR,
                      {"social_rank": "social_rank", "poverty_rank": "poverty_rank", "rise_in_rank": "rise_in_rank",
                       "mpi_mean": "mpi_mean", "high_mpi_region_pct": "high_mpi_region_share"}, ordered=True,
                      extras={"poverty_priority": "poverty_priority"})]
    if n == 14:
        return [scalar("stable_leading_group", "leading_group_stable"),
                table("median_favored_pairs", "priority_gains", PAIR, {"median_minus_mean_priority": "priority_gain"}, ordered=True,
                      extras={"poverty_priority": "mean_based_priority", "poverty_priority_median_cf": "median_based_priority"})]
    if n == 15:
        return [table("largest_restored_drops", "positive_drops", PAIR, {"median_minus_mean": "median_minus_mean"}, ordered=True,
                      extras={"poverty_priority": "mean_based_priority", "poverty_priority_median_cf": "median_based_priority"})]
    if n == 16:
        return [table("largest_downgrades", "downgraded_pairs", PAIR,
                      {"priority_downgrade": {"negate": "downgrade"}, "gdp_per_capita": "gdp_per_capita", "agriculture_gva_pct": "agriculture_share",
                       "unemployment_pct": "unemployment", "water_rural_pct": "rural_water_access", "sanitation_pct": "rural_sanitation_access"}, ordered=True,
                      extras={"poverty_priority": "mpi_only_priority", "expanded_priority": "expanded_priority"})]
    if n == 17:
        return [table("stronger_under_poverty_only", "pairs", PAIR, {"rollback_gap": "rollback_gap"}, ordered=True,
                      extras={"poverty_priority": "poverty_priority", "expanded_priority": "expanded_priority"})]
    if n == 18:
        return [table("top_current_matches", "top_matches", PARTNER,
                      {"partner_hhi": "amount_share_hhi", "top_partner_share": "top_partner_share", "cell_partner_count": "partner_count"}, ordered=True,
                      extras={"final_score": "final_score"})]
    if n == 19:
        fields = {"final_score": "final_score", "final_score_double_penalty": "final_score_double_penalty"}
        return [table("falling_out", "falling_out_matches", PARTNER, fields, ordered=True), table("entering", "replacements", PARTNER, fields, ordered=True)]
    if n == 20:
        return [table("restored_under_main_screen", "restoration_cases", PARTNER, {"restore_case_score": "restore_case_score"}, ordered=True)]
    if n == 21:
        return [scalar("top5_changed", "five_match_set_changes"), table("sensitive_matches", "displaced_matches", PARTNER,
                                                                     extras={"final_score": "current_final_score"})]
    if n == 22:
        return [table("fragile_under_stress_checks", "excluded_by_either", PARTNER,
                      {"excluded_by_both": "excluded_by_both", "concentration_penalty": "concentration_penalty", "borrower_reliance": "borrower_reliance"})]
    if n == 23:
        fields = {k: {"equals": ["missing_data_source", k]} for k in ["missing_mpi", "missing_development_profile", "insufficient_mpi_regions"]}
        return [table("lost_strong_matches", "lost_recommendations", PARTNER, fields, ordered=True, extras={"final_score": "final_score"})]
    if n == 24:
        return [table("relaxed_only_recommendations", "relaxed_only_recommendations", PARTNER,
                      {"in_region_tight_population": "belongs_to_stricter_regional_detail_population",
                       "has_complete_development_profile": "development_inputs_complete", "has_sufficient_mpi_regions": "has_at_least_ten_valid_mpi_regions",
                       "missing_evidence_reason": "missing_evidence_reason"}, ordered=True, extras={"final_score": "final_score"})]
    if n == 25:
        return [table("top_under_poverty_stage_lens", "matches", PARTNER, {"current_minus_poverty_stage": {"negate": "older_minus_current_score"}}, ordered=True,
                      extras={"poverty_stage_match_score": "older_poverty_stage_score", "final_score": "current_final_score"})]
    if n == 26:
        return [table("top_under_social_stage_lens", "matches", PARTNER, {"outside_current_top10": "outside_current_top10"}, ordered=True,
                      extras={"final_score": "current_final_score"})]
    raise ValueError("No rubric for this Kiva question")


def apply_groups(reference, answer, groups, decimals):
    if not isinstance(answer, (dict, list)):
        raise ValueError("Unsupported table shape or scalar answer; canonicalize prose explicitly before scoring")
    results = []
    for spec in groups:
        if spec["kind"] == "scalar":
            wanted, got = pick(reference, spec["reference"]), pick(answer, spec["answer"])
            if wanted is MISSING:
                raise ValueError(f"Invalid reference selector {spec}")
            results.append({"rubric": spec, **compare_scalars({"value": wanted}, {} if got is MISSING else {"value": got}, decimals)})
            continue
        wanted, got = pick(reference, spec["reference"]), pick(answer, spec["answer"])
        if not isinstance(wanted, list) or (got is not MISSING and not isinstance(got, list)):
            raise ValueError(f"Unsupported table shape: {spec}")
        columns = {**spec["keys"], **spec["fields"], **spec["extras"]}

        def normalize(rows, prediction):
            out = []
            for row in rows:
                if not isinstance(row, dict):
                    row = {"_value": row, "unit_label": row}
                mapped = {k: value for k, selector in columns.items()
                          if (value := pick(row, selector if prediction else k)) is not MISSING}
                if mapped.get("main_shortfall") == "customer_coverage":
                    mapped["main_shortfall"] = "customer_gap"
                out.append(mapped)
            return out

        result = compare_table(normalize(wanted, False), None if got is MISSING else normalize(got, True),
                               list(spec["keys"]), list(spec["fields"]), ordered=spec["ordered"], decimals=decimals,
                               extra_fields=list(spec["extras"]))
        results.append({"rubric": spec, **result})
    return {"partial_score": mean(r["partial_score"] for r in results),
            "exact_requested_contract": all(r["exact"] for r in results), "groups": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.campaign.read_text())
    cases = []
    for job in manifest["jobs"]:
        task = job["task"]
        fn = restaurant if "restaurants" in task else netflix if "netflix" in task else kiva if "kiva" in task else None
        if fn is None:
            raise ValueError(f"No reviewed rubric for {task}")
        source = Path(job["run_dir"]) / "results_eval.json"
        for row in json.loads(source.read_text()):
            answer = json.loads(row["solution"])
            case = apply_groups(row["ground_truth"], answer, fn(row["turn_id"]), None)
            cases.append({"arm": job["arm"], "task": task, "turn_id": row["turn_id"],
                          "question": row["question"], "official_score": row["judge"]["score"],
                          "source": str(source), "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                          "question_sha256": hashlib.sha256((row["context"] + "\n" + row["question"]).encode()).hexdigest(), **case})
    summary = []
    for arm in dict.fromkeys(r["arm"] for r in cases):
        subset = [r for r in cases if r["arm"] == arm]
        summary.append({"arm": arm, "questions": len(subset), "official_correct": sum(r["official_score"] for r in subset),
                        "partial_score": mean(r["partial_score"] for r in subset),
                        "exact_requested_contract": sum(r["exact_requested_contract"] for r in subset)})
    report = {"rubric_version": 1,
              "interpretation": "Post-hoc diagnostic only. Equal-weight mean of answer groups; each table averages identity F1, requested-value accuracy (including missing rows), and requested order where relevant. Extra entities penalize precision. Extra reported numeric values are audited separately. No LLM calls. Original scores unchanged.",
              "limitations": ["Rubrics were written after inspecting these answers; do not treat the score as a new benchmark result.",
                              "Only these after-repairs native prefixes are supported. Saved DSGym prose is not scored by this JSON adapter.",
                              "Kiva1's explanatory-components contract is ambiguous; raw reference fields are used here and correct alternative score components are checked separately.",
                              "Numeric values must match exactly using Decimal comparison; trailing zeros are insignificant. Aliases, sign conversions and count complements are explicit in each group. Identity aliases and rank tie handling are limited to these reviewed answers.",
                              "A passing requested answer does not certify intermediate state. Wrong extra reported scores are retained separately."],
              "summary": summary, "cases": cases}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
