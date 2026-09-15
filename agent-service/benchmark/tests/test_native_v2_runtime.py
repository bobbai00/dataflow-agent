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


def test_derive_preserves_duplicate_index_order_and_only_declared_output():
    source = pd.DataFrame({"x": [2, 4, 1], "keep": ["a", "b", "c"]}, index=[8, 8, -2])
    result = run(
        "Derive",
        source,
        columns=[
            {
                "as": "doubled",
                "inputs": ["x"],
                "dtype": "int64",
                "func": "def apply(row):\n    return row['x'] * 2",
            }
        ],
    )
    assert result["doubled"].tolist() == [4, 8, 2]
    assert result["keep"].tolist() == ["a", "b", "c"]
    assert list(result.columns) == ["x", "keep", "doubled"]
    assert source.columns.tolist() == ["x", "keep"]


def test_callbacks_receive_none_and_preserve_literal_words():
    result = run(
        "Transform",
        pd.DataFrame({"x": [None, np.nan, pd.NA, "false null true"]}),
        columns=[
            {
                "column": "x",
                "dtype": "str",
                "func": "def apply(value):\n    return 'null' if value is None else value",
            }
        ],
    )
    assert result["x"].tolist() == ["null", "null", "null", "false null true"]


def test_empty_derive_has_typed_output_without_invoking_callback():
    result = run(
        "Derive",
        pd.DataFrame({"x": pd.Series(dtype="int64")}),
        columns=[
            {
                "as": "v",
                "inputs": ["x"],
                "dtype": "float64",
                "func": "def apply(row):\n    raise RuntimeError('must not run')",
            }
        ],
    )
    assert result.empty and str(result["v"].dtype) == "Float64"


@pytest.mark.parametrize("returned", ["[1, 2]", "{'a': 1}", "'2'", "2.5", "True"])
def test_derive_rejects_non_integer_output(returned):
    with pytest.raises(runtime.NativeError) as failure:
        run(
            "Derive",
            pd.DataFrame({"x": [1]}),
            columns=[
                {
                    "as": "v",
                    "inputs": ["x"],
                    "dtype": "int64",
                    "func": f"def apply(row):\n    return {returned}",
                }
            ],
        )
    assert failure.value.diagnostic["code"] == "CALLBACK_RETURN_TYPE"


def test_multiple_derived_columns_read_original_input_not_each_other():
    with pytest.raises(runtime.NativeError, match="MISSING_COLUMN"):
        run(
            "Derive",
            pd.DataFrame({"x": [1]}),
            columns=[
                {"as": "y", "inputs": ["x"], "dtype": "int64", "func": "def apply(row):\n    return row['x']"},
                {"as": "z", "inputs": ["y"], "dtype": "int64", "func": "def apply(row):\n    return row['y']"},
            ],
        )


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


def test_undeclared_column_is_actionable_and_row_mapping_cannot_be_mutated():
    for function, code in [
        ("def apply(row):\n    return row['hidden'] > 0", "UNDECLARED_COLUMN"),
        ("def apply(row):\n    row['x'] = 10\n    return True", "CALLBACK_RUNTIME"),
    ]:
        source = pd.DataFrame({"x": [1], "hidden": [3]})
        with pytest.raises(runtime.NativeError) as failure:
            run("Filter", source, columns=["x"], func=function)
        assert failure.value.diagnostic["code"] == code
        assert source["x"].tolist() == [1]


@pytest.mark.parametrize("policy,expected", [("drop", [3]), ("keep", [None, 3])])
def test_filter_null_policy_and_stable_subset(policy, expected):
    source = pd.DataFrame({"x": pd.Series([None, 1, 3], dtype="Int64")})
    result = run(
        "Filter",
        source,
        columns=["x"],
        nulls=policy,
        func="def apply(row):\n    return None if row['x'] is None else row['x'] > 1",
    )
    assert [None if pd.isna(v) else v for v in result["x"]] == expected


@pytest.mark.parametrize("value,code", [("'false'", "CALLBACK_RETURN_TYPE"), ("None", "FILTER_NULL")])
def test_filter_never_uses_truthiness_or_silently_swallows_null_error(value, code):
    with pytest.raises(runtime.NativeError) as failure:
        run("Filter", pd.DataFrame({"x": [1]}), columns=[], nulls="error", func=f"def apply(row):\n    return {value}")
    assert failure.value.diagnostic["code"] == code


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


def test_fill_null_only_changes_missing_cells_and_checks_type():
    source = pd.DataFrame({"x": pd.Series([1, None, 0], dtype="Int64")})
    assert run("FillNull", source, values={"x": 5})["x"].tolist() == [1, 5, 0]
    with pytest.raises(runtime.NativeError, match="FILL_TYPE"):
        run("FillNull", source, values={"x": "oops"})


def test_column_collisions_and_missing_inputs_fail_before_callbacks():
    source = pd.DataFrame({"x": [1], "y": [2]})
    with pytest.raises(runtime.NativeError, match="COLUMN_COLLISION"):
        run(
            "Derive",
            source,
            columns=[{"as": "x", "inputs": [], "dtype": "int64", "func": "def apply(row):\n    return 1"}],
        )
    with pytest.raises(runtime.NativeError, match="MISSING_COLUMN"):
        run(
            "Transform",
            source,
            columns=[{"column": "missing", "dtype": "int64", "func": "def apply(value):\n    return 1"}],
        )
    with pytest.raises(runtime.NativeError, match="COLUMN_COLLISION"):
        run("Project", source, rename={"x": "y"})


def test_udf_is_unknown_even_when_it_preserves_row_count():
    udf = spec("UDF", code="def process(source):\n    return source.iloc[::-1].copy()")
    result = runtime.execute_native(udf, [pd.DataFrame({"x": [1, 2]})])
    assert result["x"].tolist() == [2, 1]
    assert result.attrs["native_v2"]["rowEffect"] == "unknown"


def test_udf_wrong_shape_and_signature_have_explicit_diagnostics():
    with pytest.raises(runtime.NativeError, match="UDF_RETURN_TYPE"):
        runtime.execute_native(spec("UDF", code="def process(source):\n    return [1, 2]"), [pd.DataFrame({"x": [1]})])
    with pytest.raises(runtime.NativeError, match="CALLBACK_SIGNATURE"):
        runtime.validate_native(spec("UDF", code="def process(other):\n    return other"))


def test_a_keyerror_in_an_internal_dictionary_is_not_mislabeled_as_column_access():
    with pytest.raises(runtime.NativeError) as failure:
        run("Filter", pd.DataFrame({"x": [1]}), columns=["x"], func="def apply(row):\n    return {}['missing']")
    assert failure.value.diagnostic["code"] == "CALLBACK_RUNTIME"


def test_udf_rejects_nested_values_before_the_engine_transport_fails():
    with pytest.raises(runtime.NativeError, match="OUTPUT_VALUE_TYPE"):
        runtime.execute_native(
            spec(
                "UDF",
                code="def process(source):\n    import pandas as pd\n    return pd.DataFrame({'nested': [[1, 2]]})",
            ),
            [pd.DataFrame({"x": [1]})],
        )


def test_preflight_rejects_project_keep_and_drop_before_execution():
    with pytest.raises(runtime.NativeError, match="PROJECT_OPTIONS"):
        runtime.validate_native(spec("Project", keep=["x"], drop=["y"]))
