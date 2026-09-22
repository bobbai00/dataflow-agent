#!/usr/bin/env python3
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
import json
import os
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
SCRIPT_ARMS = {"code"}
DATAFLOW_ARMS = {"react-full", "react-catalog"}


def run_script_arm(prompts, out_dir, model, env_file, turn_timeout):
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
        max_print_outputs_length=2000,
        use_custom_prompt=False,
        use_fine_grained_prompt=False,
        use_pitfalls_prompt=False,
        verbosity_level=0,
        api_base=os.getenv("CODE_AGENT_API_BASE", "http://localhost:4000"),
        api_key=os.getenv("LITELLM_MASTER_KEY", "dummy"),
    ).setup()
    os.chdir(KB_ROOT)  # data/... paths in the prompts resolve from here, as upstream's runner does
    answers, prior = [], 0
    for index, turn in enumerate(prompts, 1):
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
        print(json.dumps({"arm": "code", "model": model, "turn": turn["turn_id"], **stats}), flush=True)
    return answers


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True, help="prepared task key")
    ap.add_argument("--arm", required=True, choices=sorted(SCRIPT_ARMS | DATAFLOW_ARMS))
    ap.add_argument("--model", default="gpt-5.6-luna")
    ap.add_argument("--sut", help="run name (default: LongDS_Official_<arm>_<model tail>)")
    ap.add_argument("--turn-limit", type=int)
    ap.add_argument("--turn-timeout", type=int, default=1200)
    ap.add_argument("--env-file", type=Path, default=WORKTREE.parents[2] / ".env")
    args = ap.parse_args()
    # The script agent's interpreter is KramaBench's venv: its sandbox authorizes
    # imports (fiona, geopandas, ...) that only that environment installs. Re-exec
    # rather than ask the caller to remember which interpreter each arm needs.
    if args.arm in SCRIPT_ARMS:
        wanted = KB_ROOT / ".venv/bin/python"
        if wanted.exists() and Path(sys.executable).resolve() != wanted.resolve():
            os.execv(str(wanted), [str(wanted), str(Path(__file__).resolve()), *sys.argv[1:]])
    selftest()

    prepared = PREPARED / args.task
    manifest = json.loads((prepared / "manifest.json").read_text())
    gold = json.loads((prepared / "gold.json").read_text())
    kind = "script" if args.arm in SCRIPT_ARMS else "dataflow"
    prompts = build_prompts(manifest, kind)[: args.turn_limit]

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
                "protocol": "longds-official: upstream context/question, file inventory, final-answer marker; no answer shape",
                "judge": "run judge_longds.py --judge-model deepseek/deepseek-v4-pro",
            },
            indent=2,
        )
    )
    started = time.time()
    if kind == "script":
        answers = run_script_arm(prompts, run_dir, args.model, args.env_file, args.turn_timeout)
    else:
        answers = run_dataflow_arm(prompts, run_dir, args.arm, args.model, args.turn_timeout)
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


if __name__ == "__main__":
    raise SystemExit(main())
