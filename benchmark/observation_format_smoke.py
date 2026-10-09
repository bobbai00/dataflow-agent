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

"""Current observation-format arms, separate from historical benchmark arms.

Run KramaBench's own evaluator in process so its SUT registry can include this
root-owned arm without editing the benchmark submodule:
  python benchmark/observation_format_smoke.py --workload legal --task_id legal-easy-3 --no_pipeline_eval
"""
import json
import os
import runpy
import sys
import time
from pathlib import Path

import requests

KB_ROOT = Path(__file__).resolve().parent / "Kramabench"
sys.path.insert(0, str(KB_ROOT))
from systems.dataflow_system import DataflowSystem
from dataflow_agent import MessageResult


#: Declared sources KramaBench names wrongly, mapped to the files the tasks mean.
SOURCE_CORRECTIONS = {
    task: fixes
    for task, fixes in json.loads((Path(__file__).with_name("kramabench_source_corrections.json")).read_text()).items()
    if not task.startswith("_")
}


def unresolved(paths, roots):
    """The listed paths (globs included) that match nothing under one of the roots."""
    import glob

    missing = []
    for path in paths:
        for root in roots:
            pattern = os.path.join(root, path)
            if not (glob.glob(pattern, recursive=True) if any(c in path for c in "*?[") else os.path.exists(pattern)):
                missing.append(f"{path} (from {root})")
    return missing


class DataflowObservationFormatLuna(DataflowSystem):
    _NAME = "DataflowObservationFormatLuna"
    _MULTI_TASK = False

    def __init__(self, verbose=False, *args, **kwargs):
        kwargs.setdefault("agent_service_endpoint", os.environ.get("OBS_AGENT_ENDPOINT", "http://localhost:3001"))
        # Bind the engine explicitly: discovery takes the first computing unit,
        # which may belong to another checkout's engine and database.
        if os.environ.get("OBS_CUID"):
            kwargs.setdefault("computing_unit_id", int(os.environ["OBS_CUID"]))
        super().__init__(
            model_type="gpt-5.6-luna",
            agent_mode="native",
            context_mode="delta",
            max_steps=40,
            data_evidence=True,
            flow_evidence=True,
            native_profile_collection=True,
            max_operator_result_char_limit=2000,
            context_window_tokens=0,
            message_layout="native",
            enable_code_in_snapshot=True,
            name=self._NAME,
            verbose=verbose,
            *args,
            **kwargs,
        )

    def serve_query(self, query, query_id="default-0", subset_files=None):
        """List the files the task needs, each one readable by the engine.

        Declared sources KramaBench names wrongly are corrected first. A path
        that still matches nothing, from this process or from the engine's
        working directory, fails the task before any model call: an agent
        given a path it cannot open searches the disk for it."""
        fixes = next(
            (f for task, f in SOURCE_CORRECTIONS.items() if query_id == task or query_id.startswith(task + "-")), {}
        )
        if subset_files:
            subset_files = [fixes.get(source, source) for source in subset_files]
            engine = os.environ.get("OBS_ENGINE_CWD", str(KB_ROOT.parent.parent / "amber"))
            roots = [os.getcwd()] + ([engine] if os.path.isdir(engine) else [])
            missing = unresolved(self._expand_data_sources(subset_files), roots)
            if missing:
                message = "HARNESS ERROR: listed data paths do not resolve: " + "; ".join(missing)
                print(f"[{self._NAME}] {query_id}: {message}", file=sys.stderr)
                if self.output_dir:
                    Path(self.output_dir, query_id).mkdir(parents=True, exist_ok=True)
                    Path(self.output_dir, query_id, "preflight.json").write_text(json.dumps({"missing": missing}, indent=2))
                return {"explanation": {"id": "main-task", "answer": message}, "pipeline_code": ""}
        return super().serve_query(query, query_id=query_id, subset_files=subset_files)

    def _setup_agent(self, **kwargs):
        super()._setup_agent(**kwargs)
        url = f"{self.agent.agent_service_endpoint}/api/agents/{self.agent.agent_id}/settings"
        patch = {
            "retrievalViews": ["full", "sample", "sample_stats"],
            "tableFormat": "markdown",
            "multiTask": self._MULTI_TASK,
            "stateHistory": self._MULTI_TASK,
            "stateLedger": self._MULTI_TASK,
            "catalogRecords": 2 if self._MULTI_TASK else 0,
            # A knob variant for matrix runs, e.g. '{"flowEvidence": false}'.
            **json.loads(os.environ.get("OBS_SETTINGS", "{}")),
        }
        response = requests.patch(url, json=patch, timeout=30)
        response.raise_for_status()
        self.observation_settings = requests.get(url, timeout=30).json()
        if self.output_dir:
            Path(self.output_dir).mkdir(parents=True, exist_ok=True)
            Path(self.output_dir, "observation-settings.json").write_text(
                json.dumps(self.observation_settings, indent=2)
            )


class LongDSObservationFormatLuna(DataflowObservationFormatLuna):
    # OBS_ARM names a knob variant so each variant keeps its own scratch directory.
    _NAME = "LongDSObservationFormatLuna" + os.environ.get("OBS_ARM", "")
    _MULTI_TASK = True

    def _setup_agent(self, **kwargs):
        super()._setup_agent(**kwargs)
        # Long sessions carry multi-megabyte compiled graphs. The REST API
        # avoids streaming those UI snapshots on every model step.
        self.agent.run = self._run_rest

    def _run_rest(self, prompt, **kwargs):
        base = f"{self.agent.agent_service_endpoint}/api/agents/{self.agent.agent_id}"
        before = requests.get(base + "/react-steps", timeout=30)
        before.raise_for_status()
        previous = before.json()["steps"]
        deadline = time.monotonic() + (self.agent.max_turn_seconds or 1200)
        try:
            response = requests.post(base + "/message", json={"content": prompt}, timeout=(10, 1200))
            response.raise_for_status()
        except (requests.ConnectionError, requests.Timeout):
            # A disconnected synchronous request can still finish server-side.
            # Poll its actual trace; never resubmit a paid/partially run turn.
            while time.monotonic() < deadline:
                state = requests.get(base, timeout=30)
                state.raise_for_status()
                if state.json()["state"] == "AVAILABLE":
                    break
                time.sleep(1)
            else:
                requests.post(base + "/stop", timeout=30).raise_for_status()
                raise TimeoutError("REST benchmark turn exceeded its wall-clock budget")
        trace = requests.get(base + "/react-steps", timeout=60)
        trace.raise_for_status()
        steps = trace.json()["steps"][len(previous) :]
        if not steps or steps[0].get("role") != "user" or steps[0].get("content") != prompt:
            raise RuntimeError("REST turn did not produce the expected new request in the trace")
        end = next((step for step in reversed(steps) if step.get("role") == "agent" and step.get("isEnd")), None)
        if end is None:
            raise RuntimeError("REST turn has no completed answer; partial trace remains available")
        mapping = {
            "input_tokens": "inputTokens",
            "output_tokens": "outputTokens",
            "total_tokens": "totalTokens",
            "reasoning_tokens": "reasoningTokens",
            "cached_input_tokens": "cachedInputTokens",
            "cache_creation_input_tokens": "cacheCreationInputTokens",
        }
        usage = {
            key: sum(int(step.get("usage", {}).get(field) or 0) for step in steps if step.get("role") == "agent")
            for key, field in mapping.items()
        }
        result = MessageResult(
            response=end.get("content", ""),
            messages=steps,
            usage=usage,
            stats={"steps": sum(step.get("role") == "agent" for step in steps)},
            stopped=False,
            completed=True,
        )
        self.agent._last_result = result
        return result


if __name__ == "__main__":
    from dotenv import load_dotenv

    load_dotenv(KB_ROOT.parent.parent / ".env", override=False)
    import systems

    # OBS_ARM names a knob variant so each variant keeps its own scratch directory.
    name = DataflowObservationFormatLuna._NAME + os.environ.get("OBS_ARM", "")
    arm = type(name, (DataflowObservationFormatLuna,), {"_NAME": name})
    setattr(systems, name, arm)
    os.chdir(KB_ROOT)
    sys.argv[1:1] = ["--sut", name]
    runpy.run_path(str(KB_ROOT / "evaluate.py"), run_name="__main__")
