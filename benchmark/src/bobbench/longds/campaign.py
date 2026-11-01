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
"""Run sessions x arms x repetitions, a few at a time.

The arm `smolagents-depnote` runs the script-agent baseline
(smolagents_session.py); the other arms, `catalog-gold` and `transcript-depnote`, are
dataflow agents (run_session.py).

Jobs are ordered repetition by repetition, so every arm of a session runs
under similar load, and a job whose run folder exists is skipped (a crashed
session is rerun from its first request after its folder is moved aside).

Usage (from the repository root, inside the stack's environment):
    bench longds campaign --root R --model gpt-5.6-luna --parallel 6
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys

from bobbench.paths import LONGDS_PREPARED


def jobs(root, prepared, sessions, arms, reps):
    return [{"prepared": prepared / session, "arm": arm, "rep": rep,
             "out": root / "runs" / f"{session}__{arm}__r{rep}"}
            for rep in range(1, reps + 1) for session in sessions for arm in arms]


def command(job, model, extra):
    """The script agent has its own runner; every other arm is a dataflow agent."""
    common = ["--prepared", str(job["prepared"]), "--out", str(job["out"]), "--model", model, *extra]
    if job["arm"] == "smolagents-depnote":
        return [sys.executable, "-m", "bobbench.longds.smolagents_session", "--note", "dependencies", *common]
    return [sys.executable, "-m", "bobbench.longds.run_session", "--arm", job["arm"], *common]


def launch(job, model, extra):
    log = job["out"].parent.parent / "logs" / f"{job['out'].name}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as stream:
        code = subprocess.call(command(job, model, extra), stdout=stream, stderr=subprocess.STDOUT)
    print(f"{job['out'].name}: exit {code}", flush=True)
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True, help="runs/ and logs/ are written here")
    parser.add_argument("--prepared", type=Path, default=LONGDS_PREPARED, help="the prepared sessions")
    parser.add_argument("--sessions", nargs="+", help="prepared session keys (default: every prepared session)")
    parser.add_argument("--arms", nargs="+", default=["catalog-gold", "transcript-depnote", "smolagents-depnote"])
    parser.add_argument("--reps", type=int, default=1)
    parser.add_argument("--parallel", type=int, default=3)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--spend-limit", type=float, default=5.0)
    args = parser.parse_args()
    sessions = args.sessions or sorted(path.name for path in args.prepared.iterdir() if path.is_dir())
    pending = [job for job in jobs(args.root, args.prepared, sessions, args.arms, args.reps)
               if not job["out"].exists()]
    extra = ["--spend-limit", str(args.spend_limit)]
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        codes = list(pool.map(lambda job: launch(job, args.model, extra), pending))
    sys.exit(1 if any(codes) else 0)


if __name__ == "__main__":
    main()
