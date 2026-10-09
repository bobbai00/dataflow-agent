# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Offline diagnostics are independent of the official benchmark judge."""
import unittest
from decimal import Decimal
from benchmark.retrieval.answer_diagnostics import diagnose_answer, rounded_equal

def snapshot(value=13.162794202898551, version="v1"):
    return {"results": {"ratio": {"state": "Completed", "result": [{"ratio": value}],
        "resultVersion": {"id": version}}}}
def reads(version="v1"):
    return [{"toolResults": [{"output": {"actions": [{"action": {"type": "retrieve"},
        "output": {"results": [{"operator_id": "ratio", "status": "ok", "result_version": version,
            "text": "| ratio |\n|13.162794202898551|"}]}}]}}]}]

class AnswerDiagnosticsTests(unittest.TestCase):
    def test_exact_format_is_independent_of_numeric_support(self):
        prompt = "Put **Final Answer: <value>** on the last line."
        result = diagnose_answer(prompt, "**Final Answer: 13.1628**", reads(), snapshot())
        self.assertTrue(result["format_compliant"])
        self.assertEqual(result["numeric_support"]["status"], "observed_result_match")
        self.assertEqual(result["numeric_support"]["matches"][0]["operator_id"], "ratio")
        self.assertFalse(diagnose_answer(prompt, "Final Answer: 13.1628", reads(), snapshot())["format_compliant"])

    def test_mental_calculation_and_stale_results_are_not_claimed_grounded(self):
        result = diagnose_answer("", "**Final Answer: 13.1628**", reads(), snapshot(86250))
        self.assertEqual(result["numeric_support"]["status"], "not_found_in_observed_results")
        result = diagnose_answer("", "**Final Answer: 13.1628**", reads("old"), snapshot())
        self.assertEqual(result["numeric_support"]["status"], "not_found_in_observed_results")

    def test_text_and_missing_format_contract_remain_unknown(self):
        result = diagnose_answer("", "**Final Answer: Sao Paulo**", reads(), snapshot())
        self.assertIsNone(result["format_compliant"])
        self.assertEqual(result["numeric_support"]["status"], "not_numeric_scalar")
        self.assertEqual(diagnose_answer("", "60", [], {})["numeric_support"]["status"], "not_found_in_observed_results")

    def test_bool_unread_and_failed_cells_are_not_numeric_evidence(self):
        for state, value, trace in [("Completed", True, reads()), ("Failed", 1, reads()), ("Completed", 1, [])]:
            data = snapshot(value)
            data["results"]["ratio"]["state"] = state
            result = diagnose_answer("", "**Final Answer: 1**", trace, data)
            self.assertEqual(result["numeric_support"]["matches"], [])


    def test_api_snapshot_samples_and_display_rounding_keep_numeric_support(self):
        data = snapshot()
        data["results"]["ratio"]["sampleRecords"] = data["results"]["ratio"].pop("result")
        trace = reads()
        trace[0]["toolResults"][0]["output"]["actions"][0]["output"]["results"][0]["text"] = "| ratio |\n|---|\n| 13.1627942028986 |"
        self.assertEqual(diagnose_answer("", "**Final Answer: 13.1628**", trace, data)["numeric_support"]["status"], "observed_result_match")

    def test_earlier_views_of_the_same_result_remain_observed(self):
        trace = reads()
        later = reads()
        later[0]["toolResults"][0]["output"]["actions"][0]["output"]["results"][0]["text"] = "| other |\n|---|\n| 7 |"
        self.assertEqual(diagnose_answer("", "13.1628", trace + later, snapshot())["numeric_support"]["status"], "observed_result_match")

    def test_numeric_headers_are_not_observed_record_values(self):
        for text in ("| 60 |\n|---|\n| 7 |", "60\tother\n7\tvalue"):
            trace = reads()
            trace[0]["toolResults"][0]["output"]["actions"][0]["output"]["results"][0]["text"] = text
            self.assertEqual(diagnose_answer("", "60", trace, snapshot(60))["numeric_support"]["status"], "not_found_in_observed_results")

    def test_json_quoted_numeric_strings_in_record_cells_are_visible(self):
        trace = reads()
        read = trace[0]["toolResults"][0]["output"]["actions"][0]["output"]["results"][0]
        read["text"] = '| ratio |\n|---|\n| "60" |'
        self.assertEqual(diagnose_answer("", "60", trace, snapshot("60"))["numeric_support"]["status"], "observed_result_match")
        read["text"] = '| ratio |\n|---|\n| "Age 60" |'
        self.assertEqual(diagnose_answer("", "60", trace, snapshot("60"))["numeric_support"]["status"], "not_found_in_observed_results")

    def test_decimal_extremes_are_bounded_and_do_not_invent_integer_matches(self):
        self.assertFalse(rounded_equal(Decimal("1e100"), Decimal("1.0")))
        self.assertFalse(rounded_equal(Decimal("1e999999999"), Decimal("1.0")))
        self.assertFalse(rounded_equal(Decimal("1e-999999999"), Decimal("0.0")))
        self.assertFalse(rounded_equal(Decimal("12345678900"), Decimal("1e10")))
        self.assertFalse(rounded_equal(Decimal("60.2"), Decimal("60")))
        self.assertTrue(rounded_equal(Decimal("1e999999999"), Decimal("1e999999999")))
        self.assertTrue(rounded_equal(Decimal("13.162794202898551"), Decimal("13.1628")))
