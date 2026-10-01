#!/usr/bin/env python3
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

"""Run one prepared LongDS task end to end, under the official protocol, with
either the script agent or the dataflow agent, and write upstream's artifact so
`judge_longds.py` scores it unchanged.

Both arms receive byte-identical task text (see `official_protocol.py`): the
upstream context and question, a file inventory, and an answer marker. Neither is
told the shape of the expected answer. The only difference is one paragraph
describing how that arm's own state persists, and the runtime each drives.

    python run_official.py --task education__world_university_rankings__task2 \
        --arm code --model gpt-5.6-luna
    python judge_longds.py --sut LongDS_Official_code_luna \
        --judge-model deepseek/deepseek-v4-pro
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from _paths import KB_ROOT as _WORKTREE_KB_ROOT, PREPARED, SCRATCH

#: The KramaBench submodule is checked out in the main clone only; a worktree's
#: copy of `benchmark/Kramabench` is empty. The script agent's wrapper, its venv
#: and the `data/` tree all live there, so resolve to whichever has them.
KB_ROOT = _WORKTREE_KB_ROOT if (_WORKTREE_KB_ROOT / "code_agent.py").exists() else Path(
    "/home/bob/Desktop/dataflow-agent/benchmark/Kramabench"
)
from official_protocol import build_prompts, extract_answer, selftest, write_records

WORKTREE = Path(__file__).resolve().parents[2]
SCRIPT_ARMS = {"code", "smolagents-custom"}
DSGYM_ARMS = {"dsgym", "dsgym-functions", "dsgym-shared", "dsgym-shared-cs", "dsgym-shared-ci"}
# The context-budget arms: DSGym with our task text and compaction (a running
# summary; plus the live kernel inventory), and the dataflow arm's budgeted
# catalog, all under the budget in LONGDS_CONTEXT_BUDGET (tokens a call).
COMPACTION = {"dsgym-shared-cs": "summary", "dsgym-shared-ci": "inventory"}
# The environment-reset condition (LONGDS_RESET=mid|<turn>): before that turn
# the running session's computed state is lost (DSGym: upstream's
# reset_env_times, a fresh kernel; dataflow: the engine's cached results
# cleared). Both arms read this notice at the start of the turn.
RESET_NOTICE = '(Before this request the analysis environment was restarted: every result computed earlier and held in the running session is gone. The data files are unchanged.)'


def refresh_plan(manifest: dict, turns: int) -> dict | None:
    """The data-refresh condition (LONGDS_REFRESH=mid|<turn>): the corrected
    extract built by refresh-probe.py under LONGDS_REFRESH_ROOT, where it
    goes, the notice, and the gold of the refreshed turns."""
    value = os.environ.get("LONGDS_REFRESH", "").strip()
    if not value:
        return None
    turn = turns // 2 + 1 if value == "mid" else int(value)
    if not 1 < turn <= turns:
        return None
    root = Path(os.environ["LONGDS_REFRESH_ROOT"])
    name = f"{manifest['key']}-s{os.environ.get('LONGDS_REFRESH_SEED', '1')}"
    source = root / name / "data"  # the corrected copy of the task's data directory
    answers = json.loads((root / f"{name}.answers.json").read_text())
    dest_rel = f"{manifest['data_dir']}/corrected"
    files = sorted(f"{dest_rel}/{p.relative_to(source)}" for p in source.rglob("*") if p.is_file())
    notice = (
        "The data provider has sent a corrected extract of the data files (some records were withdrawn). "
        "The corrected files have the same names and layout as the originals and are at these paths "
        "(relative, as before):\n" + "\n".join(f" - {f}" for f in files) + "\n"
        "From this request on, use the corrected files: every table and result from the earlier requests "
        "must be recomputed on them. The definitions and rules of this session stay as they were."
    )
    return {"turn": turn, "source": source, "dest": WORKTREE / dest_rel, "notice": notice, "answers": answers,
            "name": name}


def reset_turn(turns: int) -> int | None:
    value = os.environ.get("LONGDS_RESET", "").strip()
    if not value:
        return None
    turn = turns // 2 + 1 if value == "mid" else int(value)
    return turn if 1 < turn <= turns else None
DATAFLOW_ARMS = {
    "react-full", "react-catalog", "react-entries", "react-restore", "react-analysis", "react-efficient",
    "react-registry", "react-registry-sig", "react-lean", "react-lean2", "react-lean2-full", "react-lean2-budget",
}
HERE = Path(__file__).resolve().parent
DSGYM_PYTHON = HERE / ".dsgym-venv/bin/python"  # litellm; see dsgym_agent.py


def run_script_arm(prompts, out_dir, model, env_file, turn_timeout, *, custom=False, manifest=None):
    """smolagents CodeAgent over a persistent interpreter: the agent is reset only
    on turn 1, so its conversation and its Python variables both carry forward.
    That is the paper's own baseline shape (ReAct over a persistent kernel)."""
    from dotenv import load_dotenv

    load_dotenv(env_file, override=False)
    sys.path.insert(0, str(KB_ROOT.resolve()))
    from code_agent import CodeAgentWrapper

    wrapper = CodeAgentWrapper(
        model_type=model,
        max_steps=40,
        max_print_outputs_length=5000 if custom else 2000,
        use_custom_prompt=custom,
        use_fine_grained_prompt=False,
        use_pitfalls_prompt=False,
        verbosity_level=0,
        api_base=os.getenv("CODE_AGENT_API_BASE", "http://localhost:4000"),
        api_key=os.getenv("LITELLM_MASTER_KEY", "dummy"),
    ).setup()
    if custom:
        wrapper._model.kwargs['max_tokens'] = 8192
        wrapper._model.kwargs['reasoning_effort'] = 'medium'
        from smolagents_executor import IsolatedSmolExecutor
        wrapper._agent.python_executor = IsolatedSmolExecutor(
            (WORKTREE / manifest['data_dir']).resolve(), manifest['data_dir'],
            out_dir / 'python-workspace', wrapper.authorized_imports, 5000,
            timeout=min(turn_timeout, 600),
        )
    (out_dir / 'system_prompt.txt').write_text(wrapper._agent.system_prompt)
    original_generate = wrapper._model.generate
    active_turn = 0

    def capture_generate(*args, **kwargs):
        message = original_generate(*args, **kwargs)
        raw = getattr(message, 'raw', None)
        usage = getattr(raw, 'usage', None)
        choices = getattr(raw, 'choices', []) or []
        call = {'turn_id': active_turn, 'model': getattr(raw, 'model', model),
                'finish_reason': getattr(choices[0], 'finish_reason', None) if choices else None,
                'usage': usage.model_dump() if hasattr(usage, 'model_dump') else str(usage)}
        with (out_dir / 'calls.jsonl').open('a') as stream:
            stream.write(json.dumps(call, default=str) + '\n')
        return message

    wrapper._model.generate = capture_generate
    os.chdir(KB_ROOT)  # data/... paths in the prompts resolve from here, as upstream's runner does
    answers, prior = [], 0
    for index, turn in enumerate(prompts, 1):
        active_turn = turn['turn_id']
        directory = out_dir / f"t{index:02}"
        directory.mkdir(parents=True)
        (directory / "prompt.json").write_text(json.dumps(turn, indent=2))
        wrapper._model.reset_usage()
        started = time.monotonic()
        error = None
        try:
            result = wrapper._agent.run(turn["prompt"], reset=index == 1, return_full_result=True)
            raw = result.output
            if hasattr(raw, "to_raw"):
                raw = raw.to_raw()
            raw = "" if raw is None else str(raw)
        except (Exception, SystemExit) as failure:  # a failed turn is recorded, never fatal
            raw, error = "", str(failure)
        memory = wrapper._agent.memory.steps
        steps = memory[prior:]
        prior = len(memory)
        trace = []
        for step in steps:
            item = {"type": type(step).__name__}
            for name in ("step_number", "model_output", "code_action", "observations", "action_output", "error"):
                value = getattr(step, name, None)
                if value is not None:
                    item[name] = value
            trace.append(item)
        (directory / "react_steps.json").write_text(json.dumps(trace, indent=2, default=str))
        usage = wrapper._model.usage_acc
        got = lambda key: int(usage.get(key, 0) or 0)
        input_tokens, output_tokens, cached, written = got("input"), got("output"), got("cached"), got("cache_creation")
        stats = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_tokens": cached,
            "cache_write_tokens": written,
            "reasoning_tokens": got("reasoning"),
            "llm_calls": got("calls"),
            "cost_usd": (
                (input_tokens - cached - written) * 0.2 + cached * 0.02 + written * 0.25 + output_tokens * 1.2
            )
            / 1e6,
            "elapsed_seconds": time.monotonic() - started,
        }
        (directory / "stats.json").write_text(json.dumps(stats, indent=2))
        answer = extract_answer(raw)
        (directory / "answer.json").write_text(json.dumps({"raw": raw, "answer": answer, "error": error}, indent=2))
        answers.append({"turn_id": turn["turn_id"], "answer": answer, "error": error, "steps": len(steps), "stats": stats})
        print(json.dumps({"arm": "smolagents-custom" if custom else "code", "model": model, "turn": turn["turn_id"], **stats}), flush=True)
    if custom:
        wrapper._agent.python_executor.cleanup()
    return answers


def run_dsgym_arm(prepared, out_dir, model, env_file, turn_limit, *, functions=False, shared=False, compaction=None,
                  reset=None, refresh=None):
    """The paper's own agent: DSGym's MultiTurnReActDSAgent, SYSTEM_PROMPT and
    <python>/<answer> protocol, unchanged (dsgym_agent.py), over a local
    persistent Jupyter kernel that speaks its executor manager's HTTP contract
    (dsgym_executor.py) instead of the docker sandbox."""
    import socket
    import urllib.request
    from dotenv import load_dotenv

    load_dotenv(env_file, override=False)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    executor_url = f"http://127.0.0.1:{port}"
    api_base = os.environ.get("LITELLM_BASE_URL", "http://localhost:4000").rstrip("/") + "/v1"
    manifest = json.loads((prepared / "manifest.json").read_text())
    data_root = (WORKTREE / manifest["data_dir"]).resolve()
    with (out_dir / "executor.log").open("w") as executor_log, (out_dir / "runner.log").open("w") as log:
        executor = subprocess.Popen(
            [str(KB_ROOT / ".venv/bin/python"), str(HERE / "dsgym_executor.py"), "--port", str(port),
             "--data-root", str(data_root), "--workspace", str(out_dir / "kernel-workspaces"),
             "--data-relative", manifest["data_dir"]],
            cwd=WORKTREE, stdout=executor_log, stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"{executor_url}/health", timeout=1).read()
                    break
                except Exception:
                    time.sleep(0.5)
            else:
                raise RuntimeError("dsgym_executor.py did not come up")
            command = [
                str(DSGYM_PYTHON), str(HERE / "dsgym_agent.py"),
                "--manifest", str(prepared / "manifest.json"), "--gold", str(prepared / "gold.json"),
                "--model", model, "--out", str(out_dir / "agent"),
                "--executor-url", executor_url, "--api-base", api_base,
            ]
            if turn_limit:
                command += ["--turn-limit", str(turn_limit)]
            if functions:
                command += ["--functions"]
            if shared:
                command += ["--shared-protocol"]
            if compaction:
                command += ["--context-budget", os.environ["LONGDS_CONTEXT_BUDGET"], "--compaction", compaction]
            if reset:
                command += ["--reset-at", str(reset), "--reset-notice", RESET_NOTICE]
            if refresh:
                command += ["--refresh-at", str(refresh["turn"]), "--refresh-src", str(refresh["source"]),
                            "--refresh-dest", str(refresh["dest"]), "--refresh-notice", refresh["notice"]]
            subprocess.run(command, cwd=WORKTREE, env=os.environ, stdout=log, stderr=subprocess.STDOUT, check=True)
        finally:
            executor.terminate()
            try:
                executor.wait(timeout=30)
            except subprocess.TimeoutExpired:
                executor.kill()
    answers_path = out_dir / "agent/answers.json"
    return json.loads(answers_path.read_text()) if answers_path.exists() else []


def run_dataflow_arm(prompts, out_dir, arm, model, turn_timeout):
    """One agent-service session for the whole task, driven by the Bun runner."""
    out_dir.mkdir(parents=True, exist_ok=True)
    prompts_path = out_dir / "prompts.json"
    prompts_path.write_text(json.dumps(prompts, indent=2))
    turns_dir = out_dir / "turns"
    command = [
        "bun",
        "run",
        str(WORKTREE / "agent-service/benchmark/multiturn/run-longds-turns.ts"),
        str(prompts_path),
        str(turns_dir),
        arm,
        model,
    ]
    with (out_dir / "runner.log").open("w") as log:
        subprocess.run(command, cwd=WORKTREE, env=os.environ, stdout=log, stderr=subprocess.STDOUT, check=False)
    recorded = json.loads((turns_dir / "answers.json").read_text()) if (turns_dir / "answers.json").exists() else []
    return [dict(item, answer=extract_answer(item.get("answer") or "")) for item in recorded]


def runtime_provenance():
    """Include untracked runtime source, without copying local configuration or credentials."""
    digest = hashlib.sha256()
    paths = sorted((WORKTREE / "agent-service/src").rglob("*"))
    paths += sorted(HERE.glob("*.py"))
    paths += [WORKTREE / "agent-service/benchmark/multiturn/run-longds-turns.ts"]
    paths += [WORKTREE / "agent-service/benchmark/multiturn/checked-turn.ts"]
    for path in paths:
        if path.is_file() and path.suffix in {".ts", ".py", ".md"}:
            digest.update(str(path.relative_to(WORKTREE)).encode() + b"\0" + path.read_bytes() + b"\0")
    return {
        "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=WORKTREE, text=True).strip(),
        "source_sha256": digest.hexdigest(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True, help="prepared task key")
    ap.add_argument("--arm", required=True, choices=sorted(SCRIPT_ARMS | DSGYM_ARMS | DATAFLOW_ARMS))
    ap.add_argument("--model", default="gpt-5.6-luna")
    ap.add_argument("--sut", help="run name (default: LongDS_Official_<arm>_<model tail>)")
    ap.add_argument("--turn-limit", type=int)
    ap.add_argument("--turn-timeout", type=int, default=1200)
    ap.add_argument("--env-file", type=Path, default=WORKTREE.parents[2] / ".env")
    ap.add_argument("--prepared-root", type=Path, default=PREPARED,
                    help="separate prepared specifications for a pinned dataset version")
    args = ap.parse_args()
    # The script agent's interpreter is KramaBench's venv: its sandbox authorizes
    # imports (fiona, geopandas, ...) that only that environment installs. Re-exec
    # rather than ask the caller to remember which interpreter each arm needs.
    if args.arm in SCRIPT_ARMS:
        wanted = KB_ROOT / ".venv/bin/python"
        if wanted.exists() and Path(sys.executable).resolve() != wanted.resolve():
            os.execv(str(wanted), [str(wanted), str(Path(__file__).resolve()), *sys.argv[1:]])
    selftest()

    prepared = args.prepared_root / args.task
    manifest = json.loads((prepared / "manifest.json").read_text())
    gold = json.loads((prepared / "gold.json").read_text())
    kind = "script" if args.arm in SCRIPT_ARMS | DSGYM_ARMS else "dataflow"
    prompts = build_prompts(manifest, "smolagents" if args.arm == "smolagents-custom" else kind)[: args.turn_limit]
    reset = reset_turn(len(prompts))
    refresh = refresh_plan(manifest, len(prompts))
    if refresh:
        if refresh["dest"].exists():
            print(f"FATAL: {refresh['dest']} exists (another refresh run, or a leftover); remove it first")
            return 2
        # The refreshed turns are judged against the reference notebook replayed on the corrected data.
        for t in gold["turns"]:
            if int(t["turn_id"]) >= refresh["turn"]:
                t["answer"] = refresh["answers"][str(t["turn_id"])]
    if refresh and kind == "dataflow":
        prompts[refresh["turn"] - 1] = dict(prompts[refresh["turn"] - 1],
                                            prompt=f"{refresh['notice']}\n\n{prompts[refresh['turn'] - 1]['prompt']}")
        os.environ.update(LONGDS_REFRESH_AT=str(refresh["turn"]), LONGDS_REFRESH_SRC=str(refresh["source"]),
                          LONGDS_REFRESH_DEST=str(refresh["dest"]))
    if reset and kind == "dataflow":
        prompts[reset - 1] = dict(prompts[reset - 1], prompt=f"{RESET_NOTICE}\n\n{prompts[reset - 1]['prompt']}")
        os.environ["LONGDS_RESET_AT"] = str(reset)

    sut = args.sut or f"LongDS_Official_{args.arm}_{args.model.split('-')[-1]}"
    run_dir = SCRATCH / sut / args.task
    if run_dir.exists():
        print(f"FATAL: {run_dir} exists; choose another --sut or remove it")
        return 2
    run_dir.mkdir(parents=True)
    (run_dir / "protocol.json").write_text(
        json.dumps(
            {
                "task": args.task,
                "arm": args.arm,
                "arm_kind": kind,
                "model": args.model,
                "turns": len(prompts),
                "runtime": runtime_provenance(),
                "manifest_sha256": hashlib.sha256((prepared / "manifest.json").read_bytes()).hexdigest(),
                "functions_guidance": args.arm == "dsgym-functions",
                "shared_task_text": args.arm.startswith("dsgym-shared"),
                "custom_prompt": args.arm == "smolagents-custom",
                "answer_tool_prompt": args.arm == "smolagents-custom",
                "python_execution_timeout_seconds": (
                    600 if args.arm in DSGYM_ARMS else min(args.turn_timeout, 600)
                    if args.arm == "smolagents-custom" else None
                ),
                "prepared_root": str(args.prepared_root.resolve()),
                "dataset_version": manifest.get('dataset_version', 'v1'),
                "dataset_revision": manifest.get('dataset_revision'),
                "recorded_cost_basis": "Repository Luna accounting rates for all models; not verified provider charges",
                "judge": os.environ.get('LONGDS_JUDGE_MODEL', 'deepseek/deepseek-v4-pro'),
                **({"environment_reset_before_turn": reset, "reset_notice": RESET_NOTICE} if reset else {}),
                **({"data_refresh_before_turn": refresh["turn"], "refresh_extract": refresh["name"],
                    "refresh_notice": refresh["notice"], "refreshed_gold": "reference notebook on the corrected data"}
                   if refresh else {}),
                # The budget arms: tokens a model call may take, and how each fits it.
                **({"context_budget_tokens": int(os.environ["LONGDS_CONTEXT_BUDGET"]),
                    "context_fit": COMPACTION.get(args.arm, "budgeted catalog")}
                   if args.arm in COMPACTION or args.arm == "react-lean2-budget" else {}),
                "execution_isolation": (
                    "bubblewrap: raw task data read-only; private persistent kernel scratch; IPC; no network"
                    if args.arm in DSGYM_ARMS else
                    "bubblewrap: raw task data read-only; persistent smolagents LocalPythonExecutor; no network or credentials"
                    if args.arm == "smolagents-custom" else os.environ.get("LONGDS_NATIVE_ISOLATION", "not recorded")
                ),
                "protocol": (
                    "longds-official: upstream DSGym MultiTurnReActDSAgent, SYSTEM_PROMPT, <python>/<answer>; "
                    "sandbox = local persistent kernel (dsgym_executor.py)"
                    if args.arm in DSGYM_ARMS
                    else "longds-official: upstream context/question, file inventory, final-answer marker; no answer shape"
                ),
            },
            indent=2,
        )
    )
    started = time.time()
    try:
        answers = run_arm(args, prepared, run_dir, prompts, kind, reset, refresh)
    finally:
        if refresh and refresh["dest"].exists():
            shutil.rmtree(refresh["dest"])
    write_records(run_dir, args.task, args.arm, args.model, gold, answers)
    print(
        json.dumps(
            {
                "task": args.task,
                "arm": args.arm,
                "model": args.model,
                "sut": sut,
                "turns": len(answers),
                "answers": sum(1 for a in answers if a["answer"]),
                "minutes": round((time.time() - started) / 60, 1),
            }
        )
    )
    return 0


def run_arm(args, prepared, run_dir, prompts, kind, reset, refresh):
    if args.arm in DSGYM_ARMS:
        answers = run_dsgym_arm(prepared, run_dir, args.model, args.env_file, args.turn_limit,
                                functions=args.arm == "dsgym-functions", shared=args.arm.startswith("dsgym-shared"),
                                compaction=COMPACTION.get(args.arm), reset=reset, refresh=refresh)
        if args.arm.startswith("dsgym-shared"):
            # Same extraction as the dataflow arm: the payload after the
            # final-answer marker the shared answer contract asks for.
            answers = [dict(a, answer=extract_answer(a.get("answer") or "")) for a in answers]
    elif kind == "script":
        answers = run_script_arm(prompts, run_dir, args.model, args.env_file, args.turn_timeout,
                                 custom=args.arm == 'smolagents-custom',
                                 manifest=json.loads((prepared / 'manifest.json').read_text()))
    else:
        answers = run_dataflow_arm(prompts, run_dir, args.arm, args.model, args.turn_timeout)
    return answers


if __name__ == "__main__":
    raise SystemExit(main())
