# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
import json
import hashlib
from types import SimpleNamespace

import pytest
import comparison_iteration as iteration
from comparison_budget import ESTIMATOR


def setup_iteration(tmp_path, monkeypatch):
    root = tmp_path / "root"
    here = root / "benchmark/longds"
    here.mkdir(parents=True)
    previous = tmp_path / "previous"
    previous.mkdir()
    def write(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))
    write(previous / "input-budget-calibration.json", {"calibration": {"scale": .92, "estimator": ESTIMATOR}})
    write(previous / "gates-engine.json", [{"task": task, "exit_code": 0} for task in iteration.COHORT])
    write(root / "data/fixture.csv", "fixture")
    for task in iteration.COHORT:
        folder = previous / "prepared" / task.replace("/", "__")
        write(folder / "manifest.json", {"files": ["data/fixture.csv"], "turns": [{"turn_id": 1}]})
        write(folder / "gold.json", {"turns": [{"answer": "secret reference"}]})
        write(folder / "prompts.json", [{"turn_id": 1, "prompt": "neutral question"}])
    for name in ["state_comparison.py", "comparison_job.py", "comparison_capture.py", "comparison_iteration.py",
                 "comparison_budget.py", "dsgym_agent.py", "dsgym_executor.py", "judge_longds.py", "numeric_gate.py"]:
        write(here / name, "source")
    for name in ["agent-service/benchmark/multiturn/run-comparison-session.ts", "agent-service/src/server.ts",
                 "agent-service/src/agent/native/python/runtime.py", "agent-service/src/test.test.ts",
                 "benchmark/longds/DataMind/longds/runners/DSGym/scripts/prompt.py"]:
        write(root / name, "source")
    monkeypatch.setattr(iteration, "ROOT", root)
    monkeypatch.setattr(iteration, "HERE", here)
    monkeypatch.setattr(iteration.metadata, "version", lambda name: "test-version")
    monkeypatch.setattr(iteration.subprocess, "check_output", lambda *args, **kwargs: "test-revision\n")
    # The legacy benchmark test environment uses Python 3.10. The executable
    # campaign uses repository Python 3.12 and its streaming file_digest.
    if not hasattr(hashlib, "file_digest"):
        monkeypatch.setattr(iteration, "digest", lambda path: hashlib.sha256(path.read_bytes()).hexdigest())
    return SimpleNamespace(previous=previous, output=tmp_path / "output", phase="control", budget=0,
                           reps=3, endpoint="http://localhost:3050", api_base="http://localhost:34000/v1")


def test_iteration_archives_python_runtime_and_identical_controls(tmp_path, monkeypatch):
    args = setup_iteration(tmp_path, monkeypatch)
    iteration.freeze(args)
    control = json.loads((args.output / "control/manifest.json").read_text())
    args.phase, args.budget, args.endpoint = "bounded", 64000, "http://localhost:3051"
    iteration.freeze(args)
    bounded = json.loads((args.output / "bounded/manifest.json").read_text())
    assert control["source_hashes"] == bounded["source_hashes"]
    assert control["input_files"] == bounded["input_files"]
    assert control["prompt_hashes"] == bounded["prompt_hashes"]
    assert "agent-service/src/agent/native/python/runtime.py" in control["source_hashes"]
    assert "agent-service/src/test.test.ts" not in control["source_hashes"]
    assert len(control["jobs"]) == len(bounded["jobs"]) == 36
    for job in bounded["jobs"]:
        if job["settings"] is not None:
            assert job["settings"]["contextWindowTokens"] == 0
    assert bounded["full_input_policy"]["budget_tokens"] == 64000
    assert bounded["full_input_policy"]["scale"] == .92
    with pytest.raises(FileExistsError):
        iteration.freeze(args)


def test_reference_preflight_failure_is_never_silently_dropped(tmp_path, monkeypatch):
    args = setup_iteration(tmp_path, monkeypatch)
    gates = json.loads((args.previous / "gates-engine.json").read_text())
    gates[0]["exit_code"] = 1
    (args.previous / "gates-engine.json").write_text(json.dumps(gates))
    with pytest.raises(ValueError, match="preflight"):
        iteration.freeze(args)
    assert not (args.output / "control/manifest.json").exists()
