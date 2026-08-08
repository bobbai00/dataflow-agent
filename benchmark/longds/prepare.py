#!/usr/bin/env python3
"""Split the LongDS dataset into what the agent may see and what it may not.

`task.json` carries the gold `answer` AND a gold `code` field (the reference
Python solution), and `task.py`/`task.ipynb` sit in the same directory. Upstream's
own `prepare_dataset.py` deletes those under `--strip-source` for exactly this
reason. This script does the non-destructive equivalent: it writes a *manifest*
holding only `(turn_id, context, question)`, which is all the runner is allowed to
read, and a separate *gold* file the runner never touches — only the judge does.

Also emits the per-task file inventory. The agent has no file-listing tool (it can
only learn a file exists by writing a loader that reads it), so the inventory has
to go into the turn-1 prompt.

`metadata.json`'s `state_type` / `depends_tasks` / `depends_span` annotations are
copied into the gold file for later analysis. They must never reach a prompt: the
official protocol does not tell the model whether a turn is a rollback.

Usage:
    python benchmark/longds/prepare.py                      # all 68 tasks (those present)
    python benchmark/longds/prepare.py --task sports/nfl_big_data_bowl_2023/task1
"""
import argparse
import json
import re
import os
import sys
from pathlib import Path

from _paths import KB_ROOT as KB, DATAMIND, PREPARED, DATA_REL_ROOT

TASK_ROOT = DATAMIND / "task" / "longds"


def task_key(domain: str, dataset: str, task_id: str) -> str:
    return f"{domain}__{dataset}__{task_id}"


def file_inventory(data_dir: Path) -> list[str]:
    """Every file under the task's data dir, as paths relative to the KB root."""
    out = []
    for dirpath, _, filenames in os.walk(data_dir):
        for name in sorted(filenames):
            abs_path = Path(dirpath) / name
            out.append(os.path.relpath(abs_path, KB))
    return sorted(out)



def _norm_turn_ids(raw) -> list[int]:
    """Turn references as ints, whatever upstream wrote them as.

    `depends_tasks` is not consistently typed across the dataset: most tasks
    ship `[1, 2]`, nfl ships `["task_1", "task_2"]`. Anything comparing a
    dependency to a turn number silently mismatches on the string form — which
    already produced one wrong conclusion (every nfl turn counted as "skips
    back", inflating that statistic across the whole set). Normalising once,
    here, means nothing downstream has to know.
    """
    out: list[int] = []
    for x in raw or []:
        if isinstance(x, bool):
            continue
        if isinstance(x, int):
            out.append(x)
        elif isinstance(x, str):
            m = re.search(r"(\d+)", x)
            if m:
                out.append(int(m.group(1)))
    return sorted(set(out))

def prepare_one(entry: dict, turn_limit: int | None) -> dict | None:
    domain, dataset, tid = entry["task_domain"], entry["dataset_name"], entry["task_id"]
    key = task_key(domain, dataset, tid)
    task_json = TASK_ROOT / domain / dataset / tid / "task.json"
    meta_json = TASK_ROOT / domain / dataset / tid / "metadata.json"
    data_dir = KB / DATA_REL_ROOT / domain / dataset / tid / "data"

    if not task_json.exists():
        return None
    if not data_dir.exists():
        print(f"  SKIP {key}: data dir absent ({data_dir})")
        return None

    turns = json.loads(task_json.read_text())
    if turn_limit:
        turns = turns[:turn_limit]
    meta = json.loads(meta_json.read_text()) if meta_json.exists() else []
    meta_by_turn = {m.get("turn"): m for m in meta}

    files = file_inventory(data_dir)
    out_dir = PREPARED / key
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "key": key,
        "domain": domain,
        "dataset_name": dataset,
        "task_id": tid,
        "data_dir": os.path.relpath(data_dir, KB),
        "files": files,
        "turns": [
            {"turn_id": t["turn_id"], "context": t["context"], "question": t["question"]}
            for t in turns
        ],
    }
    gold = {
        "key": key,
        "domain": domain,
        "dataset_name": dataset,
        "task_id": tid,
        "turns": [
            {
                "turn_id": t["turn_id"],
                "context": t["context"],
                "question": t["question"],
                "answer": t["answer"],
                # analysis-only; never rendered into a prompt
                "state_type": meta_by_turn.get(t["turn_id"], {}).get("state_type", []),
                "depends_tasks": _norm_turn_ids(
                    meta_by_turn.get(t["turn_id"], {}).get("depends_tasks", [])
                ),
                "depends_span": meta_by_turn.get(t["turn_id"], {}).get("depends_span", []),
            }
            for t in turns
        ],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    (out_dir / "gold.json").write_text(json.dumps(gold, indent=2, ensure_ascii=False))

    patterns = {}
    for turn in gold["turns"]:
        for st in turn["state_type"] or ["(none)"]:
            patterns[st] = patterns.get(st, 0) + 1
    print(f"  {key}: {len(turns)} turns, {len(files)} files, patterns={patterns}")
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", help="domain/dataset/task_id to prepare (default: all present)")
    ap.add_argument("--turn-limit", type=int, default=None)
    args = ap.parse_args()

    task_list_path = TASK_ROOT / "task_list.json"
    if not task_list_path.exists():
        print(f"FATAL: {task_list_path} missing — download the dataset first")
        return 2
    entries = json.loads(task_list_path.read_text())

    if args.task:
        want = args.task.strip("/").split("/")
        if len(want) != 3:
            print("FATAL: --task must be domain/dataset/task_id")
            return 2
        entries = [
            e
            for e in entries
            if [e["task_domain"], e["dataset_name"], e["task_id"]] == want
        ]
        if not entries:
            print(f"FATAL: {args.task} not in task_list.json")
            return 2

    print(f"preparing {len(entries)} candidate task(s) -> {PREPARED}")
    made = [m for m in (prepare_one(e, args.turn_limit) for e in entries) if m]
    print(f"prepared {len(made)} task(s), {sum(len(m['turns']) for m in made)} turns")
    return 0 if made else 1


if __name__ == "__main__":
    sys.exit(main())
