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
"""Parser forms for state changes: `name.setting = value`, `name = other`, and
the statement blocks an edit is applied by."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src" / "agent" / "native" / "python"))
from graph_parser import edit_blocks, parse_graph_edit  # noqa: E402


def commands(source):
    result = parse_graph_edit(source)
    assert result["ok"], result
    return result["commands"]


def test_a_setting_assignment_takes_a_literal_value():
    assert commands("scores.rating_weight = 0.6") == [
        dict(operation="set_setting", id="scores", setting="rating_weight", value=0.6, line=1)]
    assert commands('scores.columns = ["a", "b"]')[0]["value"] == ["a", "b"]
    assert "literal value" in parse_graph_edit("scores.weight = rating * 2")["error"]
    for frozen in ("scores@2.weight = 1", "scores@2 .weight = 1"):
        assert parse_graph_edit(frozen)["error"] == ("Line 1: a saved version never changes; set `scores.weight` "
                                                     "on the current table.")


def test_assigning_one_table_to_another_is_a_commit():
    assert commands("top10 = heavy") == [dict(operation="commit", id="top10", other="heavy", line=1)]
    assert "changes nothing" in parse_graph_edit("top10 = top10")["error"]
    assert commands("top10 = top10@3")[0]["operation"] == "assign_version"


def test_edit_blocks_name_what_each_statement_sets_and_uses():
    blocks = edit_blocks('a = scan("x.csv")\ndef f(t, w=1):\n    """Rows of t."""\n    return t\nb = f(a, w=2)\nb.w = 3\ndel c')
    assert [(b["line"], b["sets"]) for b in blocks] == [(1, ["a"]), (2, ["f"]), (5, ["b"]), (6, ["b"]), (7, ["c"])]
    assert "a" in blocks[2]["uses"] and "f" in blocks[2]["uses"]
    # Column names in strings are not uses of tables with the same name.
    assert "a" not in edit_blocks('a = scan("x.csv")\nb = limit(t, 3, by=[("a", "desc")])')[1]["uses"]


def test_edit_blocks_split_an_edit_that_does_not_tokenize():
    blocks = edit_blocks('a = scan("x.csv")\nb = limit(a, 3,\nc = limit(b, 1)')
    assert [b["sets"] for b in blocks] == [["a"], ["b"], ["c"]]
    assert "b" in blocks[2]["uses"]


def test_a_nested_operator_call_becomes_its_own_step():
    hoisted = commands('pairs = distinct(project(social, keep=["country"]), columns=["country"])')
    assert [(c["id"], c["statement"]["op"]) for c in hoisted] == [("pairs__project", "project"), ("pairs", "distinct")]
    assert hoisted[1]["statement"]["args"][0] == {"kind": "name", "name": "pairs__project"}
    deeper = commands("top = limit(sort(filter(t, lambda r: r['x'] > 0, doc='Positive'), by=['x']), 3)")
    assert [c["id"] for c in deeper] == ["top__sort__filter", "top__sort", "top"]
    # Saved versions inside a nested call keep their meaning.
    assert commands("both = union(project(a@2, keep=['k']), b)")[0]["references"] == {"__saved_a__2": "a@2"}


def test_a_function_depends_only_on_the_functions_it_calls():
    blocks = edit_blocks('pairs = scan("p.csv")\ndef score(pairs, weight=1):\n    """Rows of pairs."""\n    return helper(pairs) * weight\nscores = score(pairs)')
    assert blocks[1]["sets"] == ["score"] and blocks[1]["uses"] == ["helper"]
