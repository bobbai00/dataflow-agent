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
"""Prepare an Opus 5.5 campaign from the recorded Opus 4.8 configurations.

Preparation freezes both checkouts and writes launch scripts; it makes no model
calls. The private _run command adds the model and its prices to those runners
without changing their prompts, evaluators, task selection, or retry policies.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
LICENSE_HEADER = Path(__file__).read_text().split('"""', 1)[0].strip()
MODEL = "claude-opus-5.5"
MODEL_TAG = "Opus55"
# Readable thinking text in the traces; the agents keep it out of their context.
THINKING = {"type": "adaptive", "display": "summarized"}
ARM_NAMES = ("evidence_full_flow0", "evidence_data1_flow0",
             "evidence_full_flow1", "evidence_data1_flow1")
REFERENCE = Path("/var/tmp/texera-registered-python/dev2/benchmark/retrieval/runs")


def price_schedule():
    return {"model": MODEL, "kind": "token_estimate", "currency": "USD",
            "unit": "per_token", "verified_on": "2026-10-12",
            "source": "https://platform.claude.com/docs/en/models/opus-5-5/overview",
            "rates": {"input": 4e-6, "output": 20e-6, "cache_read": .2e-6,
                      "cache_creation": 5e-6}, "long_context_threshold": None,
            "input_includes_cached": True, "output_includes_reasoning": True}


def build_plan(dag, smol, output):
    tasks = dag["task_ids"]
    if len(tasks) != 104 or len(set(tasks)) != 104 or set(tasks) != set(smol["task_ids"]):
        raise ValueError("Reference task sets must match and contain 104 distinct tasks")
    harness = dag["harness_revision"].removesuffix("+dirty")
    if harness != smol["harness_revision"].removesuffix("+dirty"):
        raise ValueError("Reference harness revisions differ")
    if set(dag["arms"]) != set(ARM_NAMES):
        raise ValueError("Reference must contain the four evidence arms")
    if dag["settings"]["maxSteps"] != smol["script_settings"]["max_steps"]:
        raise ValueError("Reference step budgets differ")
    if any(ref["pass_threshold"] != 1.0 for ref in [dag, smol]):
        raise ValueError("Reference pass threshold must be 1.0")
    output = Path(output).resolve()
    settings = {"model": "anthropic/claude-opus-5-5",
                "thinking": dict(THINKING), "output_config": {"effort": "medium"},
                "additional_drop_params": ["temperature", "top_p", "top_k"]}
    return {"model": MODEL, "model_tag": MODEL_TAG, "repetitions": 3,
            "agent_revision": dag["agent_revision"], "harness_revision": harness,
            "output": str(output), "runtime": str(output / "runtime"),
            "gateway": settings, "pricing": price_schedule(), "pass_threshold": 1.0,
            "attempt_policy": "Three independent attempts per task and solution; no best-of selection or outcome-selected retries.",
            "dag": {"settings": copy.deepcopy(dag["settings"]),
                    "arms": copy.deepcopy(dag["arms"]), "attempts": 1248,
                    "workers": dag["workers"], "timeout_seconds": dag["task_timeout_seconds"],
                    "max_output_tokens_per_call": 8192, "model_retries_per_turn": 2},
            "smolagents": {"settings": copy.deepcopy(smol["script_settings"]),
                           "attempts": 312, "workers": smol["workers"],
                           "timeout_seconds": smol["task_timeout_seconds"],
                           "max_output_tokens_per_call": None},
            "large_workers": dag["large_workers"], "large_input_bytes": dag["large_input_bytes"],
            "task_ids": list(tasks),
            "jobs": [{"solution": solution, "rep": rep, "task": task}
                     for solution in [*ARM_NAMES, "smolagents"]
                     for rep in range(1, 4) for task in tasks]}


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def shell_script(path, arguments, environment_script, working_directory):
    path.write_text("#!/usr/bin/env bash\n" + LICENSE_HEADER + "\nset -euo pipefail\n"
                    + "cd " + shlex.quote(str(working_directory)) + "\n"
                    + "exec bash " + shlex.quote(str(environment_script)) + " "
                    + shlex.join([str(arg) for arg in arguments]) + "\n")
    path.chmod(0o755)


def patch_model_accounting(runtime):
    """Install the same price in each evaluator's process, outside its sandbox."""
    directory = runtime / "benchmark/retrieval"
    path = directory / "campaign.py"
    source = path.read_text()
    marker = "    for model in models:\n"
    addition = ("        if model == 'claude-opus-5.5':\n"
                "            from opus55 import price_schedule\n"
                "            price = price_schedule()\n"
                "            cost_module._FALLBACK[model] = tuple(price['rates'].values())\n"
                "            frozen[model] = price\n"
                "            continue\n")
    if addition not in source:
        if source.count(marker) != 1:
            raise ValueError("Reference campaign accounting changed")
        path.write_text(source.replace(marker, marker + addition, 1))


def prepare(args):
    dag_path, smol_path = args.reference_dag.resolve(), args.reference_smol.resolve()
    dag, smol = json.loads(dag_path.read_text()), json.loads(smol_path.read_text())
    output = args.output.resolve()
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite {output}")
    plan = build_plan(dag, smol, output)
    source_harness = ROOT / "benchmark/Kramabench"
    # Check both revisions and dependencies before creating any directories.
    for repo, revision in [(ROOT, plan["agent_revision"]), (source_harness, plan["harness_revision"])]:
        subprocess.run(["git", "-C", str(repo), "cat-file", "-e", revision + "^{commit}"], check=True)
    for dependency in [source_harness / ".venv", ROOT / "agent-service/node_modules", args.environment_script]:
        if not dependency.exists():
            raise FileNotFoundError(dependency)
    output.mkdir(parents=True)
    runtime = Path(plan["runtime"])
    subprocess.run(["git", "-C", str(ROOT), "worktree", "add", "--detach",
                    str(runtime), plan["agent_revision"]], check=True, stdout=subprocess.PIPE)
    kb = runtime / "benchmark/Kramabench"
    subprocess.run(["git", "-C", str(source_harness), "worktree", "add", "--detach",
                    str(kb), plan["harness_revision"]], check=True, stdout=subprocess.PIPE)
    for target, source in [(kb / "data", source_harness / "data"),
                           (kb / ".venv", source_harness / ".venv"),
                           (runtime / "agent-service/node_modules", ROOT / "agent-service/node_modules"),
                           (runtime / ".env", ROOT / ".env"), (kb / ".env", source_harness / ".env")]:
        if source.exists() and not target.exists() and not target.is_symlink():
            target.symlink_to(source.resolve(), target_is_directory=source.is_dir())
    if not (runtime / "data").exists():
        (runtime / "data").symlink_to(kb / "data", target_is_directory=True)
    adapter = runtime / "benchmark/retrieval/opus55.py"
    shutil.copyfile(__file__, adapter)
    patch_model_accounting(runtime)
    plan["adapter_sha256"] = hashlib.sha256(adapter.read_bytes()).hexdigest()
    plan["references"] = {"dag": str(dag_path), "smolagents": str(smol_path)}
    plan["endpoints"] = {"agent": args.agent_endpoint, "gateway": args.gateway_endpoint}
    plan["inherited_engine"] = "Existing isolated campaign backend; engine revision was not recorded by the reference."
    plan["dependency_note"] = "Pinned source checkouts reuse the installed campaign Python environment and locked agent dependencies; package lists are recorded below."
    plan["python_packages"] = subprocess.check_output(
        [str(kb / ".venv/bin/python"), "-c",
         "from importlib.metadata import distributions; "
         "print('\\n'.join(sorted(d.metadata['Name'] + '==' + d.version for d in distributions())))"],
        text=True).splitlines()
    save(output / "plan.json", plan)
    shutil.copyfile(dag_path, output / "reference-dag.json")
    shutil.copyfile(smol_path, output / "reference-smolagents.json")
    common = [kb / ".venv/bin/python", adapter, "_run"]
    environment = ["env", "TEXERA_API_ENDPOINT=http://localhost:30080",
                   "TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:30888",
                   "TEXERA_WORKFLOW_EXECUTION_ENDPOINT=http://localhost:30085"]
    shared = ["--all-tasks", "--repetitions", "3", "--large-workers", str(plan["large_workers"]),
              "--large-input-bytes", str(plan["large_input_bytes"])]
    dag_args = [*common, "dag", "--output", output / "dag", "--endpoint", args.agent_endpoint,
                "--models", MODEL_TAG, "--arms", *ARM_NAMES, *shared,
                "--workers", str(plan["dag"]["workers"]),
                "--timeout", str(plan["dag"]["timeout_seconds"]), "--direct-artifacts",
                "--full-result-char-limit", str(plan["dag"]["settings"]["fullResultCharLimit"]),
                "--sample-char-limit", str(plan["dag"]["settings"]["maxOperatorResultCharLimit"]),
                "--wire-dir", output / "wire", "--agent-revision", plan["agent_revision"],
                "--selection", "Matched Opus 5.5 comparison; recorded Opus 4.8 campaign settings."]
    smol_args = [*common, "smolagents", "--output", output / "smolagents",
                 "--script-endpoint", args.gateway_endpoint, "--model", MODEL_TAG,
                 "--systems", "smolagents", *shared, "--workers", str(plan["smolagents"]["workers"]),
                 "--timeout", str(plan["smolagents"]["timeout_seconds"]),
                 "--max-steps", str(plan["smolagents"]["settings"]["max_steps"]),
                 "--output-chars", str(plan["smolagents"]["settings"]["max_print_outputs_length"]),
                 "--prompt", "custom"]
    for name, command in [("run-dag.sh", dag_args), ("run-smolagents.sh", smol_args)]:
        shell_script(output / name, [*environment, *command], args.environment_script.resolve(), runtime)
    # The supported launcher can serve the frozen agent alongside the existing stack.
    port = args.agent_endpoint.rsplit(":", 1)[-1]
    profile = output / "agent-profile.sh"
    profile.write_text("#!/usr/bin/env bash\n" + LICENSE_HEADER + "\nsource " + shlex.quote(str(args.stack_profile.resolve())) + "\n"
                       + f"export TEXERA_AGENT_SERVICE_PORT={shlex.quote(port)}\n"
                       + "export TEXERA_LOCAL_DEV_DIR=" + shlex.quote(str(output / "service-state")) + "\n"
                       + "export TEXERA_LLM_TRACE_DIR=" + shlex.quote(str(output / "wire")) + "\n"
                       + "export UDF_PYTHON_PATH=" + shlex.quote(str(runtime / "benchmark/retrieval/native_isolated_python.py")) + "\n"
                       + "export MODEL_RETRIES_PER_TURN=2\nexport MODEL_MAX_OUTPUT_TOKENS=8192\n")
    shell_script(output / "start-agent.sh", ["env", f"TEXERA_LOCAL_DEV_PROFILE={profile}",
                 runtime / "bin/local-dev.sh", "up", "agent-service", "--skip-build"],
                 args.environment_script.resolve(), runtime)
    route = {"model_name": MODEL, "litellm_params": {
        **plan["gateway"], "api_key": "os.environ/ANTHROPIC_API_KEY",
        "cache_control_injection_points": [{"location": "message", "role": "system"},
                                             {"location": "message", "index": -2},
                                             {"location": "message", "index": -1}]}}
    save(output / "gateway-route.json", route)
    print(json.dumps({"prepared": str(output), "dag_attempts": 1248, "smolagents_attempts": 312,
                      "agent_revision": plan["agent_revision"], "thinking": THINKING, "effort": "medium"}))


def run_frozen(solution, forwarded):
    """Register only the new model; reuse the frozen runners unchanged."""
    sys.path.insert(0, str(ROOT / "benchmark/retrieval"))
    import campaign
    import metrics
    original_prices, original_install = metrics.current_price_schedule, campaign.install_provider_prices

    def schedule(model):
        return price_schedule() if model == MODEL else original_prices(model)

    def install(cost_module, models):
        result = original_install(cost_module, models)
        if MODEL in models:
            price = price_schedule()
            cost_module._FALLBACK[MODEL] = tuple(price["rates"].values())
            result[MODEL] = price
        return result

    metrics.current_price_schedule = schedule
    campaign.install_provider_prices = install
    import run
    run.MODEL_TYPES[MODEL_TAG] = MODEL
    old_save = run.save

    def record(path, value):
        if Path(path).name == "manifest.json":
            value = {**value, "model_generation_settings": {
                "thinking": dict(THINKING), "effort": "medium", "configured_at": "gateway"},
                     "pricing_schedules": {MODEL: price_schedule()},
                     "experiment_adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        return old_save(path, value)

    run.save = record
    if solution == "smolagents":
        import run_baselines as runner
    else:
        runner = run
    sys.argv = [runner.__file__, *forwarded]
    runner.main()


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "_run":
        run_frozen(sys.argv[2], sys.argv[3:])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference-dag", type=Path,
                        default=REFERENCE / "20261010-reps-opus48/manifest.json")
    parser.add_argument("--reference-smol", type=Path,
                        default=REFERENCE / "20261010-smolagents-reps-opus48/manifest.json")
    parser.add_argument("--agent-endpoint", default="http://localhost:3090")
    parser.add_argument("--gateway-endpoint", default="http://localhost:26000/v1")
    parser.add_argument("--environment-script", type=Path,
                        default=Path("/var/tmp/texera-registered-python/run-env.sh"))
    parser.add_argument("--stack-profile", type=Path,
                        default=Path("/var/tmp/texera-registered-python/profile.sh"))
    prepare(parser.parse_args())


if __name__ == "__main__":
    main()
