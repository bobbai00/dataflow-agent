# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""The error taxonomy of every native operator, one row per failure case.

Each row states what the model did wrong, the code and stage the runtime must
answer with, the `field` that names the offending argument, and fragments the
message must contain so the cause (column, value, option) is in the receipt.
A row that escapes as a raw Python exception, or that executes when it should
not, fails the suite. The last test checks that every code the runtime can
raise is exercised here (or is listed as deliberately unreachable).
"""

import ast
import re
from pathlib import Path

import pandas as pd
import pytest

from test_native_v2_runtime import runtime, RUNTIME

pd_ts = pd.Timestamp


def frame():
    return pd.DataFrame(
        {
            "g": ["a", "a", "b"],
            "x": [1, 2, 3],
            "y": ["p:q", "r", None],
            "j": ['["1","2"]', "[3]", None],
            "d": ["2024-01-01", "bad", None],
        }
    )


def other():
    return pd.DataFrame({"g": ["a", "a"], "z": [10, 20]})


def mixed():
    return pd.DataFrame({"g": ["a", "a", "b"], "x": [1, 2, 3], "mix": [1, "two", 3.0]})


def spec(kind, inputs, **props):
    return {"id": "op", "revision": "r", "type": kind, "inputs": inputs, "properties": props}


def fn(body, name="apply", params="row"):
    return f"def {name}({params}):\n    return {body}"


def process(body):
    return {"code": f"def process(t):\n    import pandas as pd\n    return {body}", "entry": "process"}


F = frame
# (operator, case, kind, frames, props, code, stage, field, message fragments)
CASES = [
    # scan -----------------------------------------------------------------
    (
        "scan",
        "missing file",
        "Scan",
        [],
        dict(files="__missing__/nope.csv"),
        "SCAN_NOT_FOUND",
        "execute",
        None,
        ["nope.csv"],
    ),
    (
        "scan",
        "duplicate header",
        "Scan",
        [],
        dict(files="__dup__"),
        "SCAN_HEADER",
        "execute",
        None,
        ["Duplicate header"],
    ),
    (
        "scan",
        "names count mismatch",
        "Scan",
        [],
        dict(files="__ok__", header=False, names=["a"]),
        "SCAN_NAMES",
        "execute",
        None,
        ["1 names for 2 columns"],
    ),
    (
        "scan",
        "skip_lines past end",
        "Scan",
        [],
        dict(files="__ok__", skipLines=50),
        "SCAN_HEADER",
        "execute",
        None,
        ["No header"],
    ),
    (
        "scan",
        "unknown format",
        "Scan",
        [],
        dict(files="__ok__", format="parquet2"),
        "SCAN_OPTIONS",
        "validate",
        None,
        ["parquet2"],
    ),
    (
        "scan",
        "names without header=False",
        "Scan",
        [],
        dict(files="__ok__", names=["a", "b"]),
        "SCAN_OPTIONS",
        "validate",
        None,
        ["header=False"],
    ),
    (
        "scan",
        "binary file without preview",
        "Scan",
        [],
        dict(files="__bin__"),
        "SCAN_FORMAT",
        "validate",
        None,
        ["custom Python loader"],
    ),
    (
        "scan",
        "json format on csv text",
        "Scan",
        [],
        dict(files="__ok__", format="json"),
        "SCAN_PARSE",
        "execute",
        None,
        [],
    ),
    # project --------------------------------------------------------------
    (
        "project",
        "keep missing column",
        "Project",
        [F],
        dict(keep=["nope"]),
        "MISSING_COLUMN",
        "execute",
        "keep/drop",
        ["'nope'", "available"],
    ),
    (
        "project",
        "rename onto existing",
        "Project",
        [F],
        dict(rename={"x": "g"}),
        "COLUMN_COLLISION",
        "execute",
        None,
        ["duplicate"],
    ),
    (
        "project",
        "rename missing column",
        "Project",
        [F],
        dict(rename={"nope": "q"}),
        "MISSING_COLUMN",
        "execute",
        "rename",
        ["'nope'"],
    ),
    (
        "project",
        "keep and drop together",
        "Project",
        [F],
        dict(keep=["x"], drop=["g"]),
        "PROJECT_OPTIONS",
        "validate",
        None,
        ["mutually exclusive"],
    ),
    ("project", "nothing to do", "Project", [F], dict(), "PROJECT_OPTIONS", "validate", None, ["keep, drop or rename"]),
    ("project", "empty keep", "Project", [F], dict(keep=[]), "PROJECT_OPTIONS", "validate", "keep", ["nonempty"]),
    # cast -----------------------------------------------------------------
    (
        "cast",
        "missing column",
        "Cast",
        [F],
        dict(columns=[{"column": "nope", "dtype": "int64"}]),
        "MISSING_COLUMN",
        "execute",
        "columns[0]",
        ["'nope'"],
    ),
    (
        "cast",
        "unknown dtype",
        "Cast",
        [F],
        dict(columns=[{"column": "x", "dtype": "float"}]),
        "DTYPE",
        "validate",
        "columns[0]",
        ["'float'"],
    ),
    (
        "cast",
        "unparseable value",
        "Cast",
        [F],
        dict(columns=[{"column": "d", "dtype": "datetime", "format": "%Y-%m-%d", "timezone": "UTC"}]),
        "CAST_INVALID_VALUE",
        "execute",
        "columns[0]",
        ["'d'", "bad"],
    ),
    (
        "cast",
        "naive datetime without tz",
        "Cast",
        [F],
        dict(columns=[{"column": "d", "dtype": "datetime", "format": "%Y-%m-%d"}]),
        "CAST_INVALID_VALUE",
        "execute",
        "columns[0]",
        ["timezone"],
    ),
    (
        "cast",
        "format on int",
        "Cast",
        [F],
        dict(columns=[{"column": "x", "dtype": "int64", "format": "%d"}]),
        "CAST_OPTIONS",
        "validate",
        "columns[0]",
        ["datetime"],
    ),
    (
        "cast",
        "invalid errors policy",
        "Cast",
        [F],
        dict(columns=[{"column": "x", "dtype": "int64"}], errors="skip"),
        "CAST_OPTIONS",
        "validate",
        "errors",
        ["'skip'"],
    ),
    (
        "cast",
        "mixed-type input column",
        "Cast",
        [mixed],
        dict(columns=[{"column": "mix", "dtype": "int64"}]),
        "INPUT_VALUE_TYPE",
        "contract",
        "inputs[0]",
        ["'mix'", "Repair the producing"],
    ),
    # filter ---------------------------------------------------------------
    (
        "filter",
        "reads missing column",
        "Filter",
        [F],
        dict(func=fn("row['nope'] is None")),
        "MISSING_COLUMN",
        "execute",
        "func",
        ["'nope'", "does not have"],
    ),
    (
        "filter",
        "returns a string",
        "Filter",
        [F],
        dict(func=fn("'yes'")),
        "CALLBACK_RETURN_TYPE",
        "contract",
        "func",
        ["bool or None", "str"],
    ),
    (
        "filter",
        "raises",
        "Filter",
        [F],
        dict(func=fn("1 / 0 > 0")),
        "CALLBACK_RUNTIME",
        "execute",
        "func",
        ["ZeroDivisionError"],
    ),
    (
        "filter",
        "two parameters",
        "Filter",
        [F],
        dict(func=fn("True", params="row, extra")),
        "CALLBACK_SIGNATURE",
        "compile",
        "func",
        ["exactly one"],
    ),
    (
        "filter",
        "syntax error",
        "Filter",
        [F],
        dict(func="def apply(row)\n    return True"),
        "PYTHON_SYNTAX",
        "compile",
        "func",
        [],
    ),
    (
        "filter",
        "missing import",
        "Filter",
        [F],
        dict(func="import no_such_pkg_xyz\ndef apply(row):\n    return True"),
        "PYTHON_IMPORT",
        "execute",
        "func",
        ["no_such_pkg_xyz"],
    ),
    # map ------------------------------------------------------------------
    (
        "map",
        "reads missing column",
        "Map",
        [F],
        dict(func=fn("{**row, 'k': row['nope']}")),
        "MISSING_COLUMN",
        "execute",
        "func",
        ["'nope'"],
    ),
    (
        "map",
        "returns a scalar, not a row",
        "Map",
        [F],
        dict(func=fn("1")),
        "CALLBACK_RETURN_TYPE",
        "contract",
        "func",
        ["must return the new row as a dict", "int"],
    ),
    (
        "map",
        "returns a list cell",
        "Map",
        [F],
        dict(func=fn("{**row, 'k': [1]}")),
        "OUTPUT_VALUE_TYPE",
        "contract",
        "func",
        ["'k'", "list", "scalar cells"],
    ),
    (
        "map",
        "mixes types across rows",
        "Map",
        [F],
        dict(func=fn("{**row, 'k': 1 if row['x'] == 1 else 'a'}")),
        "OUTPUT_VALUE_TYPE",
        "contract",
        "func",
        ["'k'", "mixes types", "row 0", "row 1"],
    ),
    (
        "map",
        "returns different keys per row",
        "Map",
        [F],
        dict(func=fn("{**row, 'k': 1} if row['x'] == 1 else {**row, 'm': 1}")),
        "MAP_SCHEMA",
        "contract",
        "func",
        ["row 1", "same keys"],
    ),
    (
        "map",
        "returns an empty row",
        "Map",
        [F],
        dict(func=fn("{}")),
        "MAP_SCHEMA",
        "contract",
        "func",
        ["at least one"],
    ),
    (
        "map",
        "naive datetime cell",
        "Map",
        [F],
        dict(func="def apply(row):\n    import datetime\n    return {**row, 'k': datetime.datetime(2024, 1, 1)}"),
        "OUTPUT_VALUE_TYPE",
        "contract",
        "func",
        ["'k'", "timezone"],
    ),
    (
        "map",
        "second column reads the first",
        "Map",
        [F],
        dict(func=fn("{**row, 'k': 1, 'm': row['k']}")),
        "MISSING_COLUMN",
        "execute",
        "func",
        ["'k'"],
    ),
    # aggregate ------------------------------------------------------------
    (
        "aggregate",
        "missing group key",
        "Aggregate",
        [F],
        dict(groupBy=["nope"], aggregations=[{"fn": "count", "as": "n"}]),
        "MISSING_COLUMN",
        "execute",
        "groupBy",
        ["'nope'"],
    ),
    (
        "aggregate",
        "missing reducer column",
        "Aggregate",
        [F],
        dict(groupBy=["g"], aggregations=[{"fn": "sum", "as": "s", "col": "nope"}]),
        "MISSING_COLUMN",
        "execute",
        "aggregations",
        ["'nope'"],
    ),
    (
        "aggregate",
        "unknown reducer",
        "Aggregate",
        [F],
        dict(groupBy=["g"], aggregations=[{"fn": "filter_count", "as": "s", "col": "x"}]),
        "AGGREGATE_ARGUMENT",
        "validate",
        None,
        ["Unknown aggregation"],
    ),
    (
        "aggregate",
        "sum of strings",
        "Aggregate",
        [F],
        dict(groupBy=["g"], aggregations=[{"fn": "sum", "as": "s", "col": "y"}]),
        "AGGREGATE_TYPE",
        "execute",
        None,
        ["sum", "'y'", "numeric"],
    ),
    (
        "aggregate",
        "output collides with key",
        "Aggregate",
        [F],
        dict(groupBy=["g"], aggregations=[{"fn": "count", "as": "g"}]),
        "COLUMN_COLLISION",
        "validate",
        None,
        ["unique"],
    ),
    (
        "aggregate",
        "sum without column",
        "Aggregate",
        [F],
        dict(groupBy=["g"], aggregations=[{"fn": "sum", "as": "s"}]),
        "AGGREGATE_ARGUMENT",
        "validate",
        None,
        ["count may omit"],
    ),
    (
        "aggregate",
        "no reducers",
        "Aggregate",
        [F],
        dict(groupBy=["g"], aggregations=[]),
        "AGGREGATE_ARGUMENT",
        "validate",
        None,
        ["at least one"],
    ),
    (
        "aggregate",
        "int64 sum overflows",
        "Aggregate",
        [lambda: pd.DataFrame({"x": pd.Series([9_000_000_000_000_000_000, 9_000_000_000_000_000_000], dtype="Int64")})],
        dict(aggregations=[{"fn": "sum", "as": "s", "col": "x"}]),
        "AGGREGATE_RANGE",
        "execute",
        None,
        ["s"],
    ),
    # join -----------------------------------------------------------------
    (
        "join",
        "missing left key",
        "Join",
        [F, other],
        dict(on=[["nope", "g"]], type="inner"),
        "MISSING_COLUMN",
        "execute",
        "on.left",
        ["'nope'"],
    ),
    (
        "join",
        "missing right key",
        "Join",
        [F, other],
        dict(on=[["g", "nope"]], type="inner"),
        "MISSING_COLUMN",
        "execute",
        "on.right",
        ["'nope'", "'z'"],
    ),
    (
        "join",
        "key type mismatch",
        "Join",
        [F, other],
        dict(on=[["x", "g"]], type="inner"),
        "JOIN_TYPE",
        "execute",
        None,
        ["'x'", "'g'", "int64", "str"],
    ),
    (
        "join",
        "many_to_one violated",
        "Join",
        [F, other],
        dict(on=[["g", "g"]], type="inner", validate="many_to_one"),
        "JOIN_CARDINALITY",
        "contract",
        None,
        ["many_to_one", "duplicate", "'a'"],
    ),
    (
        "join",
        "unknown how",
        "Join",
        [F, other],
        dict(on=[["g", "g"]], type="outer_left"),
        "JOIN_ARGUMENT",
        "validate",
        "how",
        ["'outer_left'", "'inner'"],
    ),
    (
        "join",
        "unknown validate",
        "Join",
        [F, other],
        dict(on=[["g", "g"]], type="inner", validate="unique"),
        "JOIN_ARGUMENT",
        "validate",
        "validate",
        ["'unique'"],
    ),
    (
        "join",
        "cross with keys",
        "Join",
        [F, other],
        dict(on=[["g", "g"]], type="cross"),
        "JOIN_KEYS",
        "validate",
        "on",
        ["Cross join"],
    ),
    (
        "join",
        "equijoin without keys",
        "Join",
        [F, other],
        dict(type="inner"),
        "JOIN_KEYS",
        "validate",
        "on",
        ["never inferred"],
    ),
    (
        "join",
        "one input",
        "Join",
        [F],
        dict(on=[["g", "g"]], type="inner"),
        "INPUT_PORTS",
        "validate",
        None,
        ["2 input"],
    ),
    # union ----------------------------------------------------------------
    (
        "union",
        "different columns",
        "Union",
        [F, other],
        dict(schema="strict"),
        "UNION_SCHEMA",
        "execute",
        "schema",
        ["input 2 lacks", "'x'", 'schema="align"'],
    ),
    (
        "union",
        "type mismatch",
        "Union",
        [F, lambda: frame().assign(x=frame()["x"].astype(str))],
        dict(schema="strict"),
        "UNION_TYPE",
        "execute",
        "schema",
        ["'x'", "int64", "str"],
    ),
    ("union", "one input", "Union", [F], dict(schema="strict"), "INPUT_PORTS", "validate", None, ["two inputs"]),
    (
        "union",
        "unknown schema mode",
        "Union",
        [F, F],
        dict(schema="loose"),
        "UNION_ARGUMENT",
        "validate",
        "schema",
        ["'loose'"],
    ),
    # distinct -------------------------------------------------------------
    (
        "distinct",
        "missing column",
        "Distinct",
        [F],
        dict(columns=["nope"], keep="first"),
        "MISSING_COLUMN",
        "execute",
        "columns",
        ["'nope'"],
    ),
    (
        "distinct",
        "invalid keep",
        "Distinct",
        [F],
        dict(columns=["g"], keep="middle"),
        "DISTINCT_ARGUMENT",
        "validate",
        "keep",
        ["'middle'"],
    ),
    (
        "distinct",
        "column listed twice",
        "Distinct",
        [F],
        dict(columns=["g", "g"], keep="first"),
        "COLUMN_COLLISION",
        "validate",
        "columns",
        ["twice"],
    ),
    # sort -----------------------------------------------------------------
    ("sort", "missing column", "Sort", [F], dict(by=[{"col": "nope"}]), "MISSING_COLUMN", "execute", "by", ["'nope'"]),
    ("sort", "empty by", "Sort", [F], dict(by=[]), "SORT_ARGUMENT", "validate", "by", ["at least one"]),
    (
        "sort",
        "invalid nulls",
        "Sort",
        [F],
        dict(by=[{"col": "x"}], nulls="middle"),
        "SORT_ARGUMENT",
        "validate",
        "nulls",
        ["'middle'"],
    ),
    (
        "sort",
        "mixed-type input column",
        "Sort",
        [mixed],
        dict(by=[{"col": "mix"}]),
        "INPUT_VALUE_TYPE",
        "contract",
        "inputs[0]",
        ["'mix'"],
    ),
    # limit ----------------------------------------------------------------
    ("limit", "zero n", "Limit", [F], dict(n=0), "LIMIT_ARGUMENT", "validate", "n", [">= 1", "0"]),
    ("limit", "negative n", "Limit", [F], dict(n=-1), "LIMIT_ARGUMENT", "validate", "n", ["-1"]),
    ("limit", "negative offset", "Limit", [F], dict(n=2, offset=-3), "LIMIT_ARGUMENT", "validate", "offset", ["-3"]),
    # window ---------------------------------------------------------------
    (
        "window",
        "missing partition column",
        "Window",
        [F],
        dict(partitionBy=["nope"], orderBy=[{"col": "x"}], columns=[{"fn": "row_number", "as": "rn"}]),
        "MISSING_COLUMN",
        "execute",
        "partitionBy",
        ["'nope'"],
    ),
    (
        "window",
        "missing order column",
        "Window",
        [F],
        dict(partitionBy=["g"], orderBy=[{"col": "nope"}], columns=[{"fn": "row_number", "as": "rn"}]),
        "MISSING_COLUMN",
        "execute",
        "orderBy",
        ["'nope'"],
    ),
    (
        "window",
        "lag on missing column",
        "Window",
        [F],
        dict(partitionBy=["g"], orderBy=[{"col": "x"}], columns=[{"fn": "lag", "as": "p", "col": "nope", "offset": 1}]),
        "MISSING_COLUMN",
        "execute",
        "columns[0].col",
        ["'nope'"],
    ),
    (
        "window",
        "reducer as window function",
        "Window",
        [F],
        dict(partitionBy=["g"], orderBy=[{"col": "x"}], columns=[{"fn": "sum", "as": "s", "col": "x"}]),
        "WINDOW_ARGUMENT",
        "validate",
        "columns[0]",
        ["lag/lead", "row_number/rank/dense_rank"],
    ),
    (
        "window",
        "duplicate output names",
        "Window",
        [F],
        dict(partitionBy=["g"], orderBy=[{"col": "x"}], columns=[{"fn": "row_number", "as": "rn"}, {"fn": "rank", "as": "rn"}]),
        "COLUMN_COLLISION",
        "validate",
        "columns",
        ["unique"],
    ),
    (
        "window",
        "no order_by",
        "Window",
        [F],
        dict(partitionBy=["g"], orderBy=[], columns=[{"fn": "rank", "as": "rk"}]),
        "WINDOW_ARGUMENT",
        "validate",
        None,
        ["orderBy"],
    ),
    (
        "window",
        "negative lag offset",
        "Window",
        [F],
        dict(partitionBy=["g"], orderBy=[{"col": "x"}], columns=[{"fn": "lag", "as": "p", "col": "x", "offset": -1}]),
        "WINDOW_ARGUMENT",
        "validate",
        "columns[0]",
        ["positive offset"],
    ),
    (
        "window",
        "lag without column",
        "Window",
        [F],
        dict(partitionBy=["g"], orderBy=[{"col": "x"}], columns=[{"fn": "lag", "as": "p", "offset": 1}]),
        "WINDOW_ARGUMENT",
        "validate",
        "columns[0]",
        ["require col"],
    ),
    (
        "window",
        "duplicate outputs",
        "Window",
        [F],
        dict(
            partitionBy=["g"],
            orderBy=[{"col": "x"}],
            columns=[{"fn": "rank", "as": "r"}, {"fn": "dense_rank", "as": "r"}],
        ),
        "COLUMN_COLLISION",
        "validate",
        "columns",
        ["unique"],
    ),
    # unpivot --------------------------------------------------------------
    (
        "unpivot",
        "missing column",
        "Unpivot",
        [F],
        dict(columns=["nope"], nameColumn="k", valueColumn="v"),
        "MISSING_COLUMN",
        "execute",
        "columns",
        ["'nope'"],
    ),
    (
        "unpivot",
        "name and value share a name",
        "Unpivot",
        [F],
        dict(columns=["x"], nameColumn="same", valueColumn="same"),
        "COLUMN_COLLISION",
        "execute",
        "nameColumn/valueColumn",
        ["unique"],
    ),
    (
        "unpivot",
        "mixed value types",
        "Unpivot",
        [F],
        dict(columns=["x", "y"], nameColumn="k", valueColumn="v"),
        "UNPIVOT_TYPE",
        "execute",
        None,
        ["int64", "str"],
    ),
    (
        "unpivot",
        "no columns",
        "Unpivot",
        [F],
        dict(columns=[], nameColumn="k", valueColumn="v"),
        "UNPIVOT_ARGUMENT",
        "validate",
        "columns",
        ["nonempty"],
    ),
    # pivot ----------------------------------------------------------------
    (
        "pivot",
        "missing column",
        "Pivot",
        [F],
        dict(index=["g"], columns="nope", values="x"),
        "MISSING_COLUMN",
        "execute",
        "index/columns/values",
        ["'nope'"],
    ),
    (
        "pivot",
        "same column twice",
        "Pivot",
        [F],
        dict(index=["g"], columns="g", values="x"),
        "PIVOT_ARGUMENT",
        "validate",
        None,
        ["distinct"],
    ),
    (
        "pivot",
        "null key",
        "Pivot",
        [F],
        dict(index=["g"], columns="y", values="x"),
        "PIVOT_NULL_KEY",
        "execute",
        None,
        ["'y'", "row 2"],
    ),
    (
        "pivot",
        "duplicate pairs",
        "Pivot",
        [lambda: pd.DataFrame({"g": ["a", "a"], "k": ["p", "p"], "v": [1, 2]})],
        dict(index=["g"], columns="k", values="v"),
        "PIVOT_DUPLICATE",
        "execute",
        None,
        [],
    ),
    (
        "pivot",
        "key collides with index name",
        "Pivot",
        [lambda: pd.DataFrame({"g": ["a", "b"], "k": ["g", "g"], "v": [1, 2]})],
        dict(index=["g"], columns="k", values="v"),
        "COLUMN_COLLISION",
        "execute",
        None,
        ["'g'"],
    ),
    # process --------------------------------------------------------------
    (
        "process",
        "returns a list",
        "Process",
        [F],
        process("[1]"),
        "PROCESS_RETURN_TYPE",
        "contract",
        None,
        ["DataFrame", "list"],
    ),
    ("process", "returns None", "Process", [F], process("None"), "PROCESS_RETURN_TYPE", "contract", None, ["NoneType"]),
    (
        "process",
        "duplicate output columns",
        "Process",
        [F],
        process("pd.DataFrame([[1, 2]], columns=['a', 'a'])"),
        "OUTPUT_SCHEMA",
        "contract",
        None,
        ["unique string"],
    ),
    (
        "process",
        "non-string column name",
        "Process",
        [F],
        process("pd.DataFrame({0: [1]})"),
        "OUTPUT_SCHEMA",
        "contract",
        None,
        ["string"],
    ),
    (
        "process",
        "nested cell",
        "Process",
        [F],
        process("pd.DataFrame({'a': [[1, 2]]})"),
        "OUTPUT_VALUE_TYPE",
        "contract",
        None,
        ["'a'", "JSON strings"],
    ),
    (
        "process",
        "dict cell",
        "Process",
        [F],
        process("pd.DataFrame({'a': [{'k': 1}]})"),
        "OUTPUT_VALUE_TYPE",
        "contract",
        None,
        ["'a'"],
    ),
    (
        "process",
        "infinity",
        "Process",
        [F],
        process("pd.DataFrame({'a': [float('inf')]})"),
        "OUTPUT_VALUE_TYPE",
        "contract",
        None,
        ["infinity"],
    ),
    (
        "process",
        "timezone-naive datetime",
        "Process",
        [F],
        process("pd.DataFrame({'a': [pd.Timestamp('2024-01-01')]})"),
        "OUTPUT_VALUE_TYPE",
        "contract",
        None,
        ["timezone-naive", "tz_localize"],
    ),
    (
        "process",
        "wrong arity",
        "Process",
        [F],
        {"code": "def process(a, b):\n    return a", "entry": "process"},
        "CALLBACK_SIGNATURE",
        "compile",
        "code",
        ["1 positional"],
    ),
    (
        "process",
        "raises",
        "Process",
        [F],
        {"code": "def process(t):\n    return t['nope']", "entry": "process"},
        "CALLBACK_RUNTIME",
        "execute",
        "code",
        ["KeyError", "'nope'"],
    ),
    # runtime envelope --------------------------------------------------------
    (
        "envelope",
        "operator id not an identifier",
        "Limit",
        [F],
        dict(n=1, __id="1bad"),
        "OPERATOR_ID",
        "validate",
        None,
        ["'1bad'"],
    ),
    (
        "envelope",
        "input with duplicate columns",
        "Limit",
        [lambda: pd.DataFrame([[1, 2]], columns=["a", "a"])],
        dict(n=1),
        "INPUT_SCHEMA",
        "contract",
        "inputs[0]",
        ["Repair the producing", "unique string"],
    ),
    ("envelope", "unknown operator type", "Nope", [F], dict(), "OPERATOR_UNAVAILABLE", "validate", None, ["'Nope'"]),
]

# Legitimate programs that must NOT raise: the same shapes, the right way.
LEGAL = [
    (
        "map",
        "keeps the input columns and adds one",
        "Map",
        [F],
        dict(func=fn("{**row, 'k': None if row['x'] is None else row['x'] * 2}")),
    ),
    (
        "map",
        "drops and renames by returning only some keys",
        "Map",
        [F],
        dict(func=fn("{'g': row['g'], 'twice': row['x'] * 2}")),
    ),
    ("map", "an all-None new column is typed str", "Map", [F], dict(func=fn("{**row, 'k': None}"))),
    ("filter", "a None verdict drops the row", "Filter", [F], dict(func=fn("None if row['y'] is None else True"))),
    (
        "aggregate",
        "count of a column without by",
        "Aggregate",
        [F],
        dict(aggregations=[{"fn": "count", "as": "n", "col": "y"}]),
    ),
    ("join", "non-key collision gets the default suffix", "Join", [F, F], dict(on=[["g", "g"]], type="inner")),
    (
        "pivot",
        "numeric keys become string column names",
        "Pivot",
        [lambda: pd.DataFrame({"g": ["a", "b"], "k": [1, 2], "v": [1, 2]})],
        dict(index=["g"], columns="k", values="v"),
    ),
    ("process", "empty frame without columns", "Process", [F], process("pd.DataFrame()")),
    (
        "process",
        "UTC datetimes",
        "Process",
        [F],
        process("pd.DataFrame({'a': [pd.Timestamp('2024-01-01', tz='UTC')]})"),
    ),
    ("limit", "offset past the end is an empty table", "Limit", [F], dict(n=2, offset=10)),
]


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    root = tmp_path_factory.mktemp("scan")
    (root / "dup.csv").write_text("a,b,a\n1,2,3\n")
    (root / "ok.csv").write_text("x,y\n1,p\n2,q\n")
    (root / "blob.npz").write_bytes(b"\x00\x01\x02")
    return {
        "__dup__": str(root / "dup.csv"),
        "__ok__": str(root / "ok.csv"),
        "__bin__": str(root / "blob.npz"),
        "__missing__/nope.csv": str(root / "nope.csv"),
    }


def _run(kind, frames, props, files):
    props = dict(props)
    operator_id = props.pop("__id", "op")
    if "files" in props:
        props["files"] = files.get(props["files"], props["files"])
    definition = spec(kind, [f"in{i}" for i in range(len(frames))], **props)
    definition["id"] = operator_id
    return runtime.execute_native(definition, [f() for f in frames])


@pytest.mark.parametrize(
    "op,case,kind,frames,props,code,stage,field,fragments", CASES, ids=[f"{c[0]}:{c[1]}" for c in CASES]
)
def test_every_failure_case_has_its_code_field_and_cause(
    op, case, kind, frames, props, code, stage, field, fragments, files
):
    with pytest.raises(runtime.NativeError) as failure:
        _run(kind, frames, props, files)
    diagnostic = failure.value.diagnostic
    assert diagnostic["code"] == code, diagnostic
    assert diagnostic["stage"] == stage, diagnostic
    if field is not None:
        assert diagnostic["field"] == field, diagnostic
    for fragment in fragments:
        assert fragment in diagnostic["message"], (fragment, diagnostic["message"])
    assert 0 < len(diagnostic["message"]) <= 320


@pytest.mark.parametrize("op,case,kind,frames,props", LEGAL, ids=[f"{c[0]}:{c[1]}" for c in LEGAL])
def test_legitimate_shapes_execute(op, case, kind, frames, props, files):
    result = _run(kind, frames, props, files)
    assert isinstance(result, pd.DataFrame)


UNREACHABLE = {
    "ROW_CONTRACT",  # a row-preserving operator changing its row count would be a runtime bug
    "INPUT_TABLE_TYPE",  # requires a non-DataFrame input from the engine
}


def test_every_runtime_code_is_exercised():
    tree = ast.parse(Path(RUNTIME).read_text())
    raised = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "_error" and len(node.args) > 1:
            if isinstance(node.args[1], ast.Constant):
                raised.add(node.args[1].value)
    raised |= set(re.findall(r'"(INPUT_[A-Z_]+)"', Path(RUNTIME).read_text()))
    covered = {c[5] for c in CASES}
    missing = raised - covered - UNREACHABLE
    assert not missing, f"codes without a taxonomy row: {sorted(missing)}"
    assert not (UNREACHABLE & covered), "a code listed as unreachable is now covered; remove it from UNREACHABLE"
