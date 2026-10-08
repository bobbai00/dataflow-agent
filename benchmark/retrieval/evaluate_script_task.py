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
"""Run the existing smolagents SUT with campaign settings and complete traces.

The agent runs in the script sandbox (see script_sandbox.py). Prompt, model
responses, execution policy and the official evaluator are the SUT's own.
"""
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import signal
import sys

from campaign import install_provider_prices
from script_sandbox import CHILD, SandboxedScriptAgent


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


def campaign_job(cost_utils):
    """This process's job, with the campaign's frozen prices installed."""
    manifest = json.loads(Path(os.environ["RETRIEVAL_MANIFEST"]).read_text())
    job = json.loads(os.environ["RETRIEVAL_JOB"])
    model = manifest["models"][job["model"]]
    pricing = install_provider_prices(cost_utils, [model])
    assert all(manifest["pricing_overrides"].get(name) == rates for name, rates in pricing.items()), "Pricing drift"
    return manifest, job, model


def stop_at_wall_clock(scratch):
    """On the runner's SIGTERM, fail the task and let the evaluator score it."""

    def stop(signum, frame):
        save(scratch / "wall-clock-stop.json", {"reason": "Task wall-clock limit reached", "signal": signum})
        # The system catches this while it waits for its agent, stops it and
        # returns a failed response with the usage recorded so far.
        raise SystemExit("Task wall-clock limit reached")

    signal.signal(signal.SIGTERM, stop)


def discard_workspace(workspace, scratch):
    """Keep the names and sizes of what the agent wrote, not the files."""
    files = [
        {"path": str(path.relative_to(workspace)), "bytes": path.stat().st_size}
        for path in sorted(workspace.rglob("*"))
        if path.is_file() and not path.is_symlink()
    ]
    save(scratch / "workspace-files.json", files)
    shutil.rmtree(workspace, ignore_errors=True)


def model_options(manifest):
    """Only explicit provider facts override the historical model defaults."""
    fact = manifest.get("model_fact")
    if not fact:
        return {}
    return {
        "model_parameters": fact.get("model_parameters", {}),
        "model_capabilities": fact.get("model_capabilities", {}),
    }


def main():
    sys.path.insert(0, str(Path.cwd()))
    import systems
    from systems import cost_utils
    from systems.code_agent_system import CodeAgentSystem

    manifest, job, model = campaign_job(cost_utils)
    settings = manifest["script_settings"]
    scratch = Path("system_scratch").resolve() / job["sut"] / job["task"]
    workspace = Path(manifest["workspaces"]) / job["sut"] / job["task"]
    stop_at_wall_clock(scratch)

    class ScriptSystem(CodeAgentSystem):
        def __init__(self, *args, **kwargs):
            super().__init__(
                *args,
                model_type=model,
                name=job["sut"],
                api_base=manifest["script_endpoint"],
                api_key=os.environ.get("CODE_AGENT_API_KEY") or os.environ["LITELLM_MASTER_KEY"],
                **settings,
                **model_options(manifest),
                **kwargs,
            )

        def process_dataset(self, dataset_directory):
            super().process_dataset(dataset_directory)
            save(scratch / "settings.json", settings)
            save(
                scratch / "provenance.json",
                {
                    "runner_revision": manifest["runner_revision"],
                    "harness_revision": manifest["harness_revision"],
                    "job": job,
                    "model": model,
                    "endpoint": manifest["script_endpoint"],
                    "smolagents_version": __import__("smolagents").__version__,
                    "adapter_sha256": {
                        path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in [Path(__file__), CHILD]
                    },
                },
            )
            self.agent = SandboxedScriptAgent(
                self.agent,
                harness=Path.cwd(),
                data_root=dataset_directory,
                data_relative=os.path.relpath(dataset_directory),
                artifacts=scratch,
                workspace=workspace,
            )

        def serve_query(self, query, query_id="default-0", subset_files=None):
            try:
                return super().serve_query(query, query_id, subset_files)
            finally:
                discard_workspace(workspace, scratch)

    setattr(systems, job["sut"], ScriptSystem)
    runpy.run_path("evaluate.py", run_name="__main__")


if __name__ == "__main__":
    main()
