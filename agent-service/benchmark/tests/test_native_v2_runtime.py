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

"""Execute the same standalone Python support embedded by the V2 compiler."""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


RUNTIME = Path(__file__).resolve().parents[2] / "src/agent/native/python/runtime.py"
MODULE_SPEC = importlib.util.spec_from_file_location("native_v2_runtime", RUNTIME)
runtime = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(runtime)


def spec(kind, **properties):
    return {
        "id": "candidate",
        "revision": "r-test",
        "version": "v2",
        "type": kind,
        "inputs": [] if kind == "Scan" else ["source"],
        "properties": properties,
    }


def run(kind, frame, **properties):
    return runtime.execute_native(spec(kind, **properties), [frame])


def test_map_returns_the_new_row_and_measures_read_columns():
    source = pd.DataFrame({"x": [2, 4, 1], "keep": ["a", "b", "c"]}, index=[8, 8, -2])
    result = run("Map", source, func="def apply(row):\n    return {**row, 'doubled': row['x'] * 2}")
    assert result["doubled"].tolist() == [4, 8, 2]
    assert result["keep"].tolist() == ["a", "b", "c"]
    assert list(result.columns) == ["x", "keep", "doubled"]
    assert str(result["doubled"].dtype) == "Int64"
    assert source.columns.tolist() == ["x", "keep"]
    operations = result.attrs["native_v2"]["operations"]
    assert operations["columnDependencies"] == {"x": ["x"], "keep": ["keep"], "doubled": ["x"]}
    assert operations["addedColumns"] == ["doubled"] and operations["droppedColumns"] == []
    assert operations["readColumns"] == ["x"]


def test_map_can_drop_and_rename_by_returning_other_keys():
    source = pd.DataFrame({"x": [1, 2], "y": ["a", "b"]})
    result = run("Map", source, func="def apply(row):\n    return {'label': row['y'], 'twice': row['x'] * 2}")
    assert list(result.columns) == ["label", "twice"]
    assert result["twice"].tolist() == [2, 4]
    assert result.attrs["native_v2"]["operations"]["droppedColumns"] == ["x", "y"]


def test_callbacks_receive_none_and_preserve_literal_words():
    result = run(
        "Map",
        pd.DataFrame({"x": [None, np.nan, pd.NA, "false null true"]}),
        func="def apply(row):\n    return {'x': 'null' if row['x'] is None else row['x']}",
    )
    assert result["x"].tolist() == ["null", "null", "null", "false null true"]
    assert list(result.columns) == ["x"]


def test_empty_map_learns_its_columns_from_a_probe_or_keeps_the_input_schema():
    empty = pd.DataFrame({"x": pd.Series(dtype="int64")})
    learned = run("Map", empty, func="def apply(row):\n    return {**row, 'v': 1.5}")
    assert learned.empty and list(learned.columns) == ["x", "v"]
    assert str(learned["x"].dtype) == "Int64" and str(learned["v"].dtype) == "string"
    kept = run("Map", empty, func="def apply(row):\n    return {**row, 'v': row['x'] * 2}")
    assert kept.empty and list(kept.columns) == ["x"]


@pytest.mark.parametrize(
    "returned,dtype",
    [("2.5", "Float64"), ("True", "boolean"), ("'2'", "string"), ("7", "Int64"), ("None", "string")],
)
def test_map_infers_each_column_type_from_its_values(returned, dtype):
    result = run("Map", pd.DataFrame({"x": [1]}), func=f"def apply(row):\n    return {{**row, 'v': {returned}}}")
    assert str(result["v"].dtype) == dtype


def test_map_promotes_ints_to_float_and_rejects_incompatible_mixes():
    promoted = run(
        "Map", pd.DataFrame({"x": [1, 2]}), func="def apply(row):\n    return {'v': 1 if row['x'] == 1 else 2.5}"
    )
    assert str(promoted["v"].dtype) == "Float64" and promoted["v"].tolist() == [1.0, 2.5]
    with pytest.raises(runtime.NativeError) as failure:
        run("Map", pd.DataFrame({"x": [1, 2]}), func="def apply(row):\n    return {'v': 1 if row['x'] == 1 else 'a'}")
    assert failure.value.diagnostic["code"] == "OUTPUT_VALUE_TYPE"
    assert "row 0" in failure.value.diagnostic["message"] and "row 1" in failure.value.diagnostic["message"]
    with pytest.raises(runtime.NativeError) as failure:
        run("Map", pd.DataFrame({"x": [1]}), func="def apply(row):\n    return 5")
    assert failure.value.diagnostic["code"] == "CALLBACK_RETURN_TYPE"


def test_map_columns_read_the_original_row_not_each_other():
    with pytest.raises(runtime.NativeError, match="MISSING_COLUMN"):
        run("Map", pd.DataFrame({"x": [1]}), func="def apply(row):\n    return {**row, 'y': row['x'], 'z': row['y']}")


@pytest.mark.parametrize(
    "source,code",
    [
        ("def apply(row)\n    return 1", "PYTHON_SYNTAX"),
        ("def apply(a, b):\n    return 1", "CALLBACK_SIGNATURE"),
        ("def other(row):\n    return 1", "CALLBACK_SIGNATURE"),
        ("async def apply(row):\n    return 1", "CALLBACK_SIGNATURE"),
        ("def apply(row):\n    return 1\ndef apply(row):\n    return 2", "CALLBACK_SIGNATURE"),
        ("def apply(row=[]):\n    return 1", "CALLBACK_SIGNATURE"),
        ("@staticmethod\ndef apply(row):\n    return 1", "CALLBACK_SIGNATURE"),
    ],
)
def test_preflight_rejects_bad_syntax_or_entry_without_execution(source, code):
    with pytest.raises(runtime.NativeError) as failure:
        runtime.validate_native(spec("Filter", columns=[], func=source))
    assert failure.value.diagnostic["code"] == code
    assert failure.value.diagnostic["stage"] == "compile"


def test_preflight_does_not_execute_imports_or_function_bodies():
    runtime.validate_native(
        spec(
            "Filter",
            columns=[],
            func=("import a_package_that_does_not_exist\ndef apply(row):\n    raise RuntimeError('not executed')"),
        )
    )


def test_error_is_structured_and_source_mapped_to_submitted_callback():
    with pytest.raises(runtime.NativeError) as failure:
        run(
            "Filter",
            pd.DataFrame({"x": [0]}),
            columns=["x"],
            func=("def apply(row):\n    denominator = row['x']\n    return 1 / denominator > 0"),
        )
    diagnostic = failure.value.diagnostic
    assert diagnostic["operatorId"] == "candidate"
    assert diagnostic["operatorRevision"] == "r-test"
    assert diagnostic["stage"] == "execute"
    assert diagnostic["source"]["line"] == 3
    assert diagnostic["source"]["entry"] == "apply"
    assert "denominator" in diagnostic["source"]["excerpt"]
    encoded = str(failure.value).split("NATIVE_ERROR_V2:", 1)[1]
    assert json.loads(encoded) == diagnostic


def test_missing_column_is_actionable_and_row_mapping_cannot_be_mutated():
    for function, code in [
        ("def apply(row):\n    return row['absent'] > 0", "MISSING_COLUMN"),
        ("def apply(row):\n    row['x'] = 10\n    return True", "CALLBACK_RUNTIME"),
    ]:
        source = pd.DataFrame({"x": [1], "other": [3]})
        with pytest.raises(runtime.NativeError) as failure:
            run("Filter", source, func=function)
        assert failure.value.diagnostic["code"] == code
        assert source["x"].tolist() == [1]
    kept = run("Filter", pd.DataFrame({"x": [1, 5], "other": [3, 4]}), func="def apply(row):\n    return row['x'] > 2")
    assert kept["x"].tolist() == [5]
    assert kept.attrs["native_v2"]["operations"]["predicateColumns"] == ["x"]


def test_filter_drops_none_verdicts_counts_them_and_keeps_a_stable_subset():
    source = pd.DataFrame({"x": pd.Series([None, 1, 3], dtype="Int64")})
    result = run("Filter", source, func="def apply(row):\n    return None if row['x'] is None else row['x'] > 1")
    assert [None if pd.isna(v) else v for v in result["x"]] == [3]
    operations = result.attrs["native_v2"]["operations"]
    assert (operations["keptRows"], operations["rejectedRows"], operations["nullPredicates"]) == (1, 2, 1)


def test_filter_never_uses_truthiness():
    with pytest.raises(runtime.NativeError) as failure:
        run("Filter", pd.DataFrame({"x": [1]}), func="def apply(row):\n    return 'false'")
    assert failure.value.diagnostic["code"] == "CALLBACK_RETURN_TYPE"


def test_import_failure_is_distinct_and_points_at_submitted_import():
    with pytest.raises(runtime.NativeError) as failure:
        run(
            "Filter",
            pd.DataFrame({"x": [1]}),
            columns=[],
            func=("import a_package_that_does_not_exist\ndef apply(row):\n    return True"),
        )
    assert failure.value.diagnostic["code"] == "PYTHON_IMPORT"
    assert failure.value.diagnostic["source"]["line"] == 1


def test_cast_explicit_loss_policy_and_empty_dtype():
    source = pd.DataFrame({"x": ["2", "unknown", None]})
    with pytest.raises(runtime.NativeError, match="CAST_INVALID_VALUE"):
        run("Cast", source, columns=[{"column": "x", "dtype": "float64"}])
    result = run("Cast", source, columns=[{"column": "x", "dtype": "float64"}], errors="null")
    assert result["x"].iloc[0] == 2
    assert result["x"].isna().sum() == 2
    assert result.attrs["native_v2"]["operations"]["conversionFailures"] == {"x": 1}
    empty = run("Cast", source.iloc[:0], columns=[{"column": "x", "dtype": "int64"}])
    assert str(empty["x"].dtype) == "Int64"


def test_cast_integer_and_boolean_do_not_use_lossy_or_truthy_conversion():
    with pytest.raises(runtime.NativeError, match="CAST_INVALID_VALUE"):
        run("Cast", pd.DataFrame({"x": [1.5]}), columns=[{"column": "x", "dtype": "int64"}])
    result = run("Cast", pd.DataFrame({"x": ["false", "true"]}), columns=[{"column": "x", "dtype": "bool"}])
    assert result["x"].tolist() == [False, True]


def test_datetime_cast_requires_timezone_for_naive_values_and_normalizes_utc():
    source = pd.DataFrame({"x": ["2024-01-01 00:00:00"]})
    with pytest.raises(runtime.NativeError, match="CAST_INVALID_VALUE"):
        run("Cast", source, columns=[{"column": "x", "dtype": "datetime"}])
    result = run("Cast", source, columns=[{"column": "x", "dtype": "datetime", "timezone": "America/Los_Angeles"}])
    assert result["x"].iloc[0] == pd.Timestamp("2024-01-01T08:00:00Z")


def test_map_replaces_in_place_and_schema_slips_fail_clearly():
    source = pd.DataFrame({"x": [1, 2], "y": [2, 3]})
    replaced = run("Map", source, func="def apply(row):\n    return {**row, 'x': 7}")
    assert list(replaced.columns) == ["x", "y"] and replaced["x"].tolist() == [7, 7]
    with pytest.raises(runtime.NativeError) as failure:
        run("Map", source, func="def apply(row):\n    return {**row, 'k': 1} if row['x'] == 1 else {**row, 'm': 1}")
    assert failure.value.diagnostic["code"] == "MAP_SCHEMA"
    with pytest.raises(runtime.NativeError, match="MISSING_COLUMN"):
        run("Map", source, func="def apply(row):\n    return {**row, 'z': row['missing']}")
    with pytest.raises(runtime.NativeError, match="COLUMN_COLLISION"):
        run("Project", source, rename={"x": "y"})


def test_process_is_unknown_even_when_it_preserves_row_count():
    udf = spec("Process", code="def process(source):\n    return source.iloc[::-1].copy()")
    result = runtime.execute_native(udf, [pd.DataFrame({"x": [1, 2]})])
    assert result["x"].tolist() == [2, 1]
    assert result.attrs["native_v2"]["rowEffect"] == "unknown"


@pytest.mark.parametrize("dtype", ["Float32", "Float64"])
@pytest.mark.parametrize(
    "values, expected",
    [([3, 4, None, None], [50, 100, 75, 75]),
     ([3, 3, 4, None], [50, 50, 100, 50]),
     ([None, None], [np.nan, np.nan])],
)
def test_process_numeric_ranks_exclude_missing_float_values(dtype, values, expected):
    source = pd.DataFrame({"wait": pd.Series(values, dtype=dtype)})
    original = source.copy(deep=True)
    result = run("Process", source, code="""def process(source):
    import pandas as pd
    values = pd.to_numeric(source['wait'], errors='coerce')
    count = values.notna().sum()
    ranks = values.rank(method='average') * 100 / count if count else values
    source['wait_score'] = ranks.fillna(ranks.median())
    return source
""")
    pd.testing.assert_series_equal(result.wait_score, pd.Series(expected, name="wait_score"), check_dtype=False)
    pd.testing.assert_frame_equal(source, original)


def test_process_float_compatibility_preserves_integer_precision_and_other_columns():
    source = pd.DataFrame({
        "amount": pd.Series([1.25, None], dtype="Float64"),
        "id": pd.Series([2**53 + 1, None], dtype="Int64"),
        "label": pd.Series(["A", None], dtype="string"),
        "flag": pd.Series([True, None], dtype="boolean"),
        "at": pd.to_datetime(["2026-01-01", None], utc=True),
    }, index=[0, 1])
    result = run("Process", source, code="def process(source):\n    return source")
    pd.testing.assert_frame_equal(result.drop(columns="amount"), source.drop(columns="amount"))
    assert int(result.id.iloc[0]) == 2**53 + 1
    assert result.amount.iloc[0] == 1.25 and pd.isna(result.amount.iloc[1])


def test_process_wrong_shape_and_signature_have_explicit_diagnostics():
    with pytest.raises(runtime.NativeError, match="PROCESS_RETURN_TYPE"):
        runtime.execute_native(
            spec("Process", code="def process(source):\n    return [1, 2]"), [pd.DataFrame({"x": [1]})]
        )
    with pytest.raises(runtime.NativeError, match="CALLBACK_SIGNATURE"):
        runtime.validate_native(spec("Process", code="def process(a, b):\n    return a"))


def test_a_keyerror_in_an_internal_dictionary_is_not_mislabeled_as_column_access():
    with pytest.raises(runtime.NativeError) as failure:
        run("Filter", pd.DataFrame({"x": [1]}), columns=["x"], func="def apply(row):\n    return {}['missing']")
    assert failure.value.diagnostic["code"] == "CALLBACK_RUNTIME"


def test_process_rejects_nested_values_before_the_engine_transport_fails():
    with pytest.raises(runtime.NativeError, match="OUTPUT_VALUE_TYPE"):
        runtime.execute_native(
            spec(
                "Process",
                code="def process(source):\n    import pandas as pd\n    return pd.DataFrame({'nested': [[1, 2]]})",
            ),
            [pd.DataFrame({"x": [1]})],
        )


def test_process_naive_datetimes_read_as_utc_and_mixed_scalars_as_text():
    result = run("Process", pd.DataFrame({"x": [1]}), code="""def process(source):
    import datetime
    import pandas as pd
    return pd.DataFrame({
        'when': pd.to_datetime(['2024-05-10 12:00', None]),
        'objects': [datetime.datetime(2024, 5, 10, 12, 0), None],
        'code': [7, 'A7'],
        'amount': [1.5, 2.5],
        'aware': pd.to_datetime(['2024-05-10 12:00', None], utc=True),
    })
""")
    assert str(result["when"].dtype) == "datetime64[ns, UTC]"
    assert result["when"].iloc[0] == pd.Timestamp("2024-05-10 12:00", tz="UTC")
    assert result["objects"].iloc[0] == pd.Timestamp("2024-05-10 12:00", tz="UTC")
    assert result["code"].tolist() == ["7", "A7"]
    assert result.attrs["native_v2"]["operations"]["normalized"] == {"utc": ["when", "objects"], "text": ["code"]}
    untouched = run("Process", pd.DataFrame({"x": [1]}), code="def process(source):\n    return source")
    assert "normalized" not in untouched.attrs["native_v2"]["operations"]
    # Inputs still meet the contract: a naive timestamp handed to an operator is refused.
    with pytest.raises(runtime.NativeError, match="INPUT_VALUE_TYPE"):
        run("Process", pd.DataFrame({"t": pd.to_datetime(["2024-01-01"])}), code="def process(source):\n    return source")


def flow(kind, frames, **properties):
    measured = runtime.execute_native({**spec(kind, **properties), "inputs": [f"in{i}" for i in range(len(frames))],
                                       "profileCollection": True}, frames)
    return measured.attrs["native_v2"]["operations"]


def test_filter_names_values_written_differently_from_the_kept_one():
    # environment-easy-6: `== 'yes'` keeps "yes" and rejects "YES" and "Yes", the same verdict written two other ways.
    samples = pd.DataFrame({"Violation": ["yes"] * 5 + ["YES"] * 3 + ["Yes"] * 2 + ["no"] * 9 + ["NO"] * 4}).astype("string")
    operations = flow("Filter", [samples], func="def apply(row):\n    return row['Violation'] == 'yes'")
    assert operations["filterNearMisses"] == [{"column": "Violation", "rows": 5, "values": [
        {"value": "YES", "rows": 3, "counterpart": "yes", "how": "literal"},
        {"value": "Yes", "rows": 2, "counterpart": "yes", "how": "literal"}]}]
    # "no" and "NO" are not like what the condition looks for: no line about them.
    assert "filterNoMatch" not in operations
    # Without a literal to compare with, the kept values are the reference.
    computed = flow("Filter", [samples], func="def apply(row):\n    return row['Violation'] in {'y' + 'es'}")
    assert [(v["value"], v["how"]) for v in computed["filterNearMisses"][0]["values"]] == [("YES", "kept"), ("Yes", "kept")]


def test_filter_blames_a_rejected_row_on_the_condition_that_failed():
    # In `a and b`, a row that fails `a` never reads b: its "Violation" value says nothing about `b`.
    samples = pd.DataFrame({
        "Type": ["Marine"] * 4 + ["Fresh"] * 6,
        "Violation": ["yes", "yes", "no", "YES"] + ["Yes"] * 6,
    }).astype("string")
    operations = flow("Filter", [samples], func="def apply(row):\n    return row['Type'] == 'Marine' and row['Violation'] == 'yes'")
    # Only the marine "YES" row was rejected by the Violation test; the six fresh "Yes" rows were rejected by Type.
    assert operations["filterNearMisses"] == [{"column": "Violation", "rows": 1, "values": [
        {"value": "YES", "rows": 1, "counterpart": "yes", "how": "literal"}]}]


def test_filter_names_a_rejected_value_that_holds_a_literal_of_the_condition():
    # PrepBench case 111: the data writes "the United Kingdom"; the condition looks for "United Kingdom".
    pairs = pd.DataFrame({
        "Breakdown": ["Europe"] * 6 + ["Asia"] * 2,
        "Country": ["Germany", "France", "the United Kingdom", "the United Kingdom", "Spain", "Italy", "China", "India"],
    }).astype("string")
    condition = ("def apply(row):\n    return (row['Breakdown'], row['Country']) in "
                 "[('Europe', 'Germany'), ('Europe', 'France'), ('Europe', 'United Kingdom'), ('Asia', 'China')]")
    operations = flow("Filter", [pairs], func=condition)
    assert operations["filterNearMisses"] == [{"column": "Country", "rows": 2, "values": [
        {"value": "the United Kingdom", "rows": 2, "counterpart": "United Kingdom", "how": "contains"}]}]


def test_a_value_that_holds_a_literal_among_other_words_is_another_value():
    # BIRD 758 and 817: "Human-Vulcan" and "Black/Blue" are another race and another colour, not "Human" and "Blue".
    heroes = pd.DataFrame({"race": ["Human"] * 3 + ["Human-Vulcan", "Human / Radiation", "Mutant"],
                           "colour": ["Blue", "Black/Blue", "Blue/White", "Green", "Blue", "Red"]}).astype("string")
    assert "filterNearMisses" not in flow("Filter", [heroes], func="def apply(row):\n    return row['race'] == 'Human'")
    assert "filterNearMisses" not in flow("Filter", [heroes], func="def apply(row):\n    return row['colour'] == 'Blue'")
    # BIRD 593: "New York, NY" may not be the "New York" the condition means; "New-York" is.
    users = pd.DataFrame({"Location": ["New York", "New-York", "New York, NY", "New York City", "Boston"]}).astype("string")
    misses = flow("Filter", [users], func="def apply(row):\n    return row['Location'] == 'New York'")["filterNearMisses"]
    assert [v["value"] for v in misses[0]["values"]] == ["New-York"]
    # BIRD 563: a zero part after the words is how the value is written, as an article before them is.
    posts = pd.DataFrame({"CreationDate": ["2014-04-23 20:29:39.0", "2014-04-24 08:00:00.0"]}).astype("string")
    misses = flow("Filter", [posts], func="def apply(row):\n    return row['CreationDate'] == '2014/4/23 20:29:39'")["filterNearMisses"]
    assert [(v["value"], v["how"]) for v in misses[0]["values"]] == [("2014-04-23 20:29:39.0", "contains")]


def test_punctuation_around_a_value_is_part_of_it():
    # legal-hard-2: a condition that keeps "<td" lines rejects "</td>", another tag, not "<td" written differently.
    lines = pd.DataFrame({"line": ["<td>Boston</td>", "</td>", "<th>", "</th>", "</table>", "</tbody></table></div>"]}).astype("string")
    for condition in ("row['line'].strip().startswith('<td')", "'<table' in row['line']", "row['line'] == '<th'"):
        assert "filterNearMisses" not in flow("Filter", [lines], func=f"def apply(row):\n    return {condition}")
    grades = pd.DataFrame({"grade": ["A+", "A+", "A-", "A", "B+"]}).astype("string")
    assert "filterNearMisses" not in flow("Filter", [grades], func="def apply(row):\n    return row['grade'] == 'A+'")
    # A stray comma or footnote mark after the words is still the same value written differently.
    towns = pd.DataFrame({"town": ["Aberdeen", "Aberdeen,", "Aberdeen*", "Leeds"]}).astype("string")
    misses = flow("Filter", [towns], func="def apply(row):\n    return row['town'] == 'Aberdeen'")["filterNearMisses"]
    assert sorted(v["value"] for v in misses[0]["values"]) == ["Aberdeen*", "Aberdeen,"]
    # PrepBench case 297: so are brackets; a probe for ':' weeks keeps "Week 13: Final" and rejects "Week 13  (Final)".
    weeks = pd.DataFrame({"Week": ["Week 13: Final", "Week 13  (Final)", "Week 13  (Final)", "Week 2"]}).astype("string")
    misses = flow("Filter", [weeks], func="def apply(row):\n    return ':' in row['Week']")["filterNearMisses"]
    assert misses[0]["values"] == [{"value": "Week 13  (Final)", "rows": 2, "counterpart": "Week 13: Final", "how": "kept"}]


def test_a_filter_that_found_none_of_its_literals_shows_the_values_it_saw():
    # wildfire-easy-15: months are not zero-padded, so no date splits to '07'.
    fires = pd.DataFrame({"start_date": ["9/22/2002", "10/21/2002", "8/25/2002", "7/4/2003", None]}).astype("string")
    condition = "def apply(row):\n    return row['start_date'] is not None and str(row['start_date']).split('/')[0] == '07'"
    operations = flow("Filter", [fires], func=condition)
    no_match = operations["filterNoMatch"]
    assert (no_match["column"], no_match["literals"]) == ("start_date", ["07"])
    assert [(w["values"][0]["value"], w["count"]) for w in no_match["seen"]] == [("9/22/2002", 1), ("10/21/2002", 1), ("8/25/2002", 1)]
    # A comparison that keeps nothing is often the answer itself ("no area exceeds it"): no literal, no line.
    assert "filterNoMatch" not in flow("Filter", [pd.DataFrame({"diff": [-3, -1]})], func="def apply(row):\n    return row['diff'] > 0")


def test_join_lists_keys_that_match_only_when_written_alike():
    # PrepBench case 25: one gig is in "Las Vegas, Nv"; the coordinates table writes "Las Vegas, NV".
    gigs = pd.DataFrame({"Location": ["Las Vegas, NV", "Las Vegas, NV", "Las Vegas, Nv", "Aberdeen,", "Leeds"]}).astype("string")
    coords = pd.DataFrame({"Location": ["Las Vegas, NV", "Aberdeen", "Leeds"], "LongLat": ["36,-115", "57,-2", "53,-1"]}).astype("string")
    join = flow("Join", [gigs, coords], on="Location", type="left")["join"]
    assert join["nearMisses"]["keys"] == 2 and join["nearMisses"]["rows"] == 2
    assert [(p["left"]["values"][0]["value"], p["right"]["values"][0]["value"]) for p in join["nearMisses"]["pairs"]] == [
        ("Las Vegas, Nv", "Las Vegas, NV"), ("Aberdeen,", "Aberdeen")]
    assert "noMatch" not in join and "unmatchedExamples" not in join["left"]


def test_join_reports_leading_zeros_and_a_join_that_matched_nothing():
    # wildfire-hard-17: NOAA writes station 41018 where RAWS writes NWS ID "041018".
    fires = pd.DataFrame({"station": ["41018", "45421", "227701"]}).astype("string")
    raws = pd.DataFrame({"NWS ID": ["041018", "045421", "227701"], "Station ID": ["17209642", "18770452", "17137190"]}).astype("string")
    near = flow("Join", [fires, raws], on=[["station", "NWS ID"]], type="left")["join"]
    assert near["nearMisses"]["keys"] == 2
    nothing = flow("Join", [fires, raws], on=[["station", "Station ID"]], type="left")["join"]
    assert nothing["noMatch"]["left"]["values"][0]["value"] == "41018" and "nearMisses" not in nothing


def test_a_group_key_split_is_reported_only_for_a_column_that_names_entities():
    # environment-easy-3 keeps "Community" (a beach name in two towns); an outcome column with two values is not reported.
    names = [f"beach{i}" for i in range(30)]
    frame = pd.DataFrame({
        "Beach Name": names * 2,
        "Community": [f"town{i}" for i in range(30)] + ["other town"] + [f"town{i}" for i in range(1, 30)],
        "Organism": ["E. Coli"] * 30 + ["Enterococci"] + ["E. Coli"] * 29,
        "samples": list(range(60)),
    })
    aggregate = {"groupBy": ["Beach Name"], "aggregations": [{"fn": "sum", "col": "samples", "as": "n"}]}
    dependencies = flow("Aggregate", [frame], **aggregate)["keyDependencies"]
    assert [d["column"] for d in dependencies] == ["Community"]


def test_an_aggregate_reports_repeated_rows_it_would_count_twice():
    # legal-hard-15: stacking every state's file lists each cross-state area once per state.
    areas = pd.DataFrame({"area": [f"Area {i}" for i in range(20)] + ["Boston, MA-NH", "Providence, RI-MA"],
                          "reports": list(range(22))}).astype({"area": "string"})
    stacked = pd.concat([areas, areas.iloc[20:]], ignore_index=True)
    total = flow("Aggregate", [stacked], groupBy=[], aggregations=[{"fn": "sum", "col": "reports", "as": "total"}])
    assert total["repeatedInput"][0]["outputColumn"] == "area" and total["repeatedInput"][0]["repeatedValues"] == 2
    # Max and first read each value once however often it repeats: nothing to report.
    top = flow("Aggregate", [stacked], groupBy=[], aggregations=[{"fn": "max", "col": "reports", "as": "top"}])
    assert "repeatedInput" not in top


def test_python_step_reports_repeats_in_an_identifying_column_and_whether_it_created_them():
    # legal-hard-1: each state's file lists the cross-state metro areas, so stacking the files repeats them.
    states = pd.DataFrame({
        "area": [f"Area {i}" for i in range(20)] + ["Boston, MA-NH", "Providence, RI-MA"],
        "reports": list(range(22)),
    }).astype({"area": "string"})
    stacked = pd.concat([states, states.iloc[20:]], ignore_index=True)
    carried = runtime.execute_native(
        {**spec("Process", code="def process(source):\n    return source[['area']]"), "profileCollection": True}, [stacked])
    repeated = carried.attrs["native_v2"]["operations"]["repeatedValues"]
    assert repeated == [{
        "outputColumn": "area", "rows": 24, "distinct": 22, "repeatedValues": 2,
        "examples": [
            {"values": [{"type": "str", "value": "Boston, MA-NH"}], "count": 2, "truncated": False},
            {"values": [{"type": "str", "value": "Providence, RI-MA"}], "count": 2, "truncated": False},
        ],
        "input": 0, "inputColumn": "area", "inputRepeated": 2,
    }]
    created = runtime.execute_native(
        {**spec("Process", code="def process(source):\n    import pandas as pd\n    return pd.concat([source, source.iloc[:3]], ignore_index=True)"),
         "profileCollection": True}, [states])
    assert created.attrs["native_v2"]["operations"]["repeatedValues"][0]["inputRepeated"] == 0
    # A column mostly made of repeats is a grouping column, not an identifier: no report.
    grouped = runtime.execute_native(
        {**spec("Process", code="def process(source):\n    import pandas as pd\n    return pd.concat([source] * 3, ignore_index=True)"),
         "profileCollection": True}, [states])
    assert "repeatedValues" not in grouped.attrs["native_v2"]["operations"]
    plain = runtime.execute_native(spec("Process", code="def process(source):\n    return source[['area']]"), [stacked])
    assert "repeatedValues" not in plain.attrs["native_v2"]["operations"]


def test_repeats_count_only_when_the_repeated_rows_agree_on_their_numbers():
    # archeology-hard-7: two cities named Tripoli at different coordinates are two entities.
    cities = pd.DataFrame({
        "city": [f"City {i}" for i in range(12)] + ["Tripoli", "Tripoli"],
        "lat": [float(i) for i in range(12)] + [32.9, 34.4],
        "lng": [float(i) for i in range(12)] + [13.2, 35.8],
    }).astype({"city": "string"})
    keep = {**spec("Process", code="def process(source):\n    return source"), "profileCollection": True}
    distinct_entities = runtime.execute_native(keep, [cities])
    assert "repeatedValues" not in distinct_entities.attrs["native_v2"]["operations"]
    # The same city listed twice with the same coordinates is one entity counted twice.
    cities.loc[13, ["lat", "lng"]] = [32.9, 13.2]
    duplicated = runtime.execute_native(keep, [cities])
    entry = duplicated.attrs["native_v2"]["operations"]["repeatedValues"][0]
    assert (entry["outputColumn"], entry["repeatedValues"], entry["sameMeasures"]) == ("city", 1, ["lat", "lng"])
    # A percentage with a Unicode minus is a number kept as text, not an identifier.
    changes = pd.DataFrame({"change": ["−1.05%", "+0.94%"] * 2 + [f"+{i}.5%" for i in range(10)]}).astype("string")
    measured = runtime.execute_native(keep, [changes])
    assert "repeatedValues" not in measured.attrs["native_v2"]["operations"]
    # astronomy-easy-4: sunspot counts read as text with a trailing separator are numbers, not identifiers.
    readings = pd.DataFrame({"sunspots": ["18.3;", "8.3;", "26.7;"] * 2 + [f"{i}.1;" for i in range(10)]}).astype("string")
    assert "repeatedValues" not in runtime.execute_native(keep, [readings]).attrs["native_v2"]["operations"]
    assert (runtime._text_number("18.3;"), runtime._text_number("12*"), runtime._text_number(";")) == (18.3, 12.0, None)


def test_preflight_rejects_project_keep_and_drop_before_execution():
    with pytest.raises(runtime.NativeError, match="PROJECT_OPTIONS"):
        runtime.validate_native(spec("Project", keep=["x"], drop=["y"]))
