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
import math

import pytest
from comparison_budget import estimate_full_input, calibrate, audit_requests


def test_full_input_counts_unicode_frames_and_tools():
    request = {"messages": [{"role": "system", "content": "Rules 😊\n"}],
               "tools": [{"function": {"description": "long tools"}}]}
    # Frozen against JSON.stringify(...).length in the matching Bun test.
    assert estimate_full_input(request) == 33
    assert estimate_full_input(request, 2) == 66
    assert estimate_full_input({"messages": []}) < 33
    assert estimate_full_input({**request, "max_tokens": 8192}) == 33


def test_calibration_uses_no_scores_and_rejects_missing_usage():
    rows = [{"arm": "history", "estimate": 100, "actual": 90},
            {"arm": "dsgym", "estimate": 100, "actual": 70}]
    result = calibrate(rows)
    assert math.isclose(result["scale"], .945)
    assert result["observed_calls"] == 2
    assert result["margin"] == .05
    with pytest.raises(ValueError):
        calibrate([])
    with pytest.raises(ValueError):
        calibrate([{**rows[0], "actual": None}])


def test_audit_keeps_unknown_and_actual_and_estimated_violations_separate():
    rows = [{"estimate": 63000, "actual": 65000},
            {"estimate": 66000, "actual": 60000},
            {"estimate": 100, "actual": None}]
    report = audit_requests(rows, 64000)
    assert report["calls"] == 3
    assert report["unknown_usage"] == 1
    assert report["actual_over_budget"] == 1
    assert report["estimated_over_budget"] == 1
    assert report["maximum_actual"] == 65000
