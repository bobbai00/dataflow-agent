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

The run's manifest fixes the model, settings and arms; the job names the model tag, arm, task and SUT. The attempt
writes into <run>/system_scratch/<SUT>/<task>/. Run with the KramaBench venv and
PYTHONPATH=benchmark/src:benchmark/Kramabench (KramaBench's `benchmark` package must be importable).
"""
import argparse
import json
from pathlib import Path

from bobbench.agent_client import Endpoints
from bobbench.kramabench.bobflow import BobFlowSystem
from bobbench.kramabench.evaluator import run_task
from bobbench.kramabench.tasks import workload_of
from bobbench.paths import KB
from bobbench.prepbench import hooks as prepbench


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--job", required=True, help="the job, as JSON")
    parser.add_argument("--cuid", type=int, help="the computing unit BobFlow's workflows run on")
    args = parser.parse_args()
    manifest, job = json.loads(args.manifest.read_text()), json.loads(args.job)
    run = args.manifest.resolve().parent
    workload = workload_of(job["task"])
    scratch = run / "system_scratch" / job["sut"]
    system = BobFlowSystem(
        model=manifest["models"][job["model"]], settings={**manifest["settings"], **manifest["arms"][job["arm"]]},
        endpoints=Endpoints.from_env(agent=manifest["endpoint"]), computing_unit=args.cuid, scratch=scratch, kb=KB,
        provenance={"agent_revision": manifest["agent_revision"], "harness_revision": manifest["harness_revision"],
                    "job": job},
        after_reply=prepbench.after_dataflow_reply if workload == "prepbench" else None)
    run_task(system, kb=KB, workload=workload, task_id=job["task"], sut=job["sut"], attempt_dir=scratch / job["task"])


if __name__ == "__main__":
    main()
