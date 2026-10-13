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

The arms `smolagents`, `smolagents-oracle` and `smolagents-variables` run the
script-agent baseline (smolagents_session.py; KRAMABENCH_ROOT names a
KramaBench checkout at the pinned revision); every other arm is a dataflow
agent (run_session.py).

Jobs are ordered repetition by repetition, so every arm of a session runs
under similar load, and a job whose run folder exists is skipped (a crashed
session is rerun from its first request after its folder is moved aside).

Usage (from the repository root, inside the stack's environment):
    python -m benchmark.longds.campaign --root R --sessions <key> <key> \\
        --arms off transcript catalog --reps 3 --parallel 6
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys


def jobs(root, sessions, arms, reps):
    return [{"prepared": root / "prepared" / session, "arm": arm, "rep": rep,
             "out": root / "runs" / f"{session}__{arm}__r{rep}"}
            for rep in range(1, reps + 1) for session in sessions for arm in arms]


def command(job, model, extra):
    """The script agent has its own runner; every other arm is a dataflow agent."""
    common = ["--prepared", str(job["prepared"]), "--out", str(job["out"]), "--model", model, *extra]
    if job["arm"] == "smolagents":
        return [sys.executable, "-m", "benchmark.longds.smolagents_session", *common]
    if job["arm"] == "smolagents-oracle":
        return [sys.executable, "-m", "benchmark.longds.smolagents_session", "--select", "oracle", *common]
    if job["arm"] == "smolagents-variables":
        return [sys.executable, "-m", "benchmark.longds.smolagents_session", "--pick", "variables", *common]
    return [sys.executable, "-m", "benchmark.longds.run_session", "--arm", job["arm"], *common]


def launch(job, model, extra):
    log = job["out"].parent.parent / "logs" / f"{job['out'].name}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a") as stream:
        code = subprocess.call(command(job, model, extra), stdout=stream, stderr=subprocess.STDOUT)
    print(f"{job['out'].name}: exit {code}", flush=True)
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True, help="holds prepared/; runs/ and logs/ are written")
    parser.add_argument("--sessions", nargs="+", required=True, help="prepared session keys")
    parser.add_argument("--arms", nargs="+", default=["off", "transcript", "catalog"])
    parser.add_argument("--reps", type=int, default=1)
    parser.add_argument("--parallel", type=int, default=3)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--spend-limit", type=float, default=5.0)
    args = parser.parse_args()
    pending = [job for job in jobs(args.root, args.sessions, args.arms, args.reps) if not job["out"].exists()]
    extra = ["--spend-limit", str(args.spend_limit)]
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        codes = list(pool.map(lambda job: launch(job, args.model, extra), pending))
    sys.exit(1 if any(codes) else 0)


if __name__ == "__main__":
    main()
