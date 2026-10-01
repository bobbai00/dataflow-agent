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

import json

import pandas as pd
import pytest

from core.util.table_profile import ProfileAccumulator, ProfileLimits, PROFILE_PREFIX


def collect(*frames, limits=None, complete=True):
    profile = ProfileAccumulator(
        "worker-0", {"operatorId": "source", "operatorRevision": "0123456789abcdef"}, limits=limits
    )
    for frame in frames:
        profile.add(frame)
    if complete:
        profile.finish()
    return profile, profile.snapshot()


def scalar(kind, value):
    return {"type": kind, "value": value}


def test_typed_counts_values_ranges_and_zero_denominators():
    _, result = collect(
        pd.DataFrame(
            {
                "id": pd.Series([9007199254740993, None, 9007199254740993], dtype="Int64"),
                "name": pd.Series(["a", "b", None], dtype="string"),
                "nothing": pd.Series([None] * 3, dtype="Float64"),
            }
        )
    )
    assert result["version"] == 1 and result["protocol"] == "texera.table-profile"
    assert result["coverage"] == {"scope": "worker", "complete": True, "rowsProcessed": 3, "yields": 1}
    ids = result["columns"]["id"]
    assert ids["nullCount"] == 1 and ids["nonnullCount"] == 2 and ids["distinctCount"] == 1
    assert ids["min"] == ids["max"] == scalar("int64", "9007199254740993")
    assert ids["frequencies"] == {
        "values": [{"value": scalar("int64", "9007199254740993"), "count": 2}],
        "otherCount": 0,
        "truncated": False,
    }
    assert ids["nullRatio"] == pytest.approx(1 / 3) and ids["uniquenessRatio"] == 0.5
    assert result["columns"]["nothing"]["uniquenessRatio"] is None
    assert result["columns"]["nothing"]["distinctCount"] == 0
    assert result["structure"]["allNullColumns"] == ["nothing"]


def test_empty_input_keeps_schema_and_undefined_ratios():
    _, result = collect(pd.DataFrame({"x": pd.Series(dtype="Int64"), "flag": pd.Series(dtype="boolean")}))
    assert result["rowCount"] == 0 and result["columnCount"] == 2
    assert [c["type"] for c in result["schema"]] == ["int64", "bool"]
    assert result["coverage"]["complete"]
    assert result["columns"]["x"]["nullRatio"] is None
    assert result["structure"]["allNullColumns"] == []


def test_multiple_yields_accumulate_distinct_values_and_cross_chunk_duplicates():
    frame = pd.DataFrame({"x": pd.Series([1, 2, None], dtype="Int64")})
    profile, partial = collect(frame, complete=False)
    assert not partial["coverage"]["complete"]
    profile.add(pd.DataFrame({"x": pd.Series([2, 3, None], dtype="Int64")}))
    profile.finish()
    result = profile.snapshot()
    assert result["rowCount"] == 6 and result["coverage"]["yields"] == 2
    assert result["columns"]["x"]["distinctCount"] == 3
    assert result["columns"]["x"]["nullCount"] == 2
    assert result["structure"]["duplicateRows"] == 2
    assert result["structure"]["allNullRows"] == 2


def test_frequency_top_k_keeps_other_count_and_explicit_truncation():
    _, result = collect(pd.DataFrame({"x": ["a", "b", "b", "c", "c", "c"]}), limits=ProfileLimits(top_k=2))
    freq = result["columns"]["x"]["frequencies"]
    assert freq["values"] == [{"value": scalar("str", "c"), "count": 3}, {"value": scalar("str", "b"), "count": 2}]
    assert freq["otherCount"] == 1 and freq["truncated"]
    assert result["columns"]["x"]["distinctCount"] == 3


def test_distinct_overflow_is_unknown_not_sum_or_an_invented_exact_top_list():
    _, result = collect(pd.DataFrame({"x": [1, 2, 3, 1]}), limits=ProfileLimits(distinct_limit=2))
    col = result["columns"]["x"]
    assert col["distinctCount"] is None and col["frequencies"] is None
    assert col["uniquenessRatio"] is None
    assert col["min"] == scalar("int64", "1") and col["max"] == scalar("int64", "3")
    assert "distinct_limit" in col["omissions"]


def test_row_limit_is_partial_even_after_successful_completion():
    _, result = collect(pd.DataFrame({"x": list(range(12))}), limits=ProfileLimits(max_rows=4))
    assert result["rowCount"] == 12 and result["coverage"]["rowsProcessed"] == 4
    assert not result["coverage"]["complete"]
    assert "row_budget" in result["omissions"]
    assert result["columns"]["x"]["nonnullCount"] == 4


def test_column_and_cell_caps_are_reported_without_fabricated_structure():
    _, result = collect(
        pd.DataFrame({"a": [None] * 4, "b": [None] * 4, "c": [1] * 4}), limits=ProfileLimits(max_columns=2, max_cells=4)
    )
    assert result["columnCount"] == 3 and len(result["columns"]) == 2
    assert result["coverage"]["rowsProcessed"] == 2
    assert result["structure"]["allNullRows"] is None
    assert result["structure"]["duplicateRows"] is None
    assert "column_budget" in result["omissions"] and "cell_budget" in result["omissions"]


def test_schema_change_invalidates_metrics_instead_of_overwriting_earlier_yield():
    _, result = collect(pd.DataFrame({"x": [1]}), pd.DataFrame({"y": [2]}))
    assert result["rowCount"] == 2 and not result["coverage"]["complete"]
    assert result["status"] == "unavailable" and "schema_changed" in result["omissions"]
    assert result["columns"] == {}


def test_long_values_are_not_truncated_into_false_distinctness():
    _, result = collect(pd.DataFrame({"x": ["prefix-a", "prefix-b"]}), limits=ProfileLimits(max_value_chars=6))
    assert result["columns"]["x"]["distinctCount"] is None
    assert result["columns"]["x"]["frequencies"] is None
    assert "value_budget" in result["columns"]["x"]["omissions"]


def test_timestamp_range_boolean_values_and_literal_null_string():
    _, result = collect(
        pd.DataFrame(
            {
                "when": pd.to_datetime(["2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"]),
                "flag": pd.Series([True, None], dtype="boolean"),
                "text": ["NULL", "NA"],
            }
        )
    )
    assert result["columns"]["when"]["min"]["value"].startswith("2026-01-01")
    assert result["columns"]["flag"]["frequencies"]["values"][0]["value"] == scalar("bool", True)
    assert result["columns"]["text"]["nullCount"] == 0


def test_metadata_identity_and_serialized_bytes_are_bounded():
    profile, result = collect(
        pd.DataFrame({f"column{i}": ["x" * 100, "y" * 100] for i in range(50)}),
        limits=ProfileLimits(max_payload_bytes=4000),
    )
    payload = profile.encode()
    decoded = json.loads(payload)
    assert len(payload.encode()) <= 4000 and decoded["cost"]["payloadBytes"] == len(payload.encode())
    assert decoded["operatorId"] == "source" and decoded["operatorRevision"] == "0123456789abcdef"
    assert profile.key.startswith(PROFILE_PREFIX)
    assert "payload_budget" in decoded["omissions"]
    assert len(decoded["producerId"]) == 32


def test_payload_budget_preserves_small_frequencies_and_exact_counts():
    frame = pd.DataFrame({f"value{i}": [f"value-{j:03d}" for j in range(100)] for i in range(12)})
    frame["eligible"] = ["Yes"] * 80 + ["No"] * 20
    profile, original = collect(frame, limits=ProfileLimits(max_payload_bytes=12000, max_seconds=10))
    payload = profile.encode()
    result = json.loads(payload)
    assert len(payload.encode()) <= 12000
    assert result["cost"]["payloadBytes"] == len(payload.encode())
    assert "payload_budget" in result["omissions"]
    assert result["columns"]["eligible"] == original["columns"]["eligible"]
    assert result["columns"]["eligible"]["frequencies"]["otherCount"] == 0
    assert any(c["mergeValues"] is None for c in result["columns"].values())
    for name, column in result["columns"].items():
        for field in ["nullCount", "nonnullCount", "distinctCount", "rowsProcessed", "min", "max"]:
            assert column[field] == original["columns"][name][field]
    assert profile.snapshot() == original


def test_collection_time_budget_stops_optional_work_not_execution():
    # The collector checks its clock before each bounded row block.
    ticks = iter([0.0, 1.0, 1.0, 1.0])
    profile = ProfileAccumulator("w", {}, limits=ProfileLimits(max_seconds=0.1), clock=lambda: next(ticks, 1.0))
    profile.add(pd.DataFrame({"a": [1, 2], "b": [3, 4]}))
    profile.finish()
    result = profile.snapshot()
    assert not result["coverage"]["complete"] and "time_budget" in result["omissions"]


def test_snapshot_cannot_mutate_later_profile_or_clear_completion():
    profile, result = collect(pd.DataFrame({"x": [1]}))
    result["columns"]["x"]["nullCount"] = 999
    assert profile.snapshot()["columns"]["x"]["nullCount"] == 0
    with pytest.raises(RuntimeError, match="finished"):
        profile.add(pd.DataFrame({"x": [2]}))


def test_unsupported_cells_and_profiler_failures_remain_metadata_only():
    _, result = collect(pd.DataFrame({"nested": [[1], [2]]}))
    assert result["columns"]["nested"]["distinctCount"] is None
    assert "unsupported_type" in result["columns"]["nested"]["omissions"]


def test_schema_inference_obeys_row_and_column_limits(monkeypatch):
    original = pd.api.types.infer_dtype
    seen = []

    def bounded(values, **kwargs):
        seen.append(len(values))
        return original(values, **kwargs)

    monkeypatch.setattr(pd.api.types, "infer_dtype", bounded)
    frame = pd.DataFrame({f"c{i}": ["x"] * 1000 for i in range(20)})
    _, result = collect(frame, limits=ProfileLimits(max_rows=4, max_columns=2))
    assert len(seen) <= 2 and max(seen, default=0) <= 4
    assert result["columnCount"] == 20 and not result["schemaComplete"]
    assert len(result["schema"]) == 2


def test_all_null_object_yield_can_acquire_a_known_type_without_losing_nulls():
    _, result = collect(pd.DataFrame({"x": [None]}), pd.DataFrame({"x": ["hello"]}))
    assert result["status"] == "available" and result["coverage"]["complete"]
    assert result["columns"]["x"]["nullCount"] == 1
    assert result["columns"]["x"]["distinctCount"] == 1
    assert result["schema"][0]["type"] == "str"


def test_nonfinite_values_do_not_leave_a_misleading_full_range():
    _, result = collect(pd.DataFrame({"x": [1.0, float("inf"), 2.0]}))
    assert result["columns"]["x"]["min"] is None
    assert result["columns"]["x"]["max"] is None
    assert "nonfinite_value" in result["columns"]["x"]["omissions"]


def test_values_after_inference_prefix_are_validated_without_coercion():
    # The bounded schema probe sees integers, but must not truncate 1.5 to 1.
    _, result = collect(pd.DataFrame({"x": pd.Series([1] * 128 + [1.5], dtype=object)}))
    assert result["columns"]["x"]["distinctCount"] is None
    assert result["columns"]["x"]["min"] is None
    assert "unsupported_type" in result["columns"]["x"]["omissions"]


def test_negative_and_positive_zero_are_one_value():
    # Two tasks showed "-0.0" and "0.0" as two distinct values; pandas counts one.
    _, result = collect(pd.DataFrame({"x": pd.Series([-0.0, 0.0, 1.5], dtype="float64")}))
    assert result["columns"]["x"]["distinctCount"] == 2
