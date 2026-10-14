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

"""Runtime stats: copies across files, dedupes that drop non-duplicates, rows marked as excluded, and the same
mistakes inside Python steps (keys that match only once written alike, files read by hand, repeated header columns)."""

import importlib.util
from pathlib import Path

import pandas as pd


RUNTIME = Path(__file__).resolve().parents[2] / "src/agent/native/python/runtime.py"
MODULE_SPEC = importlib.util.spec_from_file_location("native_v2_runtime_stats", RUNTIME)
runtime = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(runtime)


def spec(kind, inputs=("source",), lineage=None, **properties):
    result = {"id": "candidate", "revision": "r-test", "version": "v2", "type": kind,
              "inputs": [] if kind == "Scan" else list(inputs), "properties": properties, "profileCollection": True}
    if lineage is not None:
        result["lineage"] = lineage
    return result


def operations(frame):
    return frame.attrs["native_v2"]["operations"]


def state_files(tmp_path):
    """Three state files: a two-state metro area is listed in two of them; the header and footer are in all."""
    rows = {
        "Georgia": [("Atlanta, GA Metropolitan Statistical Area", "1,000"), ("Columbus, GA-AL Metropolitan Statistical Area", "1,302")],
        "Alabama": [("Birmingham, AL Metropolitan Statistical Area", "800"), ("Columbus, GA-AL Metropolitan Statistical Area", "1,302")],
        "Maine": [("Portland, ME Metropolitan Statistical Area", "300")],
    }
    for state, records in rows.items():
        lines = ["Metropolitan Area,# of Reports"] + [f'"{area}","{count}"' for area, count in records] + ["Source: FTC,"]
        (tmp_path / f"{state}.csv").write_text("\n".join(lines) + "\n")
    return str(tmp_path / "*.csv")


def test_a_multi_file_scan_reports_records_listed_by_several_files(tmp_path):
    scan = runtime.execute_native(spec("Scan", files=state_files(tmp_path), allText=True), [])
    copies = operations(scan)["fileCopies"]
    assert (copies["rows"], copies["records"], copies["files"]) == (2, 1, 3)
    assert copies["example"].startswith("Columbus, GA-AL")
    assert sorted(copies["exampleFiles"]) == ["Alabama.csv", "Georgia.csv"]
    # One file alone has nothing to compare.
    single = runtime.execute_native(spec("Scan", files=str(tmp_path / "Maine.csv")), [])
    assert "fileCopies" not in operations(single)


def test_an_aggregate_over_copies_reports_what_counting_each_record_once_gives():
    rows = pd.DataFrame({"area": ["Columbus", "Columbus", "Atlanta"], "reports": [1302, 1302, 1000]})
    aggregate = spec("Aggregate", lineage={"multiSource": True, "provenanceColumns": []}, groupBy=[],
                     aggregations=[{"fn": "sum", "col": "reports", "as": "total"}])
    copies = operations(runtime.execute_native(aggregate, [rows]))["copiesInput"]
    assert (copies["rows"], copies["records"], copies["maxCopies"]) == (2, 1, 2)
    assert copies["change"] == {"outputs": [{"output": "total", "now": 3604, "then": 2302}]}
    # One source: identical rows are that source's own observations.
    single = {**aggregate, "lineage": {"multiSource": False, "provenanceColumns": []}}
    assert "copiesInput" not in operations(runtime.execute_native(single, [rows]))
    # A max does not change when copies are counted once, so nothing is reported.
    maximum = {**aggregate, "properties": {"groupBy": [], "aggregations": [{"fn": "max", "col": "reports", "as": "top"}]}}
    assert "copiesInput" not in operations(runtime.execute_native(maximum, [rows]))


def test_a_dedupe_that_drops_different_records_is_reported_and_exact_duplicates_are_not():
    stations = pd.DataFrame({
        "NWS ID": ["051506", "051506", "045421", "045421", None, None, None],
        "Station Name": ["THE CROWN", "HANGMAN", "LOLO", "LOLO", "A", "B", "C"],
        "Elevation": [8382, 7834, 3200, 3200, 1, 2, 3],
    })
    result = runtime.execute_native(spec("Distinct", columns=["NWS ID"], keep="first"), [stations])
    found = operations(result)["dedupeDifferences"]
    assert (found["removed"], found["differ"], found["emptyKeyRemoved"]) == (4, 1, 2)
    assert found["examples"][0]["key"] == ["051506"]
    assert found["examples"][0]["values"]["Station Name"] == ["THE CROWN", "HANGMAN"]
    # Copies of one record that differ only in a shared label (the file a row came from) are duplicates.
    copies = pd.DataFrame({"area": ["Columbus"] * 2 + [f"a{i}" for i in range(8)],
                           "reports": [1302, 1302] + list(range(8)),
                           "state": ["Alabama", "Georgia"] + ["Alabama"] * 8})
    plain = runtime.execute_native(spec("Distinct", columns=["area"], keep="first"), [copies])
    assert "dedupeDifferences" not in operations(plain)


def test_rows_marked_as_excluded_are_reported_where_a_result_reads_them_or_the_mark_is_dropped():
    cases = pd.DataFrame({"case": ["C3L-01247", "C3N-01825_replication", "S1", "S2", "S3"],
                          "Case_excluded": ["Yes", "Yes", "No", "No", "No"],
                          "value": [0.58, None, 2.6, 2.7, 2.65]})
    median = spec("Aggregate", groupBy=[], aggregations=[{"fn": "median", "col": "value", "as": "median"}])
    excluded = operations(runtime.execute_native(median, [cases]))["excludedInput"]
    assert (excluded["column"], excluded["mark"], excluded["rows"]) == ("Case_excluded", "Yes", 2)
    assert excluded["examples"] == ["C3L-01247", "C3N-01825_replication"]
    assert excluded["change"] == {"outputs": [{"output": "median", "now": 2.625, "then": 2.65}]}
    dropped = operations(runtime.execute_native(spec("Project", keep=["case", "value"]), [cases]))["excludedDropped"]
    assert (dropped["column"], dropped["rows"]) == ("Case_excluded", 2)
    # A column named like a mark but holding many values is not one.
    many = cases.assign(Case_excluded=[f"reason {i}" for i in range(5)])
    assert "excludedInput" not in operations(runtime.execute_native(median, [many]))


def test_python_steps_report_near_miss_keys_dedupes_files_read_by_hand_and_unread_twin_columns(tmp_path):
    pattern = state_files(tmp_path)
    sheet = tmp_path / "sheets" / "wollaston.csv"
    sheet.parent.mkdir()
    sheet.write_text("Wollaston Beach,,,,,\n,Milton Road,,Rice Road,,\nDate,Tag,Enterococcus,Tag,Enterococcus,Rain\n"
                     "2024-09-01,<,10,<,20,0\n2024-09-02,,30,<,10,1\n")
    code = f'''
def load():
    import csv, glob
    import pandas as pd
    rows = []
    for path in sorted(glob.glob({pattern!r})):
        with open(path, newline="") as handle:
            for record in csv.reader(handle):
                if "Statistical Area" in record[0]:
                    rows.append({{"area": record[0], "reports": record[1], "state": path}})
    table = pd.DataFrame(rows)
    table["key"] = table["area"].str.lower().str.replace(" ", "", regex=False)
    lookup = pd.DataFrame({{"key": ["columbus, ga-al metropolitan statistical area"], "pop": [5]}})
    joined = table.merge(lookup, on="key", how="left")
    joined["pop2"] = joined["key"].map(dict(zip(lookup["key"], lookup["pop"])))
    sheet = pd.read_csv({str(sheet)!r}, header=None, dtype=str)
    values = [row.iloc[2] for _, row in sheet.iterrows()]
    return joined.assign(n=len(values))
'''
    result = runtime.execute_native(spec("Process", inputs=(), code=code, entry="load"), [])
    events = operations(result)["process"]["events"]
    issues = {(e["op"], e["issue"]): e for e in events}
    merge = issues[("merge", "near-miss keys")]
    assert merge["near"] == 1 and merge["pairs"] == [["columbus,ga-almetropolitanstatisticalarea",
                                                      "columbus, ga-al metropolitan statistical area"]]
    assert issues[("map", "near-miss keys")]["near"] == 1
    copies = issues[("read", "copies")]
    assert (copies["records"], copies["files"]) == (1, 3) and sorted(copies["exampleFiles"]) == ["Alabama.csv", "Georgia.csv"]
    twins = issues[("read", "unread twins")]
    assert (twins["label"], twins["positions"], twins["read"], twins["unread"]) == ("Enterococcus", [2, 4], [2], [4])
    # A dedupe inside the step that drops a different record is reported like the built-in one.
    code_dedupe = '''
def process(frame):
    return frame.drop_duplicates(subset=["id"], keep="first")
'''
    frame = pd.DataFrame({"id": ["a", "a", "b"], "name": ["THE CROWN", "HANGMAN", "X"], "elev": [1, 2, 3]})
    deduped = runtime.execute_native(spec("Process", code=code_dedupe, entry="process"), [frame])
    event = operations(deduped)["process"]["events"][0]
    assert (event["op"], event["issue"], event["differ"]) == ("dedupe", "differs", 1)
