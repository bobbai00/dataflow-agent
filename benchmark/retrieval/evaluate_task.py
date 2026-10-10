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
"""Register one retrieval arm and delegate scoring to KramaBench unchanged."""
import json
import os
from pathlib import Path
import runpy
import sys

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from campaign import install_provider_prices

sys.path.insert(0, str(Path.cwd()))
import systems
from systems import cost_utils
from systems.native_expression_system import _NativeExpressionBase

manifest = json.loads(Path(os.environ["RETRIEVAL_MANIFEST"]).read_text())
job = json.loads(os.environ["RETRIEVAL_JOB"])
arm = manifest["arms"][job["arm"]]
pricing = install_provider_prices(cost_utils, [manifest["models"][job["model"]]])
if pricing:
    assert pricing == {manifest["models"][job["model"]]: manifest["pricing_overrides"][manifest["models"][job["model"]]]}, "Pricing drift"


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


class RetrievalSystem(_NativeExpressionBase):
    _MODEL = manifest["models"][job["model"]]
    _NAME = job["sut"]
    _DATA = False
    _FLOW = arm["flowEvidence"]

    def __init__(self, *args, **kwargs):
        kwargs["agent_service_endpoint"] = manifest["endpoint"]
        kwargs["computing_unit_id"] = int(os.environ["RETRIEVAL_CUID"])
        super().__init__(*args, **kwargs)

    def _setup_agent(self, **kwargs):
        super()._setup_agent(**kwargs)
        agent = self.agent
        base = Path(self.output_dir) / job["task"]
        endpoint = agent.agent_service_endpoint + "/api/agents/" + agent.agent_id
        settings = {**manifest["settings"], **arm}
        save(base / "resources.json", {"agent_id": agent.agent_id, "workflow_id": agent._workflow_id,
                                      "computing_unit_id": agent._computing_unit_id})
        # Code visibility is set by the inherited creation protocol and is not
        # accepted by PATCH. Still verify its actual value below.
        patch = {k: v for k, v in settings.items() if k != "enableCodeInSnapshot"}
        response = requests.patch(endpoint + "/settings", json=patch, timeout=30)
        if not response.ok:
            agent.cleanup()
            raise RuntimeError(f"Retrieval settings rejected: {response.status_code} {response.text[:1200]}")
        save(base / "provenance.json", {"agent_revision": manifest["agent_revision"],
                                       "harness_revision": manifest["harness_revision"], "job": job})
        for route in ["system-info", "settings"]:
            response = requests.get(endpoint + "/" + route, timeout=30)
            response.raise_for_status()
            save(base / (route + ".json"), response.json())
        recorded = json.loads((base / "settings.json").read_text())
        assert all(recorded[k] == value for k, value in settings.items()), "Settings drift"
        info = json.loads((base / "system-info.json").read_text())
        tool = next(t for t in info["tools"] if t["name"] == "dataflow")
        # The tool carries statements; their views are checked by the parser
        # against the recorded settings, which the drift check covers.
        properties = tool["inputSchema"]["properties"]
        assert set(properties) == {"python", "statements"}, sorted(properties)

    def serve_query(self, query, query_id="default-0", subset_files=None):
        answer = super().serve_query(query, query_id, subset_files)
        endpoint = self.agent.agent_service_endpoint + "/api/agents/" + self.agent.agent_id
        base = Path(self.output_dir) / query_id
        response = requests.get(endpoint + "/snapshots/head", timeout=30)
        if response.ok:
            save(base / "snapshot.json", response.json())
        # The harness config describes its inherited defaults; keep actual
        # patched session settings alongside it and include them explicitly.
        config_path = base / "config.json"
        if config_path.exists():
            config = json.loads(config_path.read_text())
            config["retrieval_experiment"] = {**manifest["settings"], **arm}
            save(config_path, config)
        return answer


setattr(systems, job["sut"], RetrievalSystem)
if __name__ == "__main__":
    runpy.run_path("evaluate.py", run_name="__main__")
