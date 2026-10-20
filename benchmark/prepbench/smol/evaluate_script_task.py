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
"""One PrepBench attempt of smolagents: the smolagents adapter (benchmark/retrieval/evaluate_script_task.py, unchanged;
the adapter with the interpreter lock) plus the handover.
- The answer format is the script version (../format_hint_script.json): write each table with pandas to result/<file>.
- result/ exists in the sandbox workspace before the agent starts.
- Before the adapter discards the workspace, every output_NN.csv the agent wrote is copied to <attempt>/outputs/
  (result/ first; elsewhere in the workspace only if result/ lacks it), recorded in <attempt>/outputs.json."""
import json
from pathlib import Path
import re
import shutil
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "retrieval"))
sys.path.insert(0, str(Path.cwd()))
import evaluate_script_task as base  # noqa: E402
from script_sandbox import SandboxedScriptAgent  # noqa: E402
from systems.code_agent_system import CodeAgentSystem  # noqa: E402

HINTS = {h["id"]: h["format_hint"] for h in json.loads((HERE.parent / "format_hint_script.json").read_text())}
load_hints = CodeAgentSystem._load_format_hints


def script_hints(self, dataset_directory):
    load_hints(self, dataset_directory)
    self.format_hints.update(HINTS)


start = SandboxedScriptAgent.run


def run(self, prompt):
    (self.workspace / "result").mkdir(parents=True, exist_ok=True)
    return start(self, prompt)


discard = base.discard_workspace


def collect_then_discard(workspace, scratch):
    found = {}
    for path in sorted(workspace.rglob("*.csv"), key=lambda p: (p.parent != workspace / "result", str(p))):
        if re.fullmatch(r"output_\d+\.csv", path.name) and path.is_file() and not path.is_symlink() and path.name not in found:
            (scratch / "outputs").mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, scratch / "outputs" / path.name)
            found[path.name] = {"ok": True, "from": str(path.relative_to(workspace)), "bytes": path.stat().st_size}
    (scratch / "outputs.json").write_text(json.dumps({"files": found}, indent=2) + "\n")
    discard(workspace, scratch)


CodeAgentSystem._load_format_hints = script_hints
SandboxedScriptAgent.run = run
base.discard_workspace = collect_then_discard
if __name__ == "__main__":
    base.main()
