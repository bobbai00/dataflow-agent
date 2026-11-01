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
"""bench run: one KramaBench or PrepBench run of BobFlow or Script ReAct on a stack.

    bench run kramabench bobflow --output <run> --models Luna --arms evidence_data1_flow0_opt_strict --all-tasks
    bench run prepbench scriptreact --output <run> --models Luna --all-tasks

Run inside the stack's environment (run-env.sh): the agent, engine, gateway and wire-trace folder come from its
profile. The run folder must not exist. Every attempt is scored by KramaBench's evaluator (PrepBench's tables later by
`bench score prepbench`), and its cost reconciled from the exact model responses.
"""
import argparse
import os
from pathlib import Path

from bobbench.arms import ARMS, SCRIPT_REACT, base_settings, full_result_char_limit
from bobbench.kramabench.tasks import BENCHMARKS, inventory, tasks
from bobbench.models import MODEL_TYPES, price_schedule
from bobbench.paths import KB, REPO, SCRIPTREACT_PYTHON
from bobbench.provenance import diff_sha256, revision, sha256, source_snapshot
from bobbench import runner

# Defaults of the paper's runs: BobFlow 900 s per attempt on both benchmarks; Script ReAct 1,200 s on KramaBench and
# 900 s on PrepBench; one large-input task at a time (KramaBench inputs over 100 MB; PrepBench has none that large).
TIMEOUT = {("bobflow", "kramabench"): 900, ("bobflow", "prepbench"): 900, ("scriptreact", "kramabench"): 1200,
           ("scriptreact", "prepbench"): 900}
LARGE_INPUT_BYTES = {"kramabench": 100_000_000, "prepbench": 5_000_000_000}
# What a BobFlow run's source snapshot covers: the agent, the engine, the harness and the gateway's tool hook.
SOURCES = ["agent-service/src", "amber/src", "benchmark/src", "bin/strict_tools.py"]
ISOLATION = ("bubblewrap: the task's input directory read-only at its relative path, a private working directory, no "
             "network. smolagents runs whole in the sandbox and reaches the gateway through a Unix socket.")


def judge_cache():
    """KramaBench's judge verdict cache, as the evaluator will read it at this run's start."""
    path = Path(os.environ.get("KRAMABENCH_PARAPHRASE_CACHE") or KB / "benchmark/fixtures/paraphrase_cache.json")
    return {"path": str(path), "sha256": sha256(path) if path.is_file() else None}


def parser():
    p = argparse.ArgumentParser(prog="bench run", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    p.add_argument("benchmark", choices=sorted(BENCHMARKS))
    p.add_argument("system", choices=["bobflow", "scriptreact"])
    p.add_argument("--output", type=Path, required=True, help="the run folder (must not exist)")
    p.add_argument("--models", nargs="+", required=True, choices=list(MODEL_TYPES), metavar="TAG",
                   help=f"model tags: {', '.join(MODEL_TYPES)}")
    p.add_argument("--arms", nargs="+", choices=list(ARMS), metavar="ARM",
                   help=f"BobFlow arms (required for bobflow): {', '.join(ARMS)}")
    which = p.add_mutually_exclusive_group(required=True)
    which.add_argument("--tasks", nargs="+", metavar="TASK")
    which.add_argument("--all-tasks", action="store_true", help="every task of the benchmark (104 / 306)")
    p.add_argument("--repetitions", type=int, default=1)
    p.add_argument("--workers", type=int, default=2, help="attempts at once")
    p.add_argument("--large-input-bytes", type=int, help="inputs at least this large count as large (default: "
                   "KramaBench 100 MB, PrepBench 5 GB)")
    p.add_argument("--large-workers", type=int, default=1, help="large-input attempts at once")
    p.add_argument("--timeout", type=int, help="wall-clock seconds per attempt (default: 900; Script ReAct on "
                   "KramaBench 1,200)")
    p.add_argument("--selection", help="why these tasks (recorded in the manifest)")
    flow = p.add_argument_group("BobFlow")
    flow.add_argument("--endpoint", default=os.environ.get("TEXERA_AGENT_SERVICE_ENDPOINT"),
                      help="agent service (default: the stack's, TEXERA_AGENT_SERVICE_ENDPOINT)")
    flow.add_argument("--wire-dir", type=Path, default=os.environ.get("TEXERA_LLM_TRACE_DIR"),
                      help="the agent's TEXERA_LLM_TRACE_DIR, for exact usage and cost (default: the stack's)")
    flow.add_argument("--sample-char-limit", type=int, default=2000, help="characters of a sample with statistics")
    flow.add_argument("--full-result-char-limit", type=full_result_char_limit, default=5000,
                      help="characters of a whole result, 128..100000")
    flow.add_argument("--agent-revision", help="the revision the agent serves (default: this checkout's HEAD)")
    flow.add_argument("--engine-revision", help="the revision the engine was built from")
    script = p.add_argument_group("Script ReAct")
    offset = os.environ.get("TEXERA_LOCAL_DEV_PORT_OFFSET")
    script.add_argument("--script-endpoint", default=f"http://localhost:{int(offset) + 4001}/v1" if offset else None,
                        help="OpenAI-compatible gateway (default: the stack's smolagents gateway, offset + 4001; Haiku "
                             "routes are on the main gateway, $LITELLM_BASE_URL/v1)")
    script.add_argument("--script-python", type=Path, default=SCRIPTREACT_PYTHON,
                        help="the locked interpreter (envs/scriptreact/setup.sh)")
    return p


def task_list(args, found, error):
    known = {t["task_id"] for t in found}
    if args.all_tasks:
        if args.benchmark == "kramabench":
            ids = sorted(known)
            if len(ids) != 104:
                error(f"{len(ids)} KramaBench tasks, expected 104")
            return ids, "All 104 original KramaBench top-level tasks; no task exclusions or outcome-selected retries."
        # PrepBench in workload order, as its runs listed them.
        ids = [t["id"] for t in tasks("prepbench")]
        return ids, f"PrepBench, all {len(ids)} cases; no outcome-selected retries."
    if len(set(args.tasks)) != len(args.tasks):
        error("duplicate task ids")
    unknown = sorted(set(args.tasks) - known)
    if unknown:
        error(f"not tasks of {args.benchmark}: {', '.join(unknown)}")
    return args.tasks, "Tasks chosen before the run: " + " ".join(args.tasks)


def main(argv=None):
    p = parser()
    args = p.parse_args(argv)
    system, benchmark = args.system, args.benchmark
    if min(args.workers, args.large_workers, args.repetitions, args.timeout or 1) < 1:
        p.error("workers, repetitions and timeout must be positive")
    if system == "bobflow" and not args.arms:
        p.error("bobflow needs --arms")
    if system == "scriptreact" and args.arms:
        p.error("Script ReAct has no arms")
    output = args.output.resolve()
    if output.exists():
        p.error(f"refusing to overwrite {output}")
    found = inventory(BENCHMARKS[benchmark])
    task_ids, selection = task_list(args, found, p.error)
    runner.load_env(REPO / ".env", KB / ".env")
    if os.environ.get("OPENAI_API_KEY") in (None, "", "dummy"):
        p.error("KramaBench's judge needs OPENAI_API_KEY")
    tag = output.name.replace("-", "_")
    models = {m: MODEL_TYPES[m] for m in args.models}
    manifest = {"system": system, "benchmark": benchmark, "runner_revision": revision(REPO),
                "harness_revision": revision(KB), "models": models,
                "pricing_schedules": {model: price_schedule(model) for model in models.values()},
                "task_ids": task_ids, "repetitions": args.repetitions, "pass_threshold": 1.0,
                "selection": args.selection or selection,
                "attempt_policy": "Independent repetitions of every selected task; no outcome-selected retries.",
                "task_timeout_seconds": args.timeout or TIMEOUT[system, benchmark], "workers": args.workers,
                "large_input_bytes": args.large_input_bytes or LARGE_INPUT_BYTES[benchmark],
                "large_workers": args.large_workers, "judge_cache": judge_cache()}
    if system == "bobflow":
        if not args.endpoint:
            p.error("no agent endpoint: run inside the stack's environment or pass --endpoint")
        digest, files = source_snapshot(REPO, SOURCES)
        manifest.update({
            "agent_revision": args.agent_revision or revision(REPO), "engine_revision": args.engine_revision,
            "endpoint": args.endpoint.rstrip("/"), "wire_directory": str(args.wire_dir.resolve()) if args.wire_dir else None,
            "working_tree_diff_sha256": diff_sha256(REPO, ["agent-service", "amber", "benchmark/src", "bin"]),
            "working_tree_sources_sha256": digest, "arms": {arm: ARMS[arm] for arm in args.arms},
            "settings": base_settings(args.sample_char_limit, args.full_result_char_limit)})
        arms = args.arms
    else:
        if not args.script_endpoint:
            p.error("no gateway: run inside the stack's environment or pass --script-endpoint")
        if not (os.environ.get("LITELLM_MASTER_KEY") or os.environ.get("CODE_AGENT_API_KEY")):
            p.error("the gateway key (LITELLM_MASTER_KEY or CODE_AGENT_API_KEY) is not set")
        from bobbench.scriptreact.interpreter import locked
        try:
            script_python = locked(args.script_python)
        except ValueError as error:
            p.error(str(error))
        manifest.update({"script_endpoint": args.script_endpoint.rstrip("/"), "script_settings": SCRIPT_REACT,
                         "script_python": script_python, "isolation": ISOLATION,
                         "workspaces": str(output / "workspaces")})
        arms = ["smolagents"]
    manifest["input_inventory"] = found
    manifest["jobs"] = runner.jobs(system, list(models), arms, task_ids, args.repetitions, tag)
    output.mkdir(parents=True)
    if system == "bobflow":
        runner.save(output / "source-snapshot.json", {"captured_at": runner.now(), "sha256": digest,
                                                      "matches_launch_manifest": True, "files": files})
    runner.save(output / "manifest.json", manifest)
    progress = runner.Run(output, manifest, workers=args.workers, large_workers=args.large_workers).run()
    return progress


if __name__ == "__main__":
    main()
