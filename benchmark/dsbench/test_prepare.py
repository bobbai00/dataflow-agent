# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Check pinned sources, workbook parsing, and agent/gold input separation."""

import hashlib
import io
import json
import zipfile

import openpyxl
import pytest

from benchmark.dsbench import prepare


def source_fixture(tmp_path, monkeypatch, broken_header=False):
    archive = tmp_path / "source.zip"
    metadata = tmp_path / "source.jsonl"
    records = []
    with zipfile.ZipFile(archive, "w") as bundle:
        for challenge_id, config in prepare.CHALLENGES.items():
            workbook = openpyxl.Workbook()
            sheet = workbook.active
            sheet.title = config["sheet"]
            if config["header"]:
                sheet.append(config["required_columns"])
                if config["skip_lines"]:
                    sheet.insert_rows(1, config["skip_lines"])
                if broken_header and challenge_id == "00000034":
                    sheet.cell(config["skip_lines"] + 1, 1, "wrong column")
                sheet.append([1] * len(config["required_columns"]))
            else:
                sheet.append(["5AM 15-Aug-2014___1.201 kwh"])
            data = io.BytesIO()
            workbook.save(data)
            prefix = f"data/{challenge_id}/"
            bundle.writestr(prefix + config["workbook"], data.getvalue())
            bundle.writestr(prefix + "introduction.txt", f"Introduction for {challenge_id}")
            questions = sorted(set(config["questions"]) | {999})
            for number in questions:
                bundle.writestr(prefix + f"question{number}.txt", f"Question {number}")
            bundle.writestr(prefix + "get_results.ipynb", "SECRET cached gold solution")
            bundle.writestr(prefix + "answer.xlsx", "SECRET gold workbook")
            records.append(
                {
                    "id": challenge_id,
                    "name": f"fixture-{challenge_id}",
                    "url": "https://example.test/challenge",
                    "questions": [f"question{number}" for number in questions],
                    "answers": [f"SECRET-{number}" for number in questions],
                }
            )
        bundle.writestr("../outside.txt", "SECRET outside archive path")
    metadata.write_text("\n".join(json.dumps(record) for record in records) + "\n")
    monkeypatch.setattr(prepare, "ARCHIVE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest())
    monkeypatch.setattr(prepare, "METADATA_SHA256", hashlib.sha256(metadata.read_bytes()).hexdigest())
    return archive, metadata


def test_only_selected_question_and_canonical_inputs_are_exposed(tmp_path, monkeypatch):
    archive, metadata = source_fixture(tmp_path, monkeypatch)
    output = tmp_path / "prepared"
    manifest = prepare.prepare_dataset(archive, metadata, output)
    assert len(manifest["tasks"]) == 12
    for task in manifest["tasks"]:
        folder = output / task["input_dir"]
        assert {path.name for path in folder.iterdir()} == set(task["allowed_files"])
        assert len(list(folder.glob("question*.txt"))) == 1
        assert len(list(folder.glob("*.xlsx"))) == 1
    assert "SECRET" not in (output / "manifest.json").read_text()
    assert "SECRET" not in "".join(path.read_text() for path in (output / "inputs").rglob("*.txt"))
    gold = json.loads((output / "evaluation/gold.json").read_text())
    assert len(gold["tasks"]) == 12
    assert all(row["answer"].startswith("SECRET-") for row in gold["tasks"])
    assert (output / "evaluation").stat().st_mode & 0o777 == 0o700
    assert (output / "evaluation/gold.json").stat().st_mode & 0o777 == 0o600
    assert not (tmp_path / "outside.txt").exists()
    prepare.verify_prepared_dataset(output)


def test_modified_sources_fail_before_creating_inputs(tmp_path, monkeypatch):
    archive, metadata = source_fixture(tmp_path, monkeypatch)
    metadata.write_text(metadata.read_text() + "\n")
    output = tmp_path / "prepared"
    with pytest.raises(ValueError, match="metadata SHA-256"):
        prepare.prepare_dataset(archive, metadata, output)
    assert not output.exists()


def test_workbook_layout_is_checked_before_creating_inputs(tmp_path, monkeypatch):
    archive, metadata = source_fixture(tmp_path, monkeypatch, broken_header=True)
    output = tmp_path / "prepared"
    with pytest.raises(ValueError, match="missing required columns"):
        prepare.prepare_dataset(archive, metadata, output)
    assert not output.exists()


def test_existing_inputs_are_preserved(tmp_path, monkeypatch):
    archive, metadata = source_fixture(tmp_path, monkeypatch)
    output = tmp_path / "prepared"
    (output / "inputs").mkdir(parents=True)
    sentinel = output / "inputs/existing.txt"
    sentinel.write_text("keep")
    with pytest.raises(FileExistsError):
        prepare.prepare_dataset(archive, metadata, output)
    assert sentinel.read_text() == "keep"
    assert not (output / "evaluation").exists()


def test_verification_rejects_extra_files_and_modified_inputs(tmp_path, monkeypatch):
    archive, metadata = source_fixture(tmp_path, monkeypatch)
    output = tmp_path / "prepared"
    manifest = prepare.prepare_dataset(archive, metadata, output)
    task = manifest["tasks"][0]
    folder = output / task["input_dir"]
    extra = folder / "get_results.ipynb"
    extra.write_text("gold")
    with pytest.raises(ValueError, match="unexpected input files"):
        prepare.verify_prepared_dataset(output)
    extra.unlink()
    (folder / task["question_file"]).write_text("different question")
    with pytest.raises(ValueError, match="input SHA-256"):
        prepare.verify_prepared_dataset(output)
