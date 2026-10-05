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

"""Copy pinned, published raw inputs into an independent read-only snapshot.

The remote inventory is authoritative. Shared local data directories can contain
outputs from earlier agents and reference runs, so they are never walked or
copied. Provenance belongs outside the input directory, alongside run artifacts.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile

from state_comparison import digest, save


def verify_snapshot(snapshot):
    root = Path(snapshot["input_root"])
    actual = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()}
    if actual != set(snapshot["files"]):
        raise ValueError("Raw input inventory changed")
    for name, entry in snapshot["files"].items():
        path = root / name
        if path.is_symlink() or path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
            raise ValueError(f"Raw input changed: {name}")


def freeze_raw_inputs(repo, revision, tasks, destination, *, api=None, download=None):
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("An immutable 40-character dataset revision is required")
    destination = Path(destination).resolve()
    if destination.exists():
        raise FileExistsError(destination)
    if not tasks or len(set(tasks)) != len(tasks):
        raise ValueError("Provide a nonempty list of unique tasks")
    if api is None or download is None:
        from huggingface_hub import HfApi, hf_hub_download
        api = api or HfApi()
        download = download or hf_hub_download
    entries = []
    for task in tasks:
        if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/task\d+", task):
            raise ValueError(f"Invalid task path: {task}")
        prefix = f"data/longds/{task}/data/"
        found = []
        for entry in api.list_repo_tree(repo_id=repo, repo_type="dataset", revision=revision,
                                        path_in_repo=prefix.rstrip("/"), recursive=True):
            if not hasattr(entry, "size"):
                continue
            name = PurePosixPath(entry.path)
            if name.is_absolute() or ".." in name.parts or not entry.path.startswith(prefix):
                raise ValueError(f"Invalid raw input path: {entry.path}")
            found.append(entry)
        if not found:
            raise ValueError(f"Published raw inputs are missing: {task}")
        entries.extend(found)
    if len({entry.path for entry in entries}) != len(entries):
        raise ValueError("Duplicate remote input entries")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=destination.name + "-building-", dir=destination.parent) as temporary:
        staging = Path(temporary) / "inputs"
        staging.mkdir()

        def copy(entry):
            original = Path(download(repo_id=repo, repo_type="dataset", revision=revision, filename=entry.path))
            copied = staging / entry.path
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, copied)
            sha256 = digest(copied)
            lfs = getattr(entry, "lfs", None)
            if lfs:
                expected = lfs["sha256"] if isinstance(lfs, dict) else lfs.sha256
                matches = sha256 == expected
            else:
                blob = hashlib.sha1(b"blob " + str(copied.stat().st_size).encode() + b"\0")
                with copied.open("rb") as stream:
                    while chunk := stream.read(1024 * 1024):
                        blob.update(chunk)
                matches = blob.hexdigest() == entry.blob_id
            if not matches or copied.stat().st_size != entry.size:
                raise ValueError(f"Published content hash mismatch: {entry.path}")
            return entry.path, {"sha256": sha256, "bytes": entry.size, "source_blob": entry.blob_id}

        with ThreadPoolExecutor(max_workers=8) as executor:
            files = dict(executor.map(copy, entries))
        snapshot = {"repo_id": repo, "revision": revision, "input_root": str(destination),
                    "tasks": {task: {"data_dir": str(destination / f"data/longds/{task}/data"),
                                      "files": [str(destination / name) for name in sorted(files)
                                                if name.startswith(f"data/longds/{task}/data/")]}
                              for task in tasks}, "files": dict(sorted(files.items()))}
        for path in staging.rglob("*"):
            if path.is_file():
                path.chmod(0o444)
        # Publish once all downloads and hashes succeed. No shared inputs change.
        staging.rename(destination)
        for path in sorted(destination.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if path.is_dir():
                path.chmod(0o555)
        destination.chmod(0o555)
    verify_snapshot(snapshot)
    return snapshot


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="zjunlp/LongDS")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--tasks", nargs="+", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if args.manifest.resolve().is_relative_to(args.destination.resolve()):
        raise ValueError("Keep provenance outside the raw input snapshot")
    snapshot = freeze_raw_inputs(args.repo, args.revision, args.tasks, args.destination)
    save(args.manifest, snapshot)
    print(json.dumps({"revision": snapshot["revision"], "files": len(snapshot["files"]),
                      "bytes": sum(f["bytes"] for f in snapshot["files"].values()), "input_root": snapshot["input_root"]}))
