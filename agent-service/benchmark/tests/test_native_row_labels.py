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

"""Row labels as pandas keeps them. A process function written with pandas
habits aligns tables by index; survey-2022 task 1 turn 2 selected
`full.loc[cleaned.index]` and, with every table renumbered from 0, took the
first 22,296 raw rows instead of the cleaned respondents."""
import pandas as pd

from test_native_v2_relational import execute, rows
from test_native_v2_runtime import runtime

LABEL = runtime.ROW_LABEL


def keep(expression):
    return dict(func=f"def apply(row):\n    return {expression}", entry="apply")


def labels(frame):
    return frame[LABEL].tolist() if LABEL in frame.columns else list(range(len(frame)))


def process(code, *frames, **properties):
    return execute("Process", *frames, code=code, entry="process", **properties)


FULL = pd.DataFrame({"id": [10, 11, 12, 13, 14], "country": ["IN", None, "US", "IN", "US"], "q": [1, 2, 3, 4, 5]})


def test_filter_keeps_labels_and_a_function_sees_them_as_the_index():
    cleaned = execute("Filter", FULL, **keep("row['country'] is not None"))
    assert labels(cleaned) == [0, 2, 3, 4]
    assert rows(cleaned) == [{"id": i, "country": c, "q": q} for i, c, q in [(10, "IN", 1), (12, "US", 3), (13, "IN", 4), (14, "US", 5)]]
    code = "def process(full, cleaned):\n    return full.loc[cleaned.index, ['id']]"
    picked = process(code, FULL, cleaned)
    assert rows(picked) == [{"id": 10}, {"id": 12}, {"id": 13}, {"id": 14}]
    assert labels(picked) == [0, 2, 3, 4]
    # The same code under pandas gives the same rows.
    expected = FULL.loc[FULL[FULL["country"].notna()].index, ["id"]]
    assert rows(picked) == rows(expected.reset_index(drop=True))


def test_labels_follow_sort_distinct_and_limit_and_pass_through_row_preserving_operators():
    cleaned = execute("Filter", FULL, **keep("row['country'] is not None"))
    ordered = execute("Sort", cleaned, by=[{"col": "q", "desc": True}])
    assert labels(ordered) == [4, 3, 2, 0]
    top = execute("Limit", ordered, n=2)
    assert labels(top) == [4, 3]
    unique = execute("Distinct", cleaned, columns=["country"])
    assert labels(unique) == [0, 2]
    mapped = execute("Map", cleaned, func="def apply(row):\n    return {**row, 'double': row['q'] * 2}", entry="apply")
    assert labels(mapped) == [0, 2, 3, 4] and "double" in mapped.columns
    projected = execute("Project", mapped, keep=["id"])
    assert labels(projected) == [0, 2, 3, 4]


def test_operators_that_build_new_rows_number_from_zero():
    cleaned = execute("Filter", FULL, **keep("row['country'] is not None"))
    grouped = execute("Aggregate", cleaned, groupBy=["country"], aggregations=[{"fn": "count", "as": "n"}])
    assert LABEL not in grouped.columns
    joined = execute("Join", cleaned, FULL, on=["id"], type="inner")
    assert LABEL not in joined.columns and not any(name.startswith(LABEL) for name in joined.columns)
    unioned = execute("Union", cleaned, cleaned, schema="strict")
    assert LABEL not in unioned.columns and len(unioned) == 8


def test_contiguous_labels_are_not_stored():
    everything = execute("Filter", FULL, **keep("True"))
    assert LABEL not in everything.columns
    head = execute("Limit", FULL, n=3)
    assert LABEL not in head.columns


def test_a_function_keeps_the_index_it_returns():
    kept = process("def process(full):\n    return full[full['q'] > 2]", FULL)
    assert labels(kept) == [2, 3, 4]
    renumbered = process("def process(full):\n    return full[full['q'] > 2].reset_index(drop=True)", FULL)
    assert LABEL not in renumbered.columns
    # A groupby that was not reset keeps its keys as columns, as reset_index() would.
    counts = process("def process(full):\n    return full.groupby('country').size().to_frame('n')", FULL)
    assert rows(counts) == [{"country": "IN", "n": 2}, {"country": "US", "n": 2}]
    assert LABEL not in counts.columns


def test_labels_never_reach_an_operator_or_its_whole_row_logic():
    cleaned = execute("Filter", FULL, **keep("row['country'] is not None"))
    seen = process("def process(cleaned):\n    return cleaned.assign(columns=','.join(cleaned.columns))", cleaned)
    assert set(seen["columns"]) == {"id,country,q"}
    twice = execute("Union", cleaned, execute("Filter", FULL, **keep("row['q'] != 1")), schema="strict")
    deduped = execute("Distinct", twice)
    assert len(deduped) == len(FULL.dropna(subset=["country"]).drop_duplicates()) + 1
