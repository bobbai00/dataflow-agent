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

import pandas as pd
import pytest

from test_native_v2_relational import rows
from test_native_v2_runtime import runtime, spec


def scan(files, **properties):
    return runtime.execute_native(
        spec("Scan", files=str(files) if not isinstance(files, list) else files, **properties), []
    )


def test_csv_raw_window_offsets_comments_blank_lines_and_eof(tmp_path):
    path = tmp_path / "source.csv"
    path.write_text("notes\n# comment\n\nid,value\n1,2\n3,4\n")
    result = scan(path, preview=2, skipLines=4, comment="#")
    assert rows(result) == [
        {"file": "source.csv", "line_no": 4, "record": 4, "line": "1,2"},
        {"file": "source.csv", "line_no": 5, "record": 5, "line": "3,4"},
    ]
    assert result.attrs["native_v2"]["operations"]["scan"]["complete"] is False
    assert rows(scan(path, skipLines=3)) == [{"id": 1, "value": 2}, {"id": 3, "value": 4}]
    empty = scan(path, preview=2, skipLines=100)
    assert empty.empty and list(empty.columns) == ["file", "line_no", "record", "line"]
    assert str(empty["line_no"].dtype) == "Int64"


def test_csv_all_text_preserves_codes_and_null_like_literals(tmp_path):
    path = tmp_path / "codes.csv"
    path.write_text('id,label\n001,NA\n002,NULL\n003,"a,b"\n004,\n')
    assert rows(scan(path, allText=True)) == [
        {"id": "001", "label": "NA"},
        {"id": "002", "label": "NULL"},
        {"id": "003", "label": "a,b"},
        {"id": "004", "label": None},
    ]


def test_csv_duplicate_headers_names_exact_width_and_header_only(tmp_path):
    path = tmp_path / "table.csv"
    path.write_text("a,a\n1,2\n")
    result = scan(path)
    assert rows(result) == [{"a": 1, "a.1": 2}]
    (source,) = result.attrs["native_v2"]["operations"]["scan"]["sources"]
    assert source["renamedHeaders"] == [{"column": 1, "header": "a", "name": "a.1"}]
    path.write_text("1,2\n3,4\n")
    assert rows(scan(path, header=False, names=["x", "y"])) == [{"x": 1, "y": 2}, {"x": 3, "y": 4}]
    with pytest.raises(runtime.NativeError, match="SCAN_NAMES"):
        scan(path, header=False, names=["x"])
    with pytest.raises(runtime.NativeError, match="SCAN_NAMES"):
        scan(path, header=False, names=["x", "x"])
    path.write_text("a,b\n")
    empty = scan(path)
    assert empty.empty and list(empty.columns) == ["a", "b"]


def test_source_identity_survives_equal_basenames_and_glob_dedup(tmp_path):
    paths = []
    for directory, value in [("one", 1), ("two", 2)]:
        folder = tmp_path / directory
        folder.mkdir()
        path = folder / "same.csv"
        path.write_text(f"value\n{value}\n")
        paths.append(str(path))
    result = scan([str(tmp_path / "*/*.csv"), paths[0]], fileColumn="source_file")
    assert rows(result) == [{"value": 1, "source_file": "same.csv"}, {"value": 2, "source_file": "same.csv"}]
    sources = result.attrs["native_v2"]["operations"]["scan"]["sources"]
    assert {source["path"] for source in sources} == set(paths)
    assert all(source["sizeBytes"] > 0 and isinstance(source["mtimeNs"], str) for source in sources)
    with pytest.raises(runtime.NativeError, match="COLUMN_COLLISION"):
        scan(paths, fileColumn="value")


def test_preview_file_caps_and_full_scan_are_reported_separately(tmp_path):
    for index in range(7):
        (tmp_path / f"{index}.csv").write_text(f"value\n{index}\n")
    preview = scan(str(tmp_path / "*.csv"), preview=1)
    facts = preview.attrs["native_v2"]["operations"]["scan"]
    assert len(preview) == 5 and facts["resolvedFiles"] == 7 and facts["omittedFiles"] == 2
    assert facts["complete"] is False
    full = scan(str(tmp_path / "*.csv"))
    assert len(full) == 7 and full.attrs["native_v2"]["operations"]["scan"]["complete"] is True


def test_lines_fwf_whitespace_and_encoding_have_explicit_semantics(tmp_path):
    path = tmp_path / "rows.txt"
    path.write_text("meta\n0123abc\n4567def\n")
    assert rows(scan(path, format="lines", skipLines=1)) == [
        {"line_no": 1, "line": "0123abc"},
        {"line_no": 2, "line": "4567def"},
    ]
    assert rows(
        scan(path, format="fwf", skipLines=1, header=False, names=["code", "label"], widths=[4, 3], allText=True)
    ) == [
        {"code": "0123", "label": "abc"},
        {"code": "4567", "label": "def"},
    ]
    path.write_text("a  b\n1  2\n3    4\n")
    assert rows(scan(path, format="whitespace")) == [{"a": 1, "b": 2}, {"a": 3, "b": 4}]
    path.write_bytes("label\ncafé\n".encode("cp1252"))
    assert rows(scan(path, encoding="cp1252")) == [{"label": "café"}]
    with pytest.raises(runtime.NativeError, match="SCAN_PARSE"):
        scan(path, encoding="utf-8")


@pytest.mark.parametrize(
    "properties",
    [
        {"names": ["x"]},
        {"format": "json", "widths": [4]},
        {"format": "csv", "sheet": 1},
        {"format": "parquet", "skipLines": 1},
        {"format": "lines", "header": False},
        {"format": "whitespace", "delim": ","},
    ],
)
def test_reader_options_cannot_silently_apply_to_the_wrong_format(tmp_path, properties):
    path = tmp_path / "source.csv"
    path.write_text("x\n1\n")
    with pytest.raises(runtime.NativeError, match="SCAN_OPTIONS"):
        scan(path, **properties)


def test_unmatched_glob_and_malformed_csv_fail_instead_of_dropping_data(tmp_path):
    with pytest.raises(runtime.NativeError, match="SCAN_NOT_FOUND"):
        scan(str(tmp_path / "*.missing"))
    path = tmp_path / "malformed.csv"
    path.write_text('a,b\n1,"unterminated\n')
    with pytest.raises(runtime.NativeError, match="SCAN_PARSE"):
        scan(path)


def test_excel_sheets_headers_offsets_and_preview_schema(tmp_path):
    path = tmp_path / "book.xlsx"
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame([["note", None], ["a", "b"], [1, 2], [3, 4]]).to_excel(
            writer, sheet_name="Data", header=False, index=False
        )
        pd.DataFrame([["x", "x"], [5, 6]]).to_excel(writer, sheet_name="Duplicate", header=False, index=False)
    assert rows(scan(path, sheet="Data", skipLines=1)) == [{"a": 1, "b": 2}, {"a": 3, "b": 4}]
    preview = scan(path, preview=1, skipLines=2, sheet="Data")
    assert rows(preview) == [{"sheet": "Data", "row_no": 2, "line": "1 | 2"}]
    assert scan(path, preview=2, skipLines=100).empty
    assert rows(scan(path, sheet="Duplicate")) == [{"x": 5, "x.1": 6}]


def test_html_preview_offsets_and_full_header_validation(tmp_path):
    path = tmp_path / "table.html"
    path.write_text(
        "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>"
    )
    assert rows(scan(path)) == [{"a": 1, "b": 2}, {"a": 3, "b": 4}]
    assert rows(scan(path, preview=1, skipLines=1)) == [{"table": 0, "row_no": 2, "line": "3 | 4"}]
    assert rows(scan(path, preview=1))[0] == {"table": 0, "row_no": 0, "line": "a | b"}
    path.write_text("<table><tr><th>a</th><th>a</th></tr><tr><td>1</td><td>2</td></tr></table>")
    assert rows(scan(path)) == [{"a": 1, "a.1": 2}]


def test_json_parquet_and_binary_previews_do_not_parse_binary_as_text(tmp_path):
    path = tmp_path / "records.jsonl"
    path.write_text('{"a":1,"b":"NA"}\n{"a":2,"b":null}\n')
    assert rows(scan(path)) == [{"a": 1, "b": "NA"}, {"a": 2, "b": None}]
    parquet = tmp_path / "table.parquet"
    pd.DataFrame({"a": pd.Series([1, None], dtype="Int64")}).to_parquet(parquet)
    assert rows(scan(parquet)) == [{"a": 1}, {"a": None}]
    preview = scan(parquet, preview=3)
    assert list(preview.columns) == ["file", "size_bytes", "note"]
    assert len(preview) == 1 and preview["size_bytes"][0] > 0
    with pytest.raises(runtime.NativeError, match="SCAN_OPTIONS"):
        scan(parquet, preview=2, skipLines=1)


def test_utf8_detection_does_not_misclassify_a_multibyte_sample_boundary(tmp_path):
    path = tmp_path / "boundary.txt"
    path.write_bytes(b"a" * ((1 << 22) - 1) + "é\n".encode("utf-8"))
    assert runtime._scan_encoding(path, None) == "utf-8-sig"


def test_json_flattening_must_not_overwrite_a_dotted_field(tmp_path):
    path = tmp_path / "ambiguous.json"
    path.write_text('[{"a":{"b":1},"a.b":2}]')
    with pytest.raises(runtime.NativeError, match="SCAN_PARSE"):
        scan(path)


def test_empty_headerless_declared_schema_and_html_rowspan(tmp_path):
    path = tmp_path / "empty.csv"
    path.write_text("")
    empty = scan(path, header=False, names=["x", "y"])
    assert empty.empty and list(empty.columns) == ["x", "y"]
    table = tmp_path / "span.html"
    table.write_text(
        '<table><tr><th>group</th><th>value</th></tr><tr><td rowspan="2">a</td><td>1</td></tr><tr><td>2</td></tr></table>'
    )
    assert rows(scan(table)) == [{"group": "a", "value": 1}, {"group": "a", "value": 2}]


def test_typed_formats_preserve_explicit_string_cells_without_csv_inference(tmp_path):
    expected = [{"code": "001", "flag": "true", "number": 2}]
    json_path = tmp_path / "typed.json"
    json_path.write_text('[{"code":"001","flag":"true","number":2}]')
    parquet = tmp_path / "typed.parquet"
    workbook = tmp_path / "typed.xlsx"
    pd.DataFrame(expected).to_parquet(parquet)
    pd.DataFrame(expected).to_excel(workbook, index=False)
    for path in (json_path, parquet, workbook):
        assert rows(scan(path)) == expected


def test_nullable_json_integer_does_not_round_through_float(tmp_path):
    path = tmp_path / "ids.json"
    path.write_text('[{"id":9007199254740993},{"id":null}]')
    result = scan(path)
    assert result["id"].iloc[0] == 9007199254740993
    assert str(result["id"].dtype) == "Int64"


def test_blank_header_cells_take_the_pandas_name(tmp_path):
    # Reference answers written with pandas name a blank header cell
    # `Unnamed: <index>` (WiDS task 3 lists "Unnamed: 249" as a removed column).
    path = tmp_path / "source.csv"
    path.write_text("id;value;\n1;2;\n3;4;\n")
    result = scan(path, delim=";")
    assert list(result.columns) == ["id", "value", "Unnamed: 2"]
    assert list(result.columns) == list(pd.read_csv(path, sep=";").columns)


def test_quoted_line_breaks_are_kept_as_pandas_keeps_them(tmp_path):
    path = tmp_path / "source.csv"
    path.write_bytes(b'id,body\r\n1,"first line\r\nsecond line"\r\n2,plain\r\n')
    result = scan(path)
    assert result["body"].tolist() == ["first line\r\nsecond line", "plain"]
    assert result["body"].tolist() == pd.read_csv(path)["body"].tolist()
    assert result["id"].tolist() == [1, 2]


@pytest.mark.parametrize(
    "header",
    [
        "a,a,a",
        "b,b,b.1,b",
        "x,x,x.1",
        "x,x.1,x",
        "Unnamed: 1,,",
        "q,,q,",
        "a.1,a,a",
    ],
)
def test_repeated_header_names_match_pandas(tmp_path, header):
    # The 2015 Stack Overflow survey, the policing CSVs and the country
    # profiles repeat header names; pandas-based analyses use pandas' names.
    path = tmp_path / "source.csv"
    width = len(header.split(","))
    path.write_text(header + "\n" + ",".join(str(i) for i in range(width)) + "\n")
    assert list(scan(path).columns) == list(pd.read_csv(path).columns)


def test_missing_value_tokens_are_the_ones_pandas_read_as_missing_before_2_0():
    # pandas 2.0 added "None"; the benchmark's answer keys count it as an answer.
    from pandas._libs.parsers import STR_NA_VALUES

    assert runtime.PANDAS_NA_TOKENS == frozenset(STR_NA_VALUES) - {"", "None"}


def test_pandas_missing_tokens_are_missing_and_counted(tmp_path):
    # PASSNYC spells missing values "NA" and "N/A"; pandas reads them as
    # missing, and so do analyses written with pandas. "None" is the Kaggle
    # surveys' opt-out answer and stays a value, as pandas read it before 2.0.
    path = tmp_path / "source.csv"
    path.write_text('id,label,score\n1,NA,3\n2,None,NA\n3," NA",4\n4,n/a,\n5,"NA",#N/A\n')
    result = scan(path)

    def plain(values):
        return [None if pd.isna(value) else value for value in values]

    assert plain(result["label"]) == [None, "None", " NA", None, None]
    assert plain(result["label"]) == plain(pd.read_csv(path, na_values=[], keep_default_na=False).replace(
        {"NA": None, "n/a": None, "": None})["label"])
    assert str(result["score"].dtype) == "Int64"
    assert plain(result["score"]) == [3, None, 4, None, None]
    (source,) = result.attrs["native_v2"]["operations"]["scan"]["sources"]
    assert source["missingTokens"] == {"label": {"NA": 2, "n/a": 1}, "score": {"NA": 1, "#N/A": 1}}
    kept = scan(path, allText=True)
    assert kept["label"].tolist() == ["NA", "None", " NA", "n/a", "NA"]
    assert "missingTokens" not in kept.attrs["native_v2"]["operations"]["scan"]["sources"][0]


def test_header_cells_spelling_a_token_stay_names(tmp_path):
    path = tmp_path / "source.csv"
    path.write_text("NA,None\n1,2\n")
    assert list(scan(path).columns) == list(pd.read_csv(path).columns) == ["NA", "None"]


def test_a_csv_preview_numbers_the_record_of_each_line(tmp_path):
    # The Kaggle surveys: a header, a question row whose quoted cell holds a
    # line break, then respondents. Reading lines 1-2 as two rows skipped one.
    path = tmp_path / "survey.csv"
    path.write_text('Q1,Q2\n"What is your age\n(# years)?",Gender\n18-21,Man\n"a ""quoted"" word",Woman\n')
    shown = scan(path, preview=5)
    assert shown["record"].tolist() == [0, 1, 1, 2, 3]
    assert shown["line_no"].tolist() == [0, 1, 2, 3, 4]
    assert scan(path, preview=2, skipLines=2)["record"].tolist() == [1, 2]
    assert len(scan(path)) == 3 == len(pd.read_csv(path))
    lines = tmp_path / "notes.txt"
    lines.write_text("a\nb\n")
    assert "record" not in scan(lines, format="lines", preview=2).columns


def test_title_lines_above_the_header_are_named_in_the_error(tmp_path):
    # A Google Trends export (Netflix task 3): a title, a blank line, then the table.
    path = tmp_path / "trend.csv"
    path.write_text("Category: All categories\n\nWeek,netflix: (Australia)\n2015-01-11,8\n2015-01-18,7\n")
    with pytest.raises(runtime.NativeError, match="skip_lines=2 starts at the header"):
        scan(path)
    assert rows(scan(path, skipLines=2)) == [
        {"Week": "2015-01-11", "netflix: (Australia)": 8},
        {"Week": "2015-01-18", "netflix: (Australia)": 7},
    ]
    # A header shorter than its rows is not a title: the parser's error stands.
    path.write_text("a,b\n1,2,3\n4,5,6\n7,8,9\n")
    with pytest.raises(runtime.NativeError, match="SCAN_PARSE") as error:
        scan(path)
    assert "title" not in str(error.value)
