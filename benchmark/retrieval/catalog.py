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
"""Inventory original KramaBench task input sizes without consulting outcomes."""
import argparse
from datetime import datetime, timezone
import glob
import hashlib
import json
from pathlib import Path
import re
import zipfile

KB = Path(__file__).resolve().parents[1] / "Kramabench"
WORKLOADS = ["archeology", "astronomy", "biomedical", "environment", "legal", "wildfire"]


def inventory():
    tasks = []
    for workload in WORKLOADS:
        for task in json.loads((KB / "workload" / f"{workload}.json").read_text()):
            paths, missing = set(), []
            for source in task["data_sources"]:
                matches = glob.glob(str(KB / "data" / workload / "input" / source), recursive=True)
                if not matches:
                    missing.append(source)
                for match in matches:
                    path = Path(match)
                    paths.update([path] if path.is_file() else (f for f in path.rglob("*") if f.is_file()))
            files = [{"path": str(p.relative_to(KB)), "bytes": p.stat().st_size} for p in sorted(paths)]
            tasks.append({"task_id": task["id"], "query": task["query"], "files": files,
                          "bytes": sum(f["bytes"] for f in files), "unresolved_sources": missing})
    return sorted(tasks, key=lambda t: (-t["bytes"], t["task_id"]))


def describe(path):
    digest, lines = hashlib.sha256(), 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
            lines += block.count(b"\n")
    details = {"sha256": digest.hexdigest()}
    if path.suffix.lower() in [".csv", ".txt", ".dat", ".sp3"]:
        # Physical lines are a size measure, not parsed records (CSV can span lines).
        details["physical_newlines"] = lines
    if path.suffix.lower() == ".xlsx":
        with zipfile.ZipFile(path) as book:
            dimensions = {}
            for name in book.namelist():
                if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name):
                    with book.open(name) as sheet:
                        match = re.search(rb'<dimension ref="([^"]+)"', sheet.read(16384))
                    dimensions[name] = match.group(1).decode() if match else None
            details["declared_sheet_dimensions"] = dimensions
    return details


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tasks", nargs="+", required=True)
    parser.add_argument("--selection", required=True)
    args = parser.parse_args()
    tasks = inventory()
    assert set(args.tasks) <= {t["task_id"] for t in tasks}, "Unknown task ID"
    selected = [t for t in tasks if t["task_id"] in args.tasks]
    files = {f["path"]: f for t in selected for f in t["files"]}
    for name, file in files.items():
        file.update(describe(KB / name))
    result = {"created_at": datetime.now(timezone.utc).isoformat(), "selection": args.selection,
              "task_count": len(tasks), "selected_tasks": selected, "ranked_tasks": tasks}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    for task in selected:
        print(f"{task['task_id']}: {task['bytes']:,} bytes, {len(task['files'])} files")


if __name__ == "__main__":
    main()
