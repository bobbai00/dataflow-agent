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
"""One attempt: one task of a run, in its own process, scored by KramaBench's evaluator.

    python -m bobbench.kramabench.attempt --manifest <run>/manifest.json --job '<job json>' [--cuid N]

The run's manifest fixes the system, model, settings and arms; the job names the model tag, arm, task, repetition and
SUT. The attempt writes into <run>/system_scratch/<SUT>/<task>/. The runner starts it with the KramaBench venv,
PYTHONPATH=benchmark/src:benchmark/Kramabench (KramaBench's `benchmark` package) and the stack's environment, and stops
it with SIGTERM at the run's wall clock: Script ReAct then ends its agent and is scored with what it has.
"""
import argparse
import json
import os
from pathlib import Path
import signal

from bobbench.agent_client import Endpoints
from bobbench.kramabench.bobflow import BobFlowSystem
from bobbench.kramabench.evaluator import run_task
from bobbench.kramabench.scriptreact import ScriptReActSystem
from bobbench.kramabench.tasks import workload_of
from bobbench.paths import KB
from bobbench.prepbench import hooks as prepbench


def bobflow(manifest, job, scratch, workload, cuid):
    return BobFlowSystem(
        model=manifest["models"][job["model"]], settings={**manifest["settings"], **manifest["arms"][job["arm"]]},
        endpoints=Endpoints.from_env(agent=manifest["endpoint"]), computing_unit=cuid, scratch=scratch, kb=KB,
        provenance={"agent_revision": manifest["agent_revision"], "harness_revision": manifest["harness_revision"],
                    "job": job},
        after_reply=prepbench.after_dataflow_reply if workload == "prepbench" else None)


def scriptreact(manifest, job, scratch, workload):
    stop_at_wall_clock(scratch / job["task"])
    pb = workload == "prepbench"
    return ScriptReActSystem(
        model=manifest["models"][job["model"]], settings=manifest["script_settings"],
        python=manifest["script_python"]["path"], api_base=manifest["script_endpoint"],
        api_key=os.environ.get("CODE_AGENT_API_KEY") or os.environ["LITELLM_MASTER_KEY"], scratch=scratch,
        workspace=Path(manifest["workspaces"]) / job["sut"] / job["task"], kb=KB,
        provenance={"runner_revision": manifest["runner_revision"], "harness_revision": manifest["harness_revision"],
                    "job": job, "model": manifest["models"][job["model"]], "endpoint": manifest["script_endpoint"],
                    "script_python": {key: manifest["script_python"][key] for key in ("path", "python")}},
        hints=prepbench.script_format_hints() if pb else None,
        before_agent=prepbench.before_script_agent if pb else None,
        before_discard=prepbench.collect_script_outputs if pb else None)


def stop_at_wall_clock(attempt):
    """On the runner's SIGTERM, record the stop and end the agent's wait; the task is then scored as it stands."""

    def stop(signum, frame):
        attempt.mkdir(parents=True, exist_ok=True)
        (attempt / "wall-clock-stop.json").write_text(json.dumps(
            {"reason": "Task wall-clock limit reached", "signal": signum}, indent=2) + "\n")
        raise SystemExit("Task wall-clock limit reached")

    signal.signal(signal.SIGTERM, stop)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--job", required=True, help="the job, as JSON")
    parser.add_argument("--cuid", type=int, help="the computing unit BobFlow's workflows run on")
    args = parser.parse_args()
    manifest, job = json.loads(args.manifest.read_text()), json.loads(args.job)
    scratch = args.manifest.resolve().parent / "system_scratch" / job["sut"]
    workload = workload_of(job["task"])
    if manifest["system"] == "bobflow":
        system = bobflow(manifest, job, scratch, workload, args.cuid)
    else:
        system = scriptreact(manifest, job, scratch, workload)
    run_task(system, kb=KB, workload=workload, task_id=job["task"], sut=job["sut"], attempt_dir=scratch / job["task"])


if __name__ == "__main__":
    main()
