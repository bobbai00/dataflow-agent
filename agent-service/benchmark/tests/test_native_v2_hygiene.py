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

"""Keys written in several ways, and rounding as pandas does (the dataHygiene and pandasRound settings)."""

import importlib.util
from pathlib import Path

import pandas as pd

from test_native_v2_runtime import runtime, spec

REGISTERED = Path(__file__).resolve().parents[2] / "src/agent/native/python/registered.py"
REGISTERED_SPEC = importlib.util.spec_from_file_location("native_v2_registered", REGISTERED)
registered = importlib.util.module_from_spec(REGISTERED_SPEC)
REGISTERED_SPEC.loader.exec_module(registered)


def operations(frame):
    return frame.attrs["native_v2"]["operations"]


def test_group_keys_written_in_several_ways_are_reported_with_their_row_counts():
    # prepbench-hard-298: "Beauty " (trailing space) became a sixth category.
    frame = pd.DataFrame({
        "Category": ["Beauty"] * 4 + ["Beauty "] + ["Toys"] * 3 + ["NEW YORK", "New York"],
        "sales": list(range(10)),
    })
    aggregate = spec("Aggregate", groupBy=["Category"], aggregations=[{"fn": "sum", "col": "sales", "as": "total"}])
    found = operations(runtime.execute_native(aggregate, [frame]))["keyVariants"]
    assert found == [{
        "column": "Category",
        "values": 2,
        "examples": [
            {"forms": ["Beauty", "Beauty "], "rows": [4, 1]},
            {"forms": ["NEW YORK", "New York"], "rows": [1, 1]},
        ],
    }]
    # Values that differ in their words, or in a sign at their edge, are distinct values.
    distinct = pd.DataFrame({"Category": ["A+", "A-", "Beauty", "Beautiful"], "sales": [1, 2, 3, 4]})
    assert "keyVariants" not in operations(runtime.execute_native(aggregate, [distinct]))
    # Numeric keys are not text keys.
    numbers = pd.DataFrame({"Category": [1, 1, 2], "sales": [1, 2, 3]})
    assert "keyVariants" not in operations(runtime.execute_native(aggregate, [numbers]))


def test_partition_keys_written_in_several_ways_are_reported():
    # prepbench-hard-120: "New York" and "New York  " ranked as separate destinations.
    frame = pd.DataFrame({"Destination": ["New York", "New York  ", "Boston"] * 2, "price": [3, 1, 2, 6, 5, 4]})
    window = spec("Window", partitionBy=["Destination"], orderBy=[{"col": "price"}],
                  columns=[{"fn": "rank", "as": "rank"}])
    found = operations(runtime.execute_native(window, [frame]))["keyVariants"]
    assert found[0]["column"] == "Destination" and found[0]["examples"][0]["forms"] == ["New York", "New York  "]


def test_pandas_round_matches_series_round_on_float_ties():
    # prepbench-hard-155: 15/1000 is 0.015, stored as 0.01499...; pandas rounds it to 0.02.
    for value in [0.015, 2.675, 1.005, -0.125, 12.5, 3.14159]:
        assert registered._pandas_round(value, 2) == pd.Series([value]).round(2)[0]
    assert round(0.015, 2) == 0.01 and registered._pandas_round(0.015, 2) == 0.02
    # Without ndigits, and for integers, rounding is Python's.
    assert registered._pandas_round(2.5) == 2 and isinstance(registered._pandas_round(2.5), int)
    assert registered._pandas_round(1234, -2) == 1200
    assert registered._pandas_round(float("nan"), 2) != registered._pandas_round(float("nan"), 2)


def test_a_lambda_rounds_as_pandas_only_with_the_setting():
    lambda_spec = lambda flag: {
        "id": "pct",
        "type": "Map",
        "properties": {"registered": {"cells": [], "lambda": "lambda row: round(row['x'], 2)", "names": [], "settings": {}}},
        **({"pandasRound": True} if flag else {}),
    }
    assert registered.registered_callable(lambda_spec(False))({"x": 0.015}) == 0.01
    assert registered.registered_callable(lambda_spec(True))({"x": 0.015}) == 0.02
    # A definition's own round is left alone.
    own = lambda_spec(True)
    own["properties"]["registered"]["cells"] = ["def round(x, n):\n    return 'own'"]
    assert registered.registered_callable(own)({"x": 0.015}) == "own"
