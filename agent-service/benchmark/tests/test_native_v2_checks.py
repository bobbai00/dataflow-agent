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

"""Checks: each operator's own assumptions, tested on the full tables."""

import pandas as pd

from test_native_v2_runtime import runtime, spec


def operations(frame):
    return frame.attrs["native_v2"]["operations"]


def scan(path, **properties):
    return runtime.execute_native(spec("Scan", files=str(path), **properties), [])


def test_a_skip_past_the_header_reports_the_header_row_above(tmp_path):
    # 2024_CSN_Report_Categories.csv: two title lines, then the header.
    path = tmp_path / "categories.csv"
    path.write_text("Title,,,\n,,,\nRank,Category,# of Reports,Percentage\n1,Credit Bureaus,\"1,353,175\",20.91%\n2,Imposters,\"845,806\",13.07%\n")
    check = operations(scan(path, skipLines=3))["scan"]["sources"][0]["headerCheck"]
    assert check["dataLike"] == ["1", "1,353,175", "20.91%"]
    assert check["suggest"] == {"skipLines": 2, "header": ["Rank", "Category", "# of Reports", "Percentage"]}
    assert "headerCheck" not in operations(scan(path, skipLines=2))["scan"]["sources"][0]


def test_suggested_header_names_match_the_repaired_schema_exactly(tmp_path):
    path = tmp_path / "spaced.csv"
    path.write_text('Title,,,\n,,,\nRank,Category, # of Reports ,Percentage\n1,A,"1,353",20%\n2,B,845,13%\n')
    check = operations(scan(path, skipLines=3))["scan"]["sources"][0]["headerCheck"]
    suggestion = check["suggest"]
    repaired = scan(path, skipLines=suggestion["skipLines"])
    # Hints name columns the agent can reference, including significant spaces.
    assert suggestion["header"] == list(repaired.columns)
    assert suggestion["header"][2] == " # of Reports "


def test_year_headers_and_repeated_header_rows(tmp_path):
    wide = tmp_path / "wide.csv"
    wide.write_text("state,2019,2020\nOhio,1,2\n")
    assert "headerCheck" not in operations(scan(wide))["scan"]["sources"][0]
    stacked = tmp_path / "stacked.csv"
    stacked.write_text("name,value\na,1\nname,value\nb,2\n")
    check = operations(scan(stacked, allText=True))["scan"]["sources"][0]["headerCheck"]
    assert check["repeats"] == 1 and "suggest" not in check


def test_a_blank_title_header_suggests_the_first_full_row(tmp_path):
    path = tmp_path / "beach.csv"
    path.write_text("Wollaston Beach,,\nDate,Site,Count\n2020-01-01,A,3\n")
    check = operations(scan(path))["scan"]["sources"][0]["headerCheck"]
    assert check["blank"] == 2 and check["suggest"] == {"skipLines": 1, "header": ["Date", "Site", "Count"]}


def test_records_repeated_across_sources_reach_the_aggregate(tmp_path):
    frame = pd.DataFrame(
        {
            "source": ["PA.csv", "NJ.csv", "PA.csv", "OH.csv"],
            "area": ["Philadelphia", "Philadelphia", "Pittsburgh", "Columbus"],
            "reports": [28438, 28438, 5000, 7000],
        }
    )
    aggregate = {
        **spec("Aggregate", aggregations=[{"fn": "sum", "col": "reports", "as": "total"}]),
        "lineage": {"multiSource": True, "provenanceColumns": ["source"]},
    }
    repeated = operations(runtime.execute_native(aggregate, [frame]))["repeatedRecords"]
    assert repeated == {
        "rows": 2,
        "of": 4,
        "records": 1,
        "sources": 2,
        "ignoring": ["source"],
        "example": "Philadelphia, 28438",
    }
    # Two rows from one source are that source's data, not a cross-source copy.
    same = frame.assign(source="PA.csv")
    assert "repeatedRecords" not in operations(runtime.execute_native(aggregate, [same]))
    # Without a provenance column a copy cannot be told from a repeated value.
    plain = {**aggregate, "lineage": {"multiSource": True, "provenanceColumns": []}}
    assert "repeatedRecords" not in operations(runtime.execute_native(plain, [frame.drop(columns="source")]))


def test_values_that_repeat_within_a_source_are_observations_not_copies():
    # environment-easy-6: yearly beach samples, (year, type, violation) repeats
    # inside every file; the first version reported 157,419 of 157,420 rows.
    frame = pd.DataFrame(
        {
            "file": ["a.csv"] * 3 + ["b.csv"] * 3,
            "year": [2002] * 6,
            "type": ["Marine"] * 6,
            "violation": ["no", "no", "yes", "no", "no", "yes"],
        }
    )
    aggregate = {
        **spec("Aggregate", aggregations=[{"fn": "count", "as": "n"}]),
        "lineage": {"multiSource": True, "provenanceColumns": ["file"]},
    }
    result = operations(runtime.execute_native(aggregate, [frame]))
    # (2002, Marine, yes) is once in each file; (2002, Marine, no) repeats within each.
    assert result["repeatedRecords"]["rows"] == 2 and result["repeatedRecords"]["records"] == 1


def test_process_trace_sees_reads_empty_selections_fanout_and_duplicate_parts(tmp_path):
    (tmp_path / "a.csv").write_text("k,x\n1,Fresh\n2,Marine\n")
    (tmp_path / "b.csv").write_text("k,x\n1,Fresh\n3,Marine\n")
    code = f"""def load():
    import pandas as pd
    a = pd.read_csv({str(tmp_path / 'a.csv')!r})
    b = pd.read_csv({str(tmp_path / 'b.csv')!r})
    both = pd.concat([a, b])
    fresh = both[both["x"] == "freshwater"]
    lookup = pd.DataFrame({{"k": [1, 1], "y": [5, 6]}})
    wide = a.merge(lookup, on="k", how="left")
    return pd.DataFrame({{"n": [len(fresh), len(wide)]}})
"""
    result = runtime.execute_native({**spec("Process", code=code), "inputs": []}, [])
    trace = operations(result)["process"]
    assert [(r["file"], r["rows"]) for r in trace["reads"]] == [("a.csv", 2), ("b.csv", 2)]
    issues = [(e["line"], e["op"], e["issue"]) for e in trace["events"]]
    # A merge that repeats rows may be intended; only empty results are reported.
    assert issues == [(5, "concat", "duplicates"), (6, "filter", "empty")]
    assert trace["events"][0]["records"] == 1
    # The trace is removed afterwards: pandas is unpatched.
    assert pd.DataFrame.__getitem__.__module__.startswith("pandas")


def test_a_group_key_that_merges_entities_is_named():
    # environment-easy-3: "Beach Name" spans two communities in a few groups.
    names = [f"beach{i}" for i in range(10)]
    frame = pd.DataFrame(
        {
            "Beach Name": names * 2,
            "Community": [f"town{i}" for i in range(10)] + ["other town"] + [f"town{i}" for i in range(1, 10)],
            "samples": list(range(20)),
        }
    )
    aggregate = spec("Aggregate", groupBy=["Beach Name"], aggregations=[{"fn": "sum", "col": "samples", "as": "n"}])
    deps = operations(runtime.execute_native(aggregate, [frame]))["keyDependencies"]
    assert deps == [
        {"column": "Community", "groups": 10, "split": 1, "example": {"key": ["beach0"], "values": ["town0", "other town"]}}
    ]
    # A column that varies within many groups is not an attribute of the key.
    free = frame.assign(Community=[f"t{i % 3}" for i in range(20)])
    assert "keyDependencies" not in operations(runtime.execute_native(aggregate, [free]))
    # One row per group proves nothing either way.
    single = frame.iloc[:10].assign(Community=[f"t{i}" for i in range(10)])
    assert "keyDependencies" not in operations(runtime.execute_native(aggregate, [single]))
    # A missing group-key value in a nullable string column never breaks the split's example.
    keys = names[:5] + [None] + names[6:] + names  # beach0 still spans two towns; one row has no name
    nullable = frame.assign(**{"Beach Name": keys}).astype({"Beach Name": "string", "Community": "string"})
    assert operations(runtime.execute_native(aggregate, [nullable]))["keyDependencies"][0]["column"] == "Community"


def test_a_group_key_split_is_named_only_for_a_column_that_names_entities():
    # environment-easy-6: Organism varies inside (Year, Violation) groups by nature; it names no entity.
    frame = pd.DataFrame({
        "Beach Name": [f"beach{i}" for i in range(30)] * 2,
        "Community": [f"town{i}" for i in range(30)] + ["other town"] + [f"town{i}" for i in range(1, 30)],
        "Organism": ["E. Coli"] * 30 + ["Enterococci"] + ["E. Coli"] * 29,
        "samples": list(range(60)),
    })
    aggregate = spec("Aggregate", groupBy=["Beach Name"], aggregations=[{"fn": "sum", "col": "samples", "as": "n"}])
    assert [d["column"] for d in operations(runtime.execute_native(aggregate, [frame]))["keyDependencies"]] == ["Community"]
