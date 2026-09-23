#!/usr/bin/env python3
"""Run the official-protocol comparison matrix: tasks x arms x models x trials.

Three prepared tasks chosen for their state-evolution mix, so a result can be
read against the paper's own finding that accuracy falls from Initial through
Update and Counterfactual to Rollback:

  github    15 turns, Initial only                 negative control, no state evolution
  university 21 turns, 11 Init / 4 Upd / 9 CF / 2 RB   moderate
  policing  36 turns, 16 Init / 11 Upd / 12 CF / 11 RB heavy

Dataflow sessions are capped below the number of workers because each one holds
an engine session; the script arm is pure Python and does not contend for it.
"""
import argparse
import concurrent.futures
import json
import subprocess
import threading
import time
from pathlib import Path

from _paths import SCRATCH

HERE = Path(__file__).resolve().parent
TASKS = {
    "github": "community__github_programming_languages_data__task1",
    "university": "education__world_university_rankings__task2",
    "policing": "social_good__center_for_policing_equity__task1",
}
MODEL_TAIL = {"gpt-5.6-luna": "luna", "gpt-5.6-terra": "terra"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", default="github,university,policing")
    ap.add_argument("--arms", default="code,react-catalog")
    ap.add_argument("--models", default="gpt-5.6-luna,gpt-5.6-terra")
    ap.add_argument("--trial", type=int, default=1)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--dataflow-workers", type=int, default=2)
    ap.add_argument("--turn-limit", type=int)
    ap.add_argument("--out", type=Path, default=HERE / "official-matrix")
    args = ap.parse_args()

    tasks = [TASKS[t] for t in args.tasks.split(",")]
    arms = args.arms.split(",")
    models = args.models.split(",")
    args.out.mkdir(parents=True, exist_ok=True)
    gate = threading.Semaphore(args.dataflow_workers)
    manifest = {"started": time.time(), "trial": args.trial, "tasks": tasks, "arms": arms, "models": models, "cells": []}
    lock = threading.Lock()

    def cell(task, arm, model):
        sut = f"LongDS_Official_{arm}_{MODEL_TAIL.get(model, model)}_t{args.trial}"
        command = [
            "/home/bob/Desktop/dataflow-agent/.venv/bin/python",
            str(HERE / "run_official.py"),
            "--task", task, "--arm", arm, "--model", model, "--sut", sut,
        ]
        if args.turn_limit:
            command += ["--turn-limit", str(args.turn_limit)]
        held = gate if arm not in ("code", "dsgym") else threading.Semaphore(1)
        with held:
            started = time.time()
            log = args.out / f"{sut}__{task}.log"
            with log.open("w") as stream:
                process = subprocess.run(command, cwd=HERE, stdout=stream, stderr=subprocess.STDOUT)
            summary = SCRATCH / sut / task / "summary.json"
            row = {
                "task": task, "arm": arm, "model": model, "sut": sut,
                "exit_code": process.returncode, "minutes": round((time.time() - started) / 60, 1),
                **(json.loads(summary.read_text()) if summary.exists() else {}),
            }
        with lock:
            manifest["cells"].append(row)
            (args.out / f"matrix-t{args.trial}.json").write_text(json.dumps(manifest, indent=2))
        print(json.dumps(row), flush=True)
        return row

    jobs = [(t, a, m) for t in tasks for a in arms for m in models]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for future in concurrent.futures.as_completed([pool.submit(cell, *j) for j in jobs]):
            future.result()
    manifest["finished"] = time.time()
    (args.out / f"matrix-t{args.trial}.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({"finished": True, "cells": len(manifest["cells"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
