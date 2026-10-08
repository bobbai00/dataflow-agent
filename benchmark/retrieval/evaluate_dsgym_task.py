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
"""Run the DSGym SUT with campaign settings on a sandboxed executor.

Starts dsgym_executor.py for the task's input directory, points the SUT at it
and delegates scoring to the official evaluator.
"""
import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

from evaluate_script_task import campaign_job, discard_workspace, save, stop_at_wall_clock

EXECUTOR = Path(__file__).with_name("dsgym_executor.py")


def main():
    sys.path.insert(0, str(Path.cwd()))
    import systems
    from systems import cost_utils
    from systems.dsgym_system import DSGymSystem

    manifest, job, model = campaign_job(cost_utils)
    settings = manifest["dsgym_settings"]
    workload = argparse.ArgumentParser()
    workload.add_argument("--workload", required=True)
    relative = f"data/{workload.parse_known_args()[0].workload}/input"
    scratch = Path("system_scratch").resolve() / job["sut"] / job["task"]
    workspace = Path(manifest["workspaces"]) / job["sut"] / job["task"]
    scratch.mkdir(parents=True, exist_ok=True)
    stop_at_wall_clock(scratch)

    with (scratch / "executor.log").open("w") as log:
        executor = subprocess.Popen(
            [
                sys.executable,
                str(EXECUTOR),
                "--data-root",
                str(Path.cwd() / relative),
                "--data-relative",
                relative,
                "--workspace",
                str(workspace),
                "--timeout",
                str(manifest["dsgym_execution_timeout"]),
                "--log",
                str(scratch / "kernel-executions.jsonl"),
            ],
            stdout=subprocess.PIPE,
            stderr=log,
            text=True,
            env={**os.environ, "DSGYM_HOME": manifest["dsgym_home"]},
        )
    try:
        manager_url = json.loads(executor.stdout.readline())["manager_url"]

        class CampaignDSGymSystem(DSGymSystem):
            def __init__(self, *args, **kwargs):
                super().__init__(
                    *args,
                    model_type=model,
                    name=job["sut"],
                    manager_url=manager_url,
                    api_base=manifest["script_endpoint"],
                    dsgym_home=manifest["dsgym_home"],
                    api_key=os.environ.get("CODE_AGENT_API_KEY") or os.environ["LITELLM_MASTER_KEY"],
                    **settings,
                    **kwargs,
                )

            def process_dataset(self, dataset_directory):
                super().process_dataset(dataset_directory)
                save(scratch / "settings.json", {**settings, "execution_timeout": manifest["dsgym_execution_timeout"]})
                save(
                    scratch / "provenance.json",
                    {
                        "runner_revision": manifest["runner_revision"],
                        "harness_revision": manifest["harness_revision"],
                        "job": job,
                        "model": model,
                        "endpoint": manifest["script_endpoint"],
                        "dsgym_revision": manifest["dsgym_revision"],
                    },
                )

        setattr(systems, job["sut"], CampaignDSGymSystem)
        runpy.run_path("evaluate.py", run_name="__main__")
    finally:
        executor.terminate()
        executor.wait()
        discard_workspace(workspace, scratch)


if __name__ == "__main__":
    main()
