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
CALLS_FILE: Path | None = None


class TurnMarkingEnv(AllocatedCodeEnv):
    """Upstream calls reset_turns() at the start of every turn; that marks
    where one turn's model calls end and the next one's begin."""

    def init(self, prompt, **extras):
        result = super().init(prompt, **extras)
        # Upstream logs allocation errors but still reports initialized=True.
        # A benchmark without an executable kernel is a setup failure.
        if self.tool_group.allocated_container is None:
            raise RuntimeError("LongDS kernel allocation failed; refusing model calls without an executor")
        return result

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
        if CALLS_FILE is not None:
            with CALLS_FILE.open("a") as stream:
                stream.write(json.dumps({"turn_index": max(0, len(TURN_STARTS) - 1), **CALLS[-1]}) + "\n")
        return response

    litellm.completion = completion


FUNCTIONS_GUIDANCE = """
Keep reusable Python analysis functions in the persistent kernel. Give them
explicit inputs for data, cohort membership and parameters. Keep interpretable
score components as columns. Check assumptions such as keys, units and required
columns with assertions when useful. When a definition changes, correct the
earliest shared function and recompute its consumers. Keep original inputs and
important historical results separately. For a temporary scenario, call the
same functions with explicit parameter overrides into new variables, preserving
the default. Distinguish historical membership, historical values and historical
formulas when combining versions. Inspect stored definitions and computed
components to explain a result rather than reconstructing a formula from memory.
"""


def build_turns(manifest: dict, gold: dict, turn_limit: int | None, *, functions=False, shared=False) -> list[dict]:
    """Upstream's `load_dataset` shape: the system prompt names the data
    directory; every turn is `context\\nQuestion: question`. With `shared`,
    each turn's message is instead the text the dataflow arm receives
    (`official_protocol.build_prompts`, script persistence paragraph): turn 1
    adds the file inventory, the session rules and the answer contract."""
    system_prompt = SYSTEM_PROMPT.format(PATH=str((WORKTREE / manifest["data_dir"]).resolve()))
    if functions:
        system_prompt += "\n" + FUNCTIONS_GUIDANCE
    gold_by_id = {t["turn_id"]: t for t in gold["turns"]}
    shared_text = {}
    if shared:
        from official_protocol import build_prompts

        shared_text = {p["turn_id"]: p["prompt"] for p in build_prompts(manifest, "script")}
    turns = []
    for item in manifest["turns"][:turn_limit]:
        content = shared_text.get(item["turn_id"]) or f"{item['context']}\nQuestion: {item['question']}"
        message = {"role": "user", "content": content}
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
    ap.add_argument("--functions", action="store_true", help="separately labeled reusable-function control")
    ap.add_argument("--shared-protocol", action="store_true",
                    help="send the dataflow arm's task text (file inventory, session rules, answer contract)")
    args = ap.parse_args()

    api_key = os.environ[args.api_key_env]
    args.out.mkdir(parents=True, exist_ok=True)
    global CALLS_FILE
    CALLS_FILE = args.out / "calls.jsonl"
    install_usage_capture("openai")
    agent_module.AllocatedCodeEnv = TurnMarkingEnv
    manifest = json.loads(args.manifest.read_text())
    gold = json.loads(args.gold.read_text())
    turns = build_turns(manifest, gold, args.turn_limit, functions=args.functions, shared=args.shared_protocol)
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
    if result.get("error") and not result.get("solutions"):
        raise RuntimeError(result["error"])

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
