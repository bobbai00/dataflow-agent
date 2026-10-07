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
"""Runtime contracts for shared-function settings and ordered limits."""
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "agent" / "native" / "python"))
import runtime  # noqa: E402

SCORE = '''def score(t, weight=1.0, minimum=0):
    """Scores with weight {weight}."""
    out = t.copy()
    out["score"] = out["x"] * weight
    return out[out["x"] >= minimum]'''


def frame():
    return pd.DataFrame({"unit": ["a", "b", "c", "d"], "x": [3, 1, 2, 2]})


def spec(kind, **props):
    return {"id": "op", "revision": "r", "type": kind, "inputs": ["t"], "properties": props}


def test_a_shared_call_passes_its_settings_by_name():
    out = runtime.execute_native(spec("Process", code=SCORE, entry="score", doc="d", params={"weight": 2.0, "minimum": 2}, shared=True), [frame()])
    assert out["unit"].tolist() == ["a", "c", "d"]
    assert out["score"].tolist() == [6.0, 4.0, 4.0]


def test_defaults_fill_settings_that_are_not_passed():
    out = runtime.execute_native(spec("Process", code=SCORE, entry="score", doc="d", params={}, shared=True), [frame()])
    assert out["score"].tolist() == [3.0, 1.0, 2.0, 2.0]


def test_a_setting_the_function_lacks_is_a_signature_error():
    with pytest.raises(runtime.NativeError) as failure:
        runtime.execute_native(spec("Process", code=SCORE, entry="score", doc="d", params={"cap": 1}, shared=True), [frame()])
    assert failure.value.diagnostic["code"] == "CALLBACK_SIGNATURE"
    assert "setting" in failure.value.diagnostic["message"]


def test_a_plain_process_still_rejects_defaults():
    with pytest.raises(runtime.NativeError) as failure:
        runtime.execute_native(spec("Process", code=SCORE, entry="score", doc="d"), [frame()])
    assert failure.value.diagnostic["code"] == "CALLBACK_SIGNATURE"


def test_limit_by_keeps_the_top_rows_in_stable_key_order():
    out = runtime.execute_native(spec("Limit", n=3, by=[{"col": "x", "desc": True}, {"col": "unit"}]), [frame()])
    assert out["unit"].tolist() == ["a", "c", "d"]
    assert runtime.execute_native(spec("Limit", n=2), [frame()])["unit"].tolist() == ["a", "b"]


def test_limit_by_needs_named_keys():
    with pytest.raises(runtime.NativeError) as failure:
        runtime.execute_native(spec("Limit", n=1, by=[{"desc": True}]), [frame()])
    assert failure.value.diagnostic["code"] == "LIMIT_ARGUMENT"


def test_an_unclosed_bracket_or_string_names_the_line_where_it_opens():
    from graph_parser import parse_graph_edit
    bracket = parse_graph_edit('x = scan("a.csv")\ny = limit(x, 3,\n    by=[("a", "desc")]\nz = limit(y, 1)\n')
    assert bracket == {"ok": False, "error": "Line 2: this bracket is never closed, so the edit ends inside "
                       "the statement; close every (, [ and { before the next statement."}
    docstring = parse_graph_edit('def f(t):\n    """Rows kept.\n    return t\nx = f(y)\n')
    assert docstring["error"].startswith("Line 2: this string is never closed")
