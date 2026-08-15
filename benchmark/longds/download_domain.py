#!/usr/bin/env python3
"""Download every LongDS task of one domain in a single HF snapshot call.

`bin/bench.sh longds download` takes one `domain/dataset/task` at a time, which
means one `snapshot_download` (and one repo listing) per task. Fetching a whole
domain that way re-lists the 19.5 GB repo N times; a single call with N pattern
pairs lists once. The task list itself is authoritative for what a domain
contains, so the caller names the domain, not twelve paths.

    python benchmark/longds/download_domain.py --domain business
    python benchmark/longds/download_domain.py --domain business --dry-run
"""
import argparse
import json
import sys

from _paths import DATAMIND, add_import_paths

add_import_paths()

TASK_LIST = DATAMIND / "task" / "longds" / "task_list.json"


def domain_tasks(domain: str) -> list[str]:
    """`domain/dataset/task` for every entry of one domain, in task_list order."""
    entries = json.loads(TASK_LIST.read_text())
    return [
        f"{e['task_domain']}/{e['dataset_name']}/{e['task_id']}"
        for e in entries
        if e["task_domain"] == domain
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--domain", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not TASK_LIST.exists():
        print(f"FATAL: {TASK_LIST} missing — run `bin/bench.sh setup` first")
        return 2

    tasks = domain_tasks(args.domain)
    if not tasks:
        print(f"FATAL: no tasks in domain {args.domain!r}")
        return 2
    print(f"{args.domain}: {len(tasks)} tasks")
    for t in tasks:
        print(f"  {t}")
    if args.dry_run:
        return 0

    from huggingface_hub import snapshot_download

    patterns = ["task/longds/task_list.json"]
    for t in tasks:
        patterns += [f"task/longds/{t}/*", f"data/longds/{t}/**"]

    snapshot_download(
        repo_id="zjunlp/LongDS",
        repo_type="dataset",
        local_dir=str(DATAMIND),
        allow_patterns=patterns,
        max_workers=8,
    )

    # Report what actually landed: a pattern that matches nothing is silent, and
    # a task with no data directory is a run that fails at turn 1.
    missing = []
    for t in tasks:
        data_dir = DATAMIND / "data" / "longds" / t
        task_json = DATAMIND / "task" / "longds" / t / "task.json"
        n = len(list(data_dir.rglob("*"))) if data_dir.exists() else 0
        ok = task_json.exists() and n > 0
        print(f"  {'ok ' if ok else 'MISSING'} {t}: {n} data files, task.json={task_json.exists()}")
        if not ok:
            missing.append(t)
    if missing:
        print(f"\nFATAL: {len(missing)} task(s) incomplete: {missing}")
        return 1
    print(f"\ndownloaded {len(tasks)} tasks into {DATAMIND}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
