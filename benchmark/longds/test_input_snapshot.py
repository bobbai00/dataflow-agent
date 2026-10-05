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

import hashlib
from types import SimpleNamespace
import pytest

from input_snapshot import freeze_raw_inputs, verify_snapshot

TASK = "domain/dataset/task1"
REVISION = "a" * 40


def fixture(tmp_path, contents=b"value\n3\n"):
    original = tmp_path / "cache/input.csv"
    original.parent.mkdir()
    original.write_bytes(contents)
    (original.parent / "previous_answer.csv").write_text("answer\n999\n")
    entry = SimpleNamespace(path=f"data/longds/{TASK}/data/input.csv", size=len(contents),
        blob_id=hashlib.sha1(b"blob " + str(len(contents)).encode() + b"\0" + contents).hexdigest(), lfs=None)

    class API:
        def list_repo_tree(self, **kwargs):
            assert kwargs["revision"] == REVISION
            return [entry]

    def download(**kwargs):
        assert kwargs["revision"] == REVISION
        assert kwargs["filename"] == entry.path
        return str(original)

    return original, entry, API(), download


def test_snapshot_uses_published_inventory_without_copying_previous_outputs(tmp_path):
    original, _, api, download = fixture(tmp_path)
    snapshot = freeze_raw_inputs("example/dataset", REVISION, [TASK], tmp_path / "inputs", api=api, download=download)
    copied = tmp_path / "inputs" / f"data/longds/{TASK}/data/input.csv"
    assert copied.read_bytes() == original.read_bytes()
    assert copied.stat().st_ino != original.stat().st_ino
    assert copied.stat().st_mode & 0o222 == 0
    assert copied.parent.stat().st_mode & 0o222 == 0
    assert len(snapshot["files"]) == 1
    assert not list((tmp_path / "inputs").rglob("previous_answer.csv"))
    verify_snapshot(snapshot)
    assert original.stat().st_mode & 0o200, "The shared original remains writable and untouched"


def test_mismatching_remote_content_is_rejected_before_publishing_snapshot(tmp_path):
    original, _, api, download = fixture(tmp_path)
    original.write_bytes(b"value\n9\n")
    with pytest.raises(ValueError, match="content hash"):
        freeze_raw_inputs("example/dataset", REVISION, [TASK], tmp_path / "inputs", api=api, download=download)
    assert not (tmp_path / "inputs").exists()


def test_remote_paths_cannot_escape_the_raw_input_namespace(tmp_path):
    _, entry, api, download = fixture(tmp_path)
    entry.path = f"data/longds/{TASK}/data/../../answer.json"
    with pytest.raises(ValueError, match="raw input path"):
        freeze_raw_inputs("example/dataset", REVISION, [TASK], tmp_path / "inputs", api=api, download=download)
    assert not (tmp_path / "inputs").exists()


def test_unpinned_or_existing_snapshots_are_never_silently_reused(tmp_path):
    _, _, api, download = fixture(tmp_path)
    with pytest.raises(ValueError, match="revision"):
        freeze_raw_inputs("example/dataset", "main", [TASK], tmp_path / "inputs", api=api, download=download)
    (tmp_path / "inputs").mkdir()
    with pytest.raises(FileExistsError):
        freeze_raw_inputs("example/dataset", REVISION, [TASK], tmp_path / "inputs", api=api, download=download)


def test_verification_rejects_changed_and_unlisted_files(tmp_path):
    _, _, api, download = fixture(tmp_path)
    snapshot = freeze_raw_inputs("example/dataset", REVISION, [TASK], tmp_path / "inputs", api=api, download=download)
    directory = tmp_path / "inputs" / f"data/longds/{TASK}/data"
    directory.chmod(0o755)
    (directory / "unexpected.csv").write_text("unexpected")
    with pytest.raises(ValueError, match="inventory"):
        verify_snapshot(snapshot)
    (directory / "unexpected.csv").unlink()
    copied = directory / "input.csv"
    copied.chmod(0o644)
    copied.write_text("value\n7\n")
    with pytest.raises(ValueError, match="changed"):
        verify_snapshot(snapshot)
