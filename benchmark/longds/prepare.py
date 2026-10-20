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
"""Prepare LongDS v1.1 Lite sessions: the requests an agent receives and the
evaluator-only gold.

For each session, `<out>/<key>/` gets
- manifest.json: the data files and each turn's context and question;
- prompts.json: the request text sent for each turn (the text of every
  earlier LongDS run since 2026-10-05, so results stay comparable);
- gold.json: answers, state types and dependencies (never sent to an agent).

Usage (from the repository root):
    python -m benchmark.longds.prepare --out R/prepared sports/nfl_big_data_bowl_2023/task1
"""
import argparse
import json
import os
from pathlib import Path
import re

from benchmark.longds.common import DATA, TASKS, save, session_key


def lite_sessions():
    """The 24 Lite sessions as `domain/dataset/task`."""
    entries = json.loads((TASKS / "task_list_lite.json").read_text())
    return [f"{e['task_domain']}/{e['dataset_name']}/{e['task_id']}" for e in entries]


def turn_ids(raw):
    """Dependencies as ints: most sessions write `[1, 2]`, NFL writes `["task_1", "task_2"]`."""
    out = set()
    for item in raw or []:
        if isinstance(item, int) and not isinstance(item, bool):
            out.add(item)
        elif isinstance(item, str) and (match := re.search(r"(\d+)", item)):
            out.add(int(match.group(1)))
    return sorted(out)


def build_prompts(files, turns):
    """The first request names the data files and the session's ground rules;
    each request then gives its turn's context and question."""
    first = (
        "You are an expert data scientist working through a long analysis with me. "
        "I will send requests one at a time about the same data.\n\n"
        "Data files available (use these paths verbatim; never modify input files):\n"
        + "\n".join(" - " + f for f in files)
        + "\n\nYour analytical state persists across requests. Name reusable calculations and working tables "
        "meaningfully. Discover headers and small samples yourself before choosing input files or parsing options; "
        "filenames alone do not establish contents or relevance. Account for every potentially relevant source. "
        "Keep complete working tables separately from ranked answer selections. "
        "Preserve rules and historical results when later requests need them.\n"
        "Use code for every calculation. Do not use plotting libraries. Answer after checking the computed evidence. "
        "Return a single-line JSON object containing exactly the requested quantities, following the task's "
        "rounding and scale rules.\n\n"
    )
    return [{"turn_id": t["turn_id"], "prompt": (first if i == 0 else "") +
             f"[Task {t['turn_id']}]\n{t['context']}\nQuestion: {t['question']}"}
            for i, t in enumerate(turns)]


def prepare(task, out, data_root=DATA, turn_limit=None):
    """Write one session's manifest, prompts and gold; returns the manifest."""
    folder = TASKS / task
    turns = json.loads((folder / "task.json").read_text())[:turn_limit]
    meta = {m.get("turn"): m for m in json.loads((folder / "metadata.json").read_text())}
    for i, turn in enumerate(turns):
        turn["turn_id"] = int(turn["turn_id"])
        if turn["turn_id"] != i + 1:
            raise ValueError(f"{task}: turns must be numbered 1, 2, ... (turn {i + 1} is {turn['turn_id']})")
    data = Path(data_root) / task / "data"
    if not data.is_dir():
        raise FileNotFoundError(f"{task}: no data at {data}")
    # Paths as the agent's engine reads them: relative to the repository root.
    files = sorted(f"data/longds/{task}/data/{os.path.relpath(Path(d) / name, data)}"
                   for d, _, names in os.walk(data) for name in names)
    manifest = {"longds_version": "v1.1", "split": "lite", "task": task, "key": session_key(task),
                "files": files,
                "turns": [{"turn_id": t["turn_id"], "context": t["context"], "question": t["question"]} for t in turns]}
    gold = {"task": task, "key": session_key(task), "turns": [
        {"turn_id": t["turn_id"], "context": t["context"], "question": t["question"], "answer": t["answer"],
         "state_type": meta.get(t["turn_id"], meta.get(str(t["turn_id"]), {})).get("state_type", []),
         "depends_tasks": turn_ids(meta.get(t["turn_id"], meta.get(str(t["turn_id"]), {})).get("depends_tasks"))}
        for t in turns]}
    target = Path(out) / session_key(task)
    save(target / "manifest.json", manifest)
    save(target / "prompts.json", build_prompts(files, manifest["turns"]))
    save(target / "gold.json", gold)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tasks", nargs="+", help="domain/dataset/task, or 'lite' for all 24")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, default=DATA)
    parser.add_argument("--turns", type=int, help="only the first N turns")
    args = parser.parse_args()
    tasks = lite_sessions() if args.tasks == ["lite"] else args.tasks
    for task in tasks:
        manifest = prepare(task, args.out, args.data_root, args.turns)
        print(f"{manifest['key']}: {len(manifest['turns'])} turns, {len(manifest['files'])} files")


if __name__ == "__main__":
    main()
