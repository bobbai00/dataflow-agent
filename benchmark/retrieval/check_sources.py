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
"""KramaBench declared inputs: corrections and an engine-side resolution check.

Some tasks declare sources whose names do not exist in the data lake;
benchmark/kramabench_source_corrections.json maps them to the files the tasks
mean. A path the engine cannot open makes an agent search the disk, so every
expanded path must resolve from the harness directory and from the engine's
working directory (amber/), and its real file must lie inside the data root,
the only tree the execution sandbox mounts.

Run from benchmark/Kramabench with the harness venv to check all tasks:
  .venv/bin/python ../retrieval/check_sources.py
"""
import glob
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
KB = ROOT / "benchmark/Kramabench"
ENGINE_CWD = ROOT / "amber"
DATA_ROOT = (KB / "data").resolve()
CORRECTIONS = {task: fixes for task, fixes in
               json.loads((ROOT / "benchmark/kramabench_source_corrections.json").read_text()).items()
               if not task.startswith("_")}


def corrected(task_id, sources):
    """Declared sources with known wrong names replaced (task ids may carry a -N suffix)."""
    fixes = next((f for task, f in CORRECTIONS.items() if task_id == task or task_id.startswith(task + "-")), {})
    return [fixes.get(source, source) for source in sources]


def _matches(pattern, root):
    path = os.path.join(root, pattern)
    return glob.glob(path, recursive=True) if any(c in pattern for c in "*?[") else ([path] if os.path.exists(path) else [])


def unresolved(patterns, roots=(KB, ENGINE_CWD)):
    """Expanded paths that match nothing from a root, or resolve outside the data root."""
    problems = []
    for pattern in patterns:
        for root in roots:
            found = _matches(pattern, str(root))
            if not found:
                problems.append(f"{pattern} (from {root})")
            for path in found:
                real = Path(path).resolve()
                if real.is_file() and DATA_ROOT not in real.parents:
                    problems.append(f"{pattern} resolves outside the data root ({real})")
    return sorted(set(problems))


def main():
    sys.path.insert(0, str(KB))
    from systems.data_source_utils import expand_data_sources

    os.chdir(KB)
    problems, tasks, paths = [], 0, 0
    for workload in ["archeology", "astronomy", "biomedical", "environment", "legal", "wildfire"]:
        directory = f"data/{workload}/input"
        all_files = [str(Path(dirpath, name).relative_to(directory))
                     for dirpath, _, names in os.walk(directory, followlinks=True) for name in names]
        for task in json.loads(Path(f"workload/{workload}.json").read_text()):
            tasks += 1
            expanded = expand_data_sources(corrected(task["id"], task.get("data_sources") or []), directory, all_files)
            paths += len(expanded)
            if not expanded:
                problems.append(f"{task['id']}: no sources after expansion")
            problems += [f"{task['id']}: {problem}" for problem in unresolved(expanded)]
    print(f"{tasks} tasks, {paths} expanded paths, {len(problems)} problems")
    for problem in problems:
        print("  ", problem)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
