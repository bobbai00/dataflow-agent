#!/usr/bin/env python3
"""Run one prepared LongDS task with the paper's own agent.

This is upstream's `MultiTurnReActDSAgent` (DataMind/longds/runners/DSGym),
its `SYSTEM_PROMPT`, its `<python>`/`<answer>` protocol, its 40 steps per turn
and its `f"{context}\\nQuestion: {question}"` turn messages, unchanged. The turns
are built the way upstream's `load_dataset` builds them, from the prepared
manifest; the only substitution is the sandbox: `dsgym_executor.py` (a local
persistent Jupyter kernel behind the same HTTP contract) instead of the docker
container. Token usage is read from every model response so the arm's cost is
accounted the way the dataflow arm's is.

Runs under `.dsgym-venv` (litellm); `run_official.py --arm dsgym` drives it.
"""
import argparse
import json
import os
import sys
import time
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parents[1]
DSGYM = HERE / "DataMind/longds/runners/DSGym"
sys.path.insert(0, str(DSGYM))
sys.path.insert(0, str(DSGYM / "scripts"))

import litellm  # noqa: E402

# `dsgym/__init__.py` imports the dataset loaders (Kaggle, Selenium, vLLM, ...),
# none of which the agent uses. Bind the package to its directory without
# running that init, so only the agent's own modules load.
_dsgym = types.ModuleType("dsgym")
_dsgym.__path__ = [str(DSGYM / "dsgym")]  # type: ignore[attr-defined]
sys.modules.setdefault("dsgym", _dsgym)
from dsgym.agents import MultiTurnReActDSAgent  # noqa: E402
from dsgym.agents import multi_turn_react_ds_agent as agent_module  # noqa: E402
from dsgym.agents.environment import AllocatedCodeEnv  # noqa: E402
from prompt import SYSTEM_PROMPT  # noqa: E402

# Repository accounting rates (USD per million tokens), the dataflow arm's table.
RATES = {"input": 0.2, "cached": 0.02, "write": 0.25, "output": 1.2}

CALLS: list[dict] = []
TURN_STARTS: list[int] = []  # index into CALLS where each turn began


class TurnMarkingEnv(AllocatedCodeEnv):
    """Upstream calls reset_turns() at the start of every turn; that marks
    where one turn's model calls end and the next one's begin."""

    def reset_turns(self):
        TURN_STARTS.append(len(CALLS))
        super().reset_turns()


def install_usage_capture(provider: str) -> None:
    original = litellm.completion

    def completion(*args, **kwargs):
        # The proxy's model names carry no provider prefix; say which API shape
        # they speak so litellm does not have to guess.
        kwargs.setdefault("custom_llm_provider", provider)
        started = time.time()
        response = original(*args, **kwargs)
        usage = getattr(response, "usage", None)
        details = getattr(usage, "prompt_tokens_details", None)
        completion_details = getattr(usage, "completion_tokens_details", None)
        CALLS.append(
            {
                "seconds": round(time.time() - started, 3),
                "input_tokens": getattr(usage, "prompt_tokens", 0) or 0,
                "cached_tokens": getattr(details, "cached_tokens", 0) or 0,
                "cache_write_tokens": getattr(details, "cache_write_tokens", 0) or 0,
                "output_tokens": getattr(usage, "completion_tokens", 0) or 0,
                "reasoning_tokens": getattr(completion_details, "reasoning_tokens", 0) or 0,
            }
        )
        return response

    litellm.completion = completion


def build_turns(manifest: dict, gold: dict, turn_limit: int | None) -> list[dict]:
    """Upstream's `load_dataset` shape: the system prompt names the data
    directory; every turn is `context\\nQuestion: question`."""
    system_prompt = SYSTEM_PROMPT.format(PATH=str((WORKTREE / manifest["data_dir"]).resolve()))
    gold_by_id = {t["turn_id"]: t for t in gold["turns"]}
    turns = []
    for item in manifest["turns"][:turn_limit]:
        message = {"role": "user", "content": f"{item['context']}\nQuestion: {item['question']}"}
        turns.append(
            {
                "turn_id": item["turn_id"],
                "context": item["context"],
                "question": item["question"],
                "answer": gold_by_id.get(item["turn_id"], {}).get("answer", ""),
                "prompt": ([{"role": "system", "content": system_prompt}] if item["turn_id"] == 1 else []) + [message],
            }
        )
    return turns


def stats_for(turn_index: int, elapsed: float) -> dict:
    start = TURN_STARTS[turn_index] if turn_index < len(TURN_STARTS) else len(CALLS)
    end = TURN_STARTS[turn_index + 1] if turn_index + 1 < len(TURN_STARTS) else len(CALLS)
    calls = CALLS[start:end]
    total = lambda key: sum(c[key] for c in calls)  # noqa: E731
    input_tokens, cached, written, output = (
        total("input_tokens"),
        total("cached_tokens"),
        total("cache_write_tokens"),
        total("output_tokens"),
    )
    return {
        "input_tokens": input_tokens,
        "output_tokens": output,
        "cached_tokens": cached,
        "cache_write_tokens": written,
        "reasoning_tokens": total("reasoning_tokens"),
        "llm_calls": len(calls),
        "cost_usd": (
            (input_tokens - cached - written) * RATES["input"]
            + cached * RATES["cached"]
            + written * RATES["write"]
            + output * RATES["output"]
        )
        / 1e6,
        "elapsed_seconds": round(elapsed, 3),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--gold", type=Path, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--executor-url", required=True)
    ap.add_argument("--api-base", required=True, help="OpenAI-compatible proxy, e.g. http://localhost:34000/v1")
    ap.add_argument("--api-key-env", default="LITELLM_MASTER_KEY")
    ap.add_argument("--turn-limit", type=int)
    ap.add_argument("--max-steps", type=int, default=40)
    args = ap.parse_args()

    api_key = os.environ[args.api_key_env]
    install_usage_capture("openai")
    agent_module.AllocatedCodeEnv = TurnMarkingEnv
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text())
    gold = json.loads(args.gold.read_text())
    turns = build_turns(manifest, gold, args.turn_limit)
    (args.out / "turns.json").write_text(json.dumps(turns, indent=2, ensure_ascii=False))

    agent = MultiTurnReActDSAgent(
        backend="litellm",
        model=args.model,
        manager_url=args.executor_url,
        max_steps=args.max_steps,
        temperature=0.0,
        output_dir=str(args.out / "outputs"),
        api_key=api_key,
        base_url=args.api_base,
    )
    bak = args.out / "bak"
    bak.mkdir(exist_ok=True)
    result = agent.solve_task(turns, bak_path=str(bak), reset_env_times=0)
    (args.out / "traj.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
    (args.out / "calls.json").write_text(json.dumps({"calls": CALLS, "turn_starts": TURN_STARTS}, indent=1))

    answers = []
    for index, solution in enumerate(result.get("solutions", [])):
        answers.append(
            {
                "turn_id": solution.get("turn_id"),
                "answer": solution.get("solution") or "",
                "error": solution.get("error"),
                "steps": solution.get("steps", 0),
                "stats": stats_for(index, solution.get("execution_time", 0.0)),
            }
        )
    (args.out / "answers.json").write_text(json.dumps(answers, indent=2, ensure_ascii=False))
    print(json.dumps({"turns": len(answers), "answers": sum(1 for a in answers if a["answer"]), "error": result.get("error")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
