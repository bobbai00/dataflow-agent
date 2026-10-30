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


def test_multiple_yields_accumulate_distinct_values_and_all_null_rows():
    frame = pd.DataFrame({"x": pd.Series([1, 2, None], dtype="Int64")})
    profile, partial = collect(frame, complete=False)
    assert not partial["coverage"]["complete"]
    profile.add(pd.DataFrame({"x": pd.Series([2, 3, None], dtype="Int64")}))
    profile.finish()
    result = profile.snapshot()
    assert result["rowCount"] == 6 and result["coverage"]["yields"] == 2
    assert result["columns"]["x"]["distinctCount"] == 3
    assert result["columns"]["x"]["nullCount"] == 2
    assert result["structure"]["allNullRows"] == 2


def test_frequency_top_k_keeps_other_count_and_explicit_truncation():
    _, result = collect(pd.DataFrame({"x": ["a", "b", "b", "c", "c", "c"]}), limits=ProfileLimits(top_k=2))
    freq = result["columns"]["x"]["frequencies"]
    assert freq["values"] == [{"value": scalar("str", "c"), "count": 3}, {"value": scalar("str", "b"), "count": 2}]
    assert freq["otherCount"] == 1 and freq["truncated"]
    assert result["columns"]["x"]["distinctCount"] == 3


def test_column_cap_is_reported_without_fabricated_structure():
    _, result = collect(
        pd.DataFrame({"a": [None] * 4, "b": [None] * 4, "c": [1] * 4}), limits=ProfileLimits(max_columns=2)
    )
    assert result["columnCount"] == 3 and len(result["columns"]) == 2
    assert result["coverage"]["rowsProcessed"] == 4
    assert result["structure"]["allNullRows"] is None
    assert result["structure"]["duplicateRows"] is None
    assert "column_budget" in result["omissions"]


def test_schema_change_invalidates_metrics_instead_of_overwriting_earlier_yield():
    _, result = collect(pd.DataFrame({"x": [1]}), pd.DataFrame({"y": [2]}))
    assert result["rowCount"] == 2 and not result["coverage"]["complete"]
    assert result["status"] == "unavailable" and "schema_changed" in result["omissions"]
    assert result["columns"] == {}


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
    profile, original = collect(frame, limits=ProfileLimits(max_payload_bytes=12000))
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


@pytest.mark.parametrize("kind", ["Cast", "Join", "Filter"])
def test_optional_witnesses_cannot_displace_native_counters(kind):
    witness = {"values": [scalar("str", "x" * 96)], "count": 1, "truncated": False}
    operations = (
        {
            "conversionFailures": {"value": 3},
            "conversionFailureExamples": {"value": {"examples": [witness] * 3, "otherCount": 0}},
        }
        if kind == "Cast"
        else {
            "join": {
                "matchedOutputRows": 0,
                "left": {"unmatchedRows": 3, "unmatchedExamples": [witness] * 3, "duplicateExamples": []},
            }
        }
    )
    if kind == "Filter":
        operations = {
            "keptRows": 3, "rejectedRows": 3, "nullPredicates": 1,
            "filterRejectedValues": {"rejectedRows": 3, "columnsObserved": 1,
                                     "columns": {"value": {"examples": [witness] * 3, "otherCount": 0}}},
        }
    metadata = {
        "operatorId": "value",
        "operatorRevision": "0123456789abcdef",
        "operatorType": kind,
        "inputOperators": ["input"],
        "inputRows": [3],
        "outputRows": 3,
        "operations": operations,
    }
    profile = ProfileAccumulator("worker-0", metadata)
    profile.add(pd.DataFrame({"value": [None, None, None]}))
    profile.finish()
    original = profile.snapshot()
    baseline = json.loads(json.dumps(original))
    native = baseline["native"]["operations"]
    native.pop("conversionFailureExamples", None)
    native.pop("filterRejectedValues", None)
    for side in native.get("join", {}).values():
        if isinstance(side, dict):
            side.pop("unmatchedExamples", None)
            side.pop("duplicateExamples", None)
    profile.limits = ProfileLimits(max_payload_bytes=len(json.dumps(baseline, separators=(",", ":")).encode()) + 64)
    payload = profile.encode()
    result = json.loads(payload)
    assert len(payload.encode()) <= profile.limits.max_payload_bytes
    assert result["native"]["operations"] == baseline["native"]["operations"]
    assert "native_witness_payload_budget" in result["omissions"]
    assert result["columns"] == original["columns"]
    assert profile.snapshot() == original


def test_profile_snapshot_timing_excludes_accumulation_and_serialization():
    ticks = iter([0.0, 0.03, 1.0, 1.02])
    profile = ProfileAccumulator("w", {}, clock=lambda: next(ticks, 2.0))
    profile.add(pd.DataFrame({"x": [1]}))
    profile.finish()
    before = profile.snapshot()
    payload = profile.encode()
    result = json.loads(payload)
    assert result["cost"]["collectionMs"] == 30.0
    assert result["cost"]["snapshotMs"] == 20.0
    assert "snapshotMs" not in before["cost"]
    assert profile.snapshot() == before
    assert result["cost"]["payloadBytes"] == len(payload.encode("utf-8"))


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


def test_schema_inference_obeys_the_column_limit(monkeypatch):
    original = pd.api.types.infer_dtype
    seen = []

    def counted(values, **kwargs):
        seen.append(len(values))
        return original(values, **kwargs)

    monkeypatch.setattr(pd.api.types, "infer_dtype", counted)
    frame = pd.DataFrame({f"c{i}": ["x"] * 1000 for i in range(20)})
    _, result = collect(frame, limits=ProfileLimits(max_columns=2))
    assert len(seen) <= 2
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


def test_negative_and_positive_zero_are_one_value():
    # Two tasks showed "-0.0" and "0.0" as two distinct values; pandas counts one.
    _, result = collect(pd.DataFrame({"x": pd.Series([-0.0, 0.0, 1.5], dtype="float64")}))
    assert result["columns"]["x"]["distinctCount"] == 2


def test_per_file_scan_details_cannot_displace_native_counters():
    plain = {"format": "csv", "sizeBytes": 4096, "mtimeNs": "1700000000000000000", "skipLines": 0, "outputRows": 3}
    sources = [{"path": f"/data/sat/swarma-wu{i:03d}-{'x' * 120}.csv", **plain} for i in range(700)]
    sources[5] = {**sources[5], "headerCheck": {"blank": 2}}
    sources[9] = {**sources[9], "outputRows": 0}
    metadata = {
        "operatorId": "density",
        "operatorRevision": "0123456789abcdef",
        "operatorType": "Scan",
        "inputOperators": [],
        "inputRows": [],
        "outputRows": 3,
        "operations": {
            "scan": {
                "preview": False,
                "complete": True,
                "resolvedFiles": 700,
                "selectedFiles": 700,
                "omittedFiles": 0,
                "sources": sources,
            }
        },
    }
    profile = ProfileAccumulator("worker-0", metadata)
    profile.add(pd.DataFrame({"flag": ["a", "b", "a"]}))
    profile.finish()
    original = profile.snapshot()
    payload = profile.encode()
    result = json.loads(payload)
    assert len(payload.encode()) <= profile.limits.max_payload_bytes
    scan = result["native"]["operations"]["scan"]
    assert {k: scan[k] for k in ("resolvedFiles", "selectedFiles", "omittedFiles")} == {
        "resolvedFiles": 700,
        "selectedFiles": 700,
        "omittedFiles": 0,
    }
    assert sources[5] in scan["sources"] and sources[9] in scan["sources"]
    assert 2 < len(scan["sources"]) <= 256
    assert scan["sourcesOmitted"] + len(scan["sources"]) == 700
    assert "scan_sources_payload_budget" in result["omissions"]
    assert result["columns"]["flag"]["frequencies"] == original["columns"]["flag"]["frequencies"]
    assert profile.snapshot() == original


def test_scan_findings_outlast_value_dictionaries():
    sources = [
        {
            "path": f"/data/legal/report_{i:02d}.csv",
            "format": "csv",
            "sizeBytes": 2048,
            "mtimeNs": "1",
            "skipLines": 0,
            "outputRows": 80,
            "headerCheck": {"blank": 3, "suggest": {"skipLines": 2, "header": ["Year", "State"]}},
        }
        for i in range(27)
    ]
    metadata = {
        "operatorId": "legal",
        "operatorRevision": "0123456789abcdef",
        "operatorType": "Scan",
        "inputOperators": [],
        "inputRows": [],
        "outputRows": 240,
        "operations": {
            "scan": {
                "preview": False,
                "complete": True,
                "resolvedFiles": 27,
                "selectedFiles": 27,
                "omittedFiles": 0,
                "sources": sources,
            }
        },
    }
    frame = pd.DataFrame({f"c{j}": [f"value {j}-{i}-{'w' * 40}" for i in range(240)] for j in range(35)})
    profile = ProfileAccumulator("worker-0", metadata)
    profile.add(frame)
    profile.finish()
    payload = profile.encode()
    result = json.loads(payload)
    assert len(payload.encode()) <= profile.limits.max_payload_bytes
    scan = result["native"]["operations"]["scan"]
    assert scan["sources"] == sources and "sourcesOmitted" not in scan
    assert "payload_budget" in result["omissions"] and "scan_sources_payload_budget" not in result["omissions"]


def test_wide_scan_preserves_compact_source_identity_when_statistics_overflow():
    source = {
        "path": "/data/wide.xlsx",
        "sizeBytes": 12345,
        "mtimeNs": "987654321",
        "format": "excel",
        "sheet": "metadata",
        "outputRows": 153,
    }
    metadata = {
        "operatorType": "Scan",
        "inputRows": [],
        "outputRows": 153,
        "operations": {"scan": {"sources": [source], "selectedFiles": 1}},
    }
    frame = pd.DataFrame({f"column_{j}": [f"value_{j}_{i}" for i in range(153)] for j in range(179)})
    profile = ProfileAccumulator("worker-0", metadata)
    profile.add(frame)
    profile.finish()
    original = profile.snapshot()
    result = json.loads(profile.encode())
    scan = result["native"]["operations"]["scan"]
    assert scan["sources"] == [{k: source[k] for k in ("path", "sizeBytes", "mtimeNs")}]
    assert scan.get("sourcesOmitted", 0) == 0
    assert scan["sourceDetailsOmitted"] == 1
    assert "scan_source_details_payload_budget" in result["omissions"]
    assert "payload_budget" in result["omissions"]
    assert profile.snapshot() == original


def test_source_identity_outlasts_unavailable_statistics():
    source = {"path": "/data/values.csv", "sizeBytes": 12, "mtimeNs": "123"}
    profile = ProfileAccumulator(
        "worker-0",
        {"operatorType": "Scan", "operations": {"scan": {"sources": [source]}}},
        limits=ProfileLimits(max_payload_bytes=1600),
    )
    profile.add(pd.DataFrame({f"column_{i}": [i] for i in range(100)}))
    profile.finish()
    payload = profile.encode()
    result = json.loads(payload)
    assert len(payload.encode()) <= 1600
    assert result["native"]["operations"]["scan"]["sources"] == [source]
    assert result["status"] == "unavailable"
    assert not result["coverage"]["complete"]


def test_counts_values_and_ranges_cover_every_row():
    frame = pd.DataFrame({"k": [f"g{i % 7}" for i in range(5000)], "v": [float(i % 11) for i in range(5000)]})
    frame.loc[::10, "v"] = None
    _, result = collect(frame)
    assert result["coverage"] == {"scope": "worker", "complete": True, "rowsProcessed": 5000, "yields": 1}
    v = result["columns"]["v"]
    assert v["nullCount"] == int(frame["v"].isna().sum()) and v["distinctCount"] == frame["v"].nunique()
    assert v["min"] == scalar("float64", 0.0) and v["max"] == scalar("float64", 10.0)
    k = result["columns"]["k"]
    assert {e["value"]["value"]: e["count"] for e in k["mergeValues"]} == frame["k"].value_counts().to_dict()
    assert not [o for o in result["omissions"] if o.endswith("_budget")]


def test_distinct_counts_are_exact_beyond_the_value_list_limit():
    frame = pd.DataFrame({"id": range(1000), "group": [i % 3 for i in range(1000)]})
    _, result = collect(frame)
    ids = result["columns"]["id"]
    assert ids["distinctCount"] == 1000 and ids["uniquenessRatio"] == 1.0
    assert ids["frequencies"] is None and ids["mergeValues"] is None
    assert "distinct_limit" in ids["omissions"]
    assert ids["min"] == scalar("int64", "0") and ids["max"] == scalar("int64", "999")
    assert result["columns"]["group"]["distinctCount"] == 3
    assert result["columns"]["group"]["frequencies"]["truncated"] is False


def test_duplicate_rows_are_exact_and_skip_hashing_with_a_unique_column(monkeypatch):
    rows = pd.DataFrame({"a": [1.0, 1.0, -0.0, 0.0, None, None, 2.0], "b": ["x", "x", "y", "y", None, None, "z"]})
    _, result = collect(rows)
    assert result["structure"]["duplicateRows"] == int(rows.duplicated().sum()) == 3
    assert result["structure"]["allNullRows"] == 2

    def refuse(*args, **kwargs):
        raise AssertionError("row hashing should be skipped")

    monkeypatch.setattr(pd.DataFrame, "duplicated", refuse)
    keyed = rows.assign(key=range(len(rows)))
    _, result = collect(keyed)
    assert result["structure"]["duplicateRows"] == 0


def test_types_are_inferred_from_every_value():
    frame = pd.DataFrame(
        {
            "late": pd.Series([None] * 200 + ["a", "b", "a"], dtype=object),
            "mixed": pd.Series([1] * 128 + [1.5], dtype=object).reindex(range(203)),
        }
    )
    _, result = collect(frame)
    assert result["columns"]["late"]["type"] == "str" and result["columns"]["late"]["distinctCount"] == 2
    assert result["columns"]["mixed"]["type"] == "unsupported"
    assert result["columns"]["mixed"]["min"] is None and "unsupported_type" in result["columns"]["mixed"]["omissions"]


def test_counts_are_kept_for_values_that_cannot_be_listed():
    frame = pd.DataFrame({"long": ["prefix-a", "prefix-b", "prefix-a"], "inf": [1.0, float("inf"), 2.0]})
    _, result = collect(frame, limits=ProfileLimits(max_value_chars=6))
    assert result["columns"]["long"]["distinctCount"] == 2 and result["columns"]["long"]["frequencies"] is None
    assert "value_budget" in result["columns"]["long"]["omissions"]
    assert result["columns"]["inf"]["distinctCount"] == 3 and result["columns"]["inf"]["min"] is None
    assert "nonfinite_value" in result["columns"]["inf"]["omissions"]
    _, nested = collect(pd.DataFrame({"nested": [[1], [2]]}))
    assert nested["columns"]["nested"]["distinctCount"] is None
    assert "unsupported_type" in nested["columns"]["nested"]["omissions"]


def test_counts_across_yields_stay_exact_where_they_can():
    first = pd.DataFrame({"g": ["a", "b", None], "id": range(0, 3)})
    second = pd.DataFrame({"g": ["a", "c", "a"], "id": range(3, 6)})
    _, result = collect(first, second)
    g = result["columns"]["g"]
    assert g["nullCount"] == 1 and g["distinctCount"] == 3
    assert {e["value"]["value"]: e["count"] for e in g["mergeValues"]} == {"a": 3, "b": 1, "c": 1}
    assert result["columns"]["id"]["max"] == scalar("int64", "5")
    assert result["structure"]["duplicateRows"] is None
    assert "duplicate_rows_multi_yield" in result["omissions"]
    assert result["coverage"]["complete"] and result["coverage"]["rowsProcessed"] == 6
