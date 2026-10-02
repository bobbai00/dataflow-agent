#!/usr/bin/env python3
"""Run one LongDS task as ONE dataflow-agent session.

The whole point of LongDS is that turn N+1 depends on analytical state built in
turns 1..N, so this runner does the opposite of `DataflowSystem.serve_query`:
one agent and one workflow for the entire task, and every turn is another
`{type:"message"}` on it. Nothing is reset between turns — the operators the agent
built, their code, their materialized results, and the DELTA event log are the
carried state. That is why `serve_query` is bypassed rather than reused: its
documented per-query fresh-agent workaround (dataflow_system.py:561-577) destroys
exactly what is being measured here.

Artifacts are written twice on purpose:
  * `results_with_ground_truth.json` in upstream LongDS's own shape, so their
    shipped judge logic scores us with no reimplementation on our side;
  * one directory per turn in KramaBench's `system_scratch` convention, so
    `kb.py`'s cost/token/trace tooling keeps working unchanged.

Resume granularity is the TASK, not the turn. The agent's trajectory lives only in
agent-service's process memory, so a session cannot be rejoined after a crash or a
service restart — a half-finished task is re-run from turn 1.

Usage:
    python benchmark/longds/run_longds.py --task sports__nfl_big_data_bowl_2023__task1
    python benchmark/longds/run_longds.py --task <key> --turn-limit 3       # smoke test
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from _paths import KB_ROOT, PREPARED, SCRATCH, add_import_paths

os.chdir(KB_ROOT)  # data/... paths in prompts are relative to the KramaBench root
add_import_paths()

# Both bold conventions must parse: the LongDS per-turn contract writes
# `**Final Answer: <json>**` (bold wraps everything), while the service-side
# convention the # Your Task directive teaches writes `**Final Answer:** <json>`
# (bold wraps the marker). The second `(?:\*\*\s*)?` eats the marker-closing
# `**` so neither convention leaks asterisks into the judged payload.
FINAL_ANSWER_RE = re.compile(
    r"(?:\*\*\s*)?final answer:\s*(?:\*\*\s*)?(.+?)(?:\s*\*\*)?\s*$", re.IGNORECASE | re.DOTALL
)

ANSWER_CONTRACT = (
    "Report the answer as a single-line JSON object holding exactly the "
    "quantities this question asks for, and nothing else. Follow the rounding and "
    "scale rules stated in the task text. Do not restate the whole chain of "
    "reasoning as the answer.\n"
    "Your last line MUST BE: **Final Answer: <single-line JSON>**"
)
NATIVE_ANSWER_CONTRACT = (
    "Put a single-line JSON object in answer.content containing exactly the "
    "quantities requested. Follow the task's rounding and scale rules. "
    "Submit Answer as the sole action in its batch after observing the evidence."
)


def build_turn_1_prompt(manifest: dict, turn: dict, *, agent_mode: str = "code") -> str:
    """Turn 1 also establishes the session contract; later turns are content only.

    The file inventory is mandatory here: the agent has no file-listing tool, so
    an unlisted file is invisible to it. Paths are relative with no leading slash
    (agent-service's prompt rule) and resolve identically in the JVM's Python UDF
    worker, which runs with the dataflow-agent repo root as its cwd.
    """
    files = "\n".join(f" - {p}" for p in manifest["files"])
    native = agent_mode == "native"
    persistence = (
        "Editing definitions or edges invalidates affected results; explicitly execute "
        "before retrieving current results. Retrieval never executes."
        if native else
        "Editing an operator recomputes whatever depends on it, so you do not have to rebuild downstream work by hand."
    )
    answer_contract = NATIVE_ANSWER_CONTRACT if native else ANSWER_CONTRACT
    return f"""You are an expert data scientist working through a long analysis with me. I will send you a series of requests, one at a time, about the same data.

Data files available (use these paths verbatim, they are relative — no leading slash):
{files}

How this session works:
- The operators you create stay available to my later requests. Name them meaningfully so you and I can refer back to them.
- {persistence}
- Do not use plotting libraries. Use text summaries and statistics.
- Use code for every calculation rather than doing arithmetic yourself.
- Answer only when you have evidence for the answer.

{answer_contract}

{turn['context']}
Question: {turn['question']}"""


def build_turn_n_prompt(turn: dict, *, agent_mode: str = "code") -> str:
    """Verbatim LongDS turn content, plus the answer-format reminder.

    Upstream joins context and question as `f"{context}\\nQuestion: {question}"`;
    that join is reproduced exactly so the model reads the same text the paper's
    models read.
    """
    answer_contract = NATIVE_ANSWER_CONTRACT if agent_mode == "native" else ANSWER_CONTRACT
    return f"""{turn['context']}
Question: {turn['question']}

{answer_contract}"""


def extract_answer(response: str) -> str:
    """The `Final Answer:` payload, else the whole response.

    Kept deliberately dumb: the judge scores free text, so a failed marker match
    should degrade to "judge the whole reply" rather than to an empty solution
    (an empty solution scores 0 by fiat and would hide a formatting bug as a
    reasoning failure).
    """
    if not response:
        return ""
    match = FINAL_ANSWER_RE.search(response.strip())
    return (match.group(1) if match else response).strip()


def service_provenance(endpoint: str) -> dict:
    """Which agent-service build produced this run.

    Reads the cwd of whatever process is listening on the port instead of
    assuming a checkout: :3001 has been served by a worktree in the past, and
    stamping the main checkout's SHA for a worktree-served port is a confidently
    wrong provenance record.
    """
    info = {"endpoint": endpoint, "service_cwd": None, "git_sha": "unknown", "src_dirty": None}
    try:
        port = endpoint.rsplit(":", 1)[-1].strip("/")
        pids = subprocess.run(
            ["lsof", "-tiTCP:" + port, "-sTCP:LISTEN"], capture_output=True, text=True, timeout=5
        ).stdout.split()
        if pids:
            cwd = os.readlink(f"/proc/{pids[0]}/cwd")
            info["service_cwd"] = cwd
            repo = Path(cwd).parent  # .../agent-service -> repo root
            info["git_sha"] = (
                subprocess.run(
                    ["git", "-C", str(repo), "rev-parse", "--short", "HEAD"],
                    capture_output=True, text=True, timeout=5,
                ).stdout.strip()
                or "unknown"
            )
            info["src_dirty"] = bool(
                subprocess.run(
                    ["git", "-C", str(repo), "status", "--porcelain", "agent-service/src"],
                    capture_output=True, text=True, timeout=5,
                ).stdout.strip()
            )
    except Exception:
        pass
    return info


def turn_metrics(new_steps: list) -> dict:
    """Per-turn step count and the largest wire context the model actually saw.

    `inputMessages` is the exact array sent for that step, so its size is the
    honest measure of how far append-only DELTA has grown — the number this
    pilot exists to produce.
    """
    agent_steps = [s for s in new_steps if s.get("role") == "agent"]
    tool_steps = [s for s in agent_steps if s.get("toolCalls")]
    prompt_bytes = 0
    for step in new_steps:
        msgs = step.get("inputMessages")
        if msgs:
            prompt_bytes = max(prompt_bytes, len(json.dumps(msgs, default=str)))
    return {
        "agent_steps": len(agent_steps),
        "tool_steps": len(tool_steps),
        "max_prompt_bytes": prompt_bytes,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True, help="prepared task key, e.g. sports__nfl_..._task1")
    ap.add_argument("--arm", default="luna-delta-1k")
    ap.add_argument("--turn-limit", type=int, default=None)
    ap.add_argument("--turn-timeout", type=int, default=1200, help="per-turn wall-clock budget (s)")
    ap.add_argument("--skip-done", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    manifest_path = PREPARED / args.task / "manifest.json"
    if not manifest_path.exists():
        print(f"FATAL: {manifest_path} missing — run benchmark/longds/prepare.py first")
        return 2
    manifest = json.loads(manifest_path.read_text())
    turns = manifest["turns"]
    if args.turn_limit:
        turns = turns[: args.turn_limit]

    # Read gold ONLY to attach ground_truth for the judge. Never enters a prompt.
    gold = json.loads((PREPARED / args.task / "gold.json").read_text())
    gold_by_turn = {t["turn_id"]: t for t in gold["turns"]}

    from arms import ARMS

    if args.arm not in ARMS:
        print(f"FATAL: unknown arm {args.arm}; have {sorted(ARMS)}")
        return 2
    arm_cls = ARMS[args.arm]
    sut_name = f"LongDS_{arm_cls._NAME}"
    run_dir = SCRATCH / sut_name / args.task
    summary_path = run_dir / "summary.json"

    if args.skip_done and summary_path.exists():
        done = json.loads(summary_path.read_text()).get("turns_completed", 0)
        if done >= len(turns):
            print(f"skip {args.task}: {done}/{len(turns)} turns already done")
            return 0
    run_dir.mkdir(parents=True, exist_ok=True)

    # The per-turn budget is read from the environment by DataflowAgent's ctor, so
    # it must be set before the arm is constructed.
    os.environ["TEXERA_AGENT_MAX_TURN_SECONDS"] = str(args.turn_timeout)

    print(f"arm={args.arm} ({arm_cls._NAME})  task={args.task}  turns={len(turns)}")
    sut = arm_cls(verbose=args.verbose, output_dir=str(run_dir))
    sut.output_dir = str(run_dir)
    sut.process_dataset(manifest["data_dir"])
    if sut.agent is None:
        print("FATAL: agent setup failed — is the stack up?")
        return 2

    from dataflow_agent import get_agent_react_steps, get_agent_workflow
    from systems.cost_utils import compute_cost

    endpoint = sut.agent.agent_service_endpoint
    (run_dir / "config.json").write_text(
        json.dumps(
            {
                "benchmark": "longds",
                "task_key": args.task,
                "arm": args.arm,
                "sut": sut_name,
                "model_type": sut.model_type,
                "context_mode": sut.context_mode,
                "max_operator_result_char_limit": sut.max_operator_result_char_limit,
                "column_stats": sut.column_stats,
                "data_level": sut.data_level,
                "enable_code_in_snapshot": sut.enable_code_in_snapshot,
                "context_window_tokens": sut.context_window_tokens,
                "max_steps_per_turn": sut.max_steps,
                "turn_timeout_seconds": args.turn_timeout,
                "num_turns": len(turns),
                "num_files": len(manifest["files"]),
                "agent_id": sut.agent.agent_id,
                "workflow_id": sut.agent._workflow_id,
                "service": service_provenance(endpoint),
            },
            indent=2,
        )
    )

    records, steps_seen, wall_start = [], 0, time.time()
    totals = {"cost_usd": 0.0, "input": 0, "output": 0, "reasoning": 0, "cached": 0}

    for idx, turn in enumerate(turns):
        tid = turn["turn_id"]
        tdir = run_dir / f"t{tid:02d}"
        # parents=True so a session survives its run_dir being removed underneath
        # it (two concurrent runs of the same task raced exactly once, and the
        # loser died mid-turn on a bare mkdir).
        tdir.mkdir(parents=True, exist_ok=True)
        prompt = (
            build_turn_1_prompt(manifest, turn, agent_mode=sut.agent_mode)
            if idx == 0 else build_turn_n_prompt(turn, agent_mode=sut.agent_mode)
        )
        (tdir / "prompt.txt").write_text(prompt)

        t0 = time.time()
        try:
            result = sut.agent.run(prompt)
            response, err, stopped = result.response or "", result.error, result.stopped
            usage = result.usage or {}
            ws_steps = int((result.stats or {}).get("steps") or 0)
        except Exception as exc:  # noqa: BLE001 — a dead turn must not kill the session
            response, err, stopped, usage, ws_steps = "", f"{type(exc).__name__}: {exc}", True, {}, 0
        elapsed = time.time() - t0

        (tdir / "response.txt").write_text(response or "(empty response)")
        answer = extract_answer(response)
        (tdir / "answer.json").write_text(
            json.dumps({"id": f"turn-{tid}", "answer": answer}, indent=2, ensure_ascii=False)
        )

        metrics = {"agent_steps": ws_steps, "tool_steps": 0, "max_prompt_bytes": 0}
        try:
            trace = get_agent_react_steps(agent_id=sut.agent.agent_id, agent_endpoint=endpoint)
            all_steps = trace.get("steps") or []
            new_steps = all_steps[steps_seen:]
            steps_seen = len(all_steps)
            metrics = turn_metrics(new_steps)
            (tdir / "react_steps.json").write_text(
                json.dumps({"steps": new_steps}, indent=2, default=str)
            )
        except Exception as exc:
            print(f"  (could not fetch trace for turn {tid}: {exc})")
        try:
            (tdir / "workflow.json").write_text(
                json.dumps(
                    get_agent_workflow(agent_id=sut.agent.agent_id, agent_endpoint=endpoint),
                    indent=2,
                    default=str,
                )
            )
        except Exception:
            pass

        tok_in = usage.get("input_tokens", 0)
        tok_out = usage.get("output_tokens", 0)
        tok_cached = usage.get("cached_input_tokens", 0)
        try:
            cost = compute_cost(
                sut.model_type, input_tokens=tok_in, output_tokens=tok_out, cached_tokens=tok_cached
            ) or 0.0
        except Exception:
            cost = 0.0
        totals["cost_usd"] += cost
        totals["input"] += tok_in
        totals["output"] += tok_out
        totals["reasoning"] += usage.get("reasoning_tokens", 0)
        totals["cached"] += tok_cached

        stats = {
            "turn_id": tid,
            "input_tokens": tok_in,
            "output_tokens": tok_out,
            "reasoning_tokens": usage.get("reasoning_tokens", 0),
            "cached_tokens": tok_cached,
            "cost_usd": round(cost, 6),
            "elapsed_seconds": round(elapsed, 1),
            "stopped": stopped,
            "error": err,
            **metrics,
        }
        (tdir / "stats.json").write_text(json.dumps(stats, indent=2))

        g = gold_by_turn.get(tid, {})
        records.append(
            {
                "turn_id": tid,
                "context": turn["context"],
                "question": turn["question"],
                "solution": answer,
                "ground_truth": g.get("answer"),
                "state_type": g.get("state_type", []),
                "depends_tasks": g.get("depends_tasks", []),
                "depends_span": g.get("depends_span", []),
                "success": bool(answer) and not err,
                "steps": metrics["agent_steps"],
                "stats": stats,
            }
        )
        # Checkpoint after every turn: a crash at turn 40 must not lose 39 turns.
        (run_dir / "results_with_ground_truth.json").write_text(
            json.dumps(records, indent=2, ensure_ascii=False)
        )
        (run_dir / "summary.json").write_text(
            json.dumps(
                {
                    "task": args.task,
                    "arm": args.arm,
                    "sut": sut_name,
                    "turns_total": len(turns),
                    "turns_completed": len(records),
                    "totals": {**totals, "cost_usd": round(totals["cost_usd"], 6)},
                    "wall_seconds": round(time.time() - wall_start, 1),
                },
                indent=2,
            )
        )

        flag = "" if not err else f"  ERR: {err[:80]}"
        print(
            f"  turn {tid:>2}/{len(turns)}  steps={metrics['agent_steps']:>2} "
            f"ctx={metrics['max_prompt_bytes'] / 1000:>7.1f}kB  {elapsed:>5.0f}s "
            f"${cost:.4f}  ans={answer[:60]!r}{flag}"
        )

    try:
        sut.agent.cleanup()
    except Exception:
        pass

    print(
        f"\ndone: {len(records)}/{len(turns)} turns, "
        f"${totals['cost_usd']:.4f}, {(time.time() - wall_start) / 60:.1f} min"
    )
    print(f"artifacts: {run_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
