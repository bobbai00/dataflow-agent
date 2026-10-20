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
import shutil
import sys
import time
import types
from pathlib import Path

from comparison_budget import estimate_full_input

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
ENV = None  # the code environment, for the compaction's kernel inventory
REFRESH = None  # (turn, corrected copy, destination) under --refresh-at
COMPACTOR = None  # set by --context-budget
WIRE_DIR: Path | None = None
FULL_INPUT_BUDGET = int(os.environ.get("MODEL_INPUT_TOKEN_BUDGET", "0"))
FULL_INPUT_SCALE = float(os.environ.get("MODEL_INPUT_TOKEN_SCALE", "1"))
MODEL_CALL_LIMIT = int(os.environ.get("MODEL_MAX_CALLS_PER_TURN", "0"))

# The budget's estimate, the same as the dataflow arm's (task-context.ts).
CHARS_PER_TOKEN = 3.3

SUMMARY_SYSTEM = """You maintain the working memory of a long data-analysis session that runs in a
persistent Python kernel. The conversation is being compacted to fit a limited
context: after this, the analyst sees only the first request, your SUMMARY, the most
recent turns, the live kernel and the current request. Update the SUMMARY with the
NEW TURNS. Keep, with exact names and numbers:
1. The data files loaded and the variable holding each (rows, the columns used).
2. Every variable, DataFrame and function later questions may need: its exact name,
   what it holds (filters applied, grain, key columns) and how it was computed.
3. The definitions and conventions the requests set (rounding, scales, thresholds,
   mappings, exclusions) and the turn that set each.
4. Each completed question in one line with its final answer (the exact values).
5. Open caveats.
Do not invent anything the turns do not show. Write at most {words} words."""

INVENTORY_CODE = r"""
import types as _t, inspect as _i
_rows = []
for _n, _v in list(globals().items()):
    if _n.startswith('_') or _n in ('In', 'Out', 'get_ipython', 'exit', 'quit') or isinstance(_v, (_t.ModuleType, type)):
        continue
    try:
        if hasattr(_v, 'columns') and hasattr(_v, 'shape'):
            _c = [str(c) for c in _v.columns]
            _rows.append(f"{_n}: DataFrame {_v.shape[0]}x{_v.shape[1]} columns={_c[:12]}" + (f" (+{len(_c) - 12})" if len(_c) > 12 else ""))
        elif hasattr(_v, 'shape') and hasattr(_v, 'dtype'):
            _rows.append(f"{_n}: {type(_v).__name__} shape={_v.shape} dtype={_v.dtype}")
        elif callable(_v):
            _d = (_i.getdoc(_v) or '').split('\n')[0][:80]
            _rows.append(f"{_n}{_i.signature(_v)}: function {_d}")
        elif isinstance(_v, (bool, int, float, str)):
            _rows.append(f"{_n} = {repr(_v)[:80]}")
        elif isinstance(_v, (list, tuple, set, dict)):
            _rows.append(f"{_n}: {type(_v).__name__} len={len(_v)} {repr(_v)[:100]}")
    except Exception:
        pass
print('\n'.join(_rows[:150]))
"""


def estimate_tokens(messages) -> int:
    if FULL_INPUT_BUDGET:
        return estimate_full_input({"messages": messages}, FULL_INPUT_SCALE)
    return int(sum(len(m["content"] if isinstance(m.get("content"), str) else json.dumps(m.get("content"))) for m in messages)
               / CHARS_PER_TOKEN)


def is_turn_start(message) -> bool:
    content = message.get("content")
    return (message.get("role") == "user" and isinstance(content, str)
            and "Question:" in content and "<information>" not in content)


class Compactor:
    """Fits every model call into a token budget, as the provider counts it.
    Under the budget, the call is sent as is. Over it, the call keeps the
    system prompt, the first request (the file inventory, the session rules
    and the answer contract), a SUMMARY of the earlier turns that no longer
    fit (written by the same model and extended as turns leave), the newest
    earlier turns verbatim, the kernel inventory in the inventory mode, and
    the current request. Which turns stay verbatim is decided once per
    request, with a reserve for the request's own calls, so its calls share a
    prompt prefix. A single message above a quarter of the budget is clipped
    to its head and tail; within the current request, older outputs give way
    when it outgrows its reserve."""

    SUMMARY_SHARE = 0.25  # the summary's cap
    ACTIVE_SHARE = 0.3  # the reserve for the current request's calls (the dataflow arm's)

    def __init__(self, budget: int, mode: str, log: Path):
        self.budget = budget
        self.mode = mode
        self.log = log
        self.summary = ""
        self.upto = 0  # earlier turns covered by the summary (turn 1's request is kept apart)
        self.message_cap = int(budget * CHARS_PER_TOKEN / 4)
        self.summarizing = False
        self.scale = 1.0  # the provider's count over the estimate, from the last agent call
        self.planned = None  # the request index the verbatim turns were chosen for
        self.listed = ""  # the kernel inventory, listed once per request

    def observe(self, estimate: int, actual: int):
        if FULL_INPUT_BUDGET:
            return  # Freeze the development-calibrated scale for all arms.
        if estimate and actual:
            self.scale = min(1.5, max(0.5, actual / estimate))

    @property
    def units(self) -> int:
        """The budget in the estimate's units, less a 3% margin for the
        estimate's error on this call (the scale is the previous call's)."""
        return self.budget if FULL_INPUT_BUDGET else int(self.budget * 0.97 / self.scale)

    def clip(self, message):
        content = message.get("content")
        if isinstance(content, str) and len(content) > self.message_cap:
            head, tail = content[: self.message_cap * 2 // 3], content[-self.message_cap // 3:]
            return {**message, "content": f"{head}\n... ({len(content) - len(head) - len(tail)} characters omitted to fit the context budget) ...\n{tail}"}
        return message

    def inventory(self) -> str:
        tools = getattr(ENV, "tool_group", None)
        if tools is None or tools.allocated_container is None:
            return ""
        try:
            text = tools.execute_code(INVENTORY_CODE)
        except Exception as error:  # the inventory is optional; the summary stands alone
            return f"(kernel inventory unavailable: {error})"
        return str(text)[:6000]

    def transcript(self, turn, limit: int) -> str:
        """The turn as text within `limit` characters: each message clipped,
        tighter until the whole fits, then cut to its head and tail."""
        texts = [(m.get("role"), m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content")))
                 for m in turn]
        for cap in (2000, 1000, 500, 250):
            text = "\n".join(f"[{role}] {content[:cap]}" for role, content in texts)
            if len(text) <= limit:
                return text
        return text[: limit * 2 // 3] + "\n...\n" + text[-limit // 3:]

    def extend_summary(self, turns, call, kwargs):
        """Folds the turns into the summary, as many turns a call as fit the
        budget beside the summary so far."""
        words = max(300, min(3000, int(self.budget * 0.2 * 0.75)))
        room = int(self.budget * 0.6 * CHARS_PER_TOKEN)
        chunks, chunk, size = [], [], 0
        for turn in turns:
            text = self.transcript(turn, room)
            if chunk and size + len(text) > room:
                chunks.append(chunk)
                chunk, size = [], 0
            chunk.append(text)
            size += len(text)
        chunks.append(chunk)
        request = dict(kwargs)
        request.pop("stop", None)
        self.summarizing = True
        try:
            for chunk in chunks:
                request["messages"] = [
                    {"role": "system", "content": SUMMARY_SYSTEM.format(words=words)},
                    {"role": "user", "content": f"SUMMARY SO FAR:\n{self.summary or '(empty)'}\n\nNEW TURNS:\n" + "\n\n".join(chunk)},
                ]
                response = call(**request)
                self.summary = (response.choices[0].message.content or "").strip()[: int(self.budget * self.SUMMARY_SHARE * CHARS_PER_TOKEN)]
        finally:
            self.summarizing = False

    def compact(self, messages, call, kwargs):
        if self.summarizing or estimate_tokens(messages) <= self.units:
            return messages
        system = [m for m in messages[:1] if m.get("role") == "system"]
        rest = messages[len(system):]
        starts = sorted({0, *(i for i, m in enumerate(rest) if is_turn_start(m))})
        turns = [[self.clip(m) for m in rest[a:b]] for a, b in zip(starts, starts[1:] + [len(rest)])]
        # Turn 1's request stays whole; the rest of turn 1 is an earlier turn like any other.
        first, turns[0] = turns[0][:1], turns[0][1:]
        earlier, current = turns[:-1], turns[-1] if len(turns) > 1 else []
        if len(turns) == 1:  # still in the first request: its request is `first`
            earlier, current = [], turns[0]
        record = {}
        request = len(TURN_STARTS)
        if self.planned != request:
            # Keep the newest earlier turns verbatim while they fit beside the
            # first request, the summary, and the current request or its reserve.
            room = (self.units - estimate_tokens(system + first) - int(self.units * self.SUMMARY_SHARE)
                    - max(estimate_tokens(current), int(self.units * self.ACTIVE_SHARE)))
            keep, size = 0, 0
            for turn in reversed(earlier[self.upto:]):
                size += estimate_tokens(turn)
                if size > room:
                    break
                keep += 1
            cut = len(earlier) - keep
            if cut > self.upto:
                self.extend_summary(earlier[self.upto:cut], call, kwargs)
                self.upto = cut
                record["summary"] = self.summary
            if self.mode == "inventory":
                self.listed = self.inventory()
                record["inventory"] = self.listed
            self.planned = request
        memory = []
        if self.upto:
            text = f"SUMMARY of the earlier conversation (turns 1-{self.upto}, compacted to fit the context budget):\n{self.summary}"
            if self.mode == "inventory":
                text += f"\n\nKERNEL VARIABLES (listed from the live kernel during this request):\n{self.listed}"
            memory = [{"role": "user", "content": text}]
        recent = [m for turn in earlier[self.upto:] for m in turn]
        head = system + first + memory + recent
        room = self.units - estimate_tokens(head)
        # Within the current request, older outputs give way first; then, if the
        # request alone still does not fit, the oldest verbatim turns do.
        observations = [i for i, m in enumerate(current) if m.get("role") == "user" and "<information>" in str(m.get("content"))]
        for i in observations[:-2]:
            if estimate_tokens(current) <= room:
                break
            current[i] = {**current[i], "content": "<information>(output omitted to fit the context budget)</information>"}
        while recent and estimate_tokens(head + current) > self.units:
            recent = recent[1:]
            head = system + first + memory + recent
        # Still over: the request's newest outputs are cut to their head and tail.
        for i in observations[-2:]:
            excess = estimate_tokens(head + current) - self.units
            if excess <= 0:
                break
            content = str(current[i].get("content"))
            keep = max(600, len(content) - int(excess * CHARS_PER_TOKEN) - 200)
            if keep < len(content):
                current[i] = {**current[i], "content": f"{content[: keep * 7 // 10]}\n... ({len(content) - keep} characters omitted to fit the context budget) ...\n{content[-(keep * 3 // 10):]}"}
        compacted = head + current
        with self.log.open("a") as stream:
            stream.write(json.dumps({"turn_index": max(0, len(TURN_STARTS) - 1), "before": estimate_tokens(messages),
                                     "after": estimate_tokens(compacted), "summarized_turns": self.upto,
                                     "verbatim_turns": len(earlier) - self.upto, "summary_chars": len(self.summary),
                                     "scale": round(self.scale, 3), **record}) + "\n")
        return compacted


class TurnMarkingEnv(AllocatedCodeEnv):
    """Upstream calls reset_turns() at the start of every turn; that marks
    where one turn's model calls end and the next one's begin."""

    def init(self, prompt, **extras):
        global ENV
        ENV = self
        result = super().init(prompt, **extras)
        # Upstream logs allocation errors but still reports initialized=True.
        # A benchmark without an executable kernel is a setup failure.
        if self.tool_group.allocated_container is None:
            raise RuntimeError("LongDS kernel allocation failed; refusing model calls without an executor")
        return result

    def reset_turns(self):
        TURN_STARTS.append(len(CALLS))
        # The data-refresh condition: the corrected extract appears as this turn begins.
        if REFRESH and len(TURN_STARTS) == REFRESH[0]:
            shutil.copytree(REFRESH[1], REFRESH[2])
        super().reset_turns()


def install_usage_capture(provider: str) -> None:
    original = litellm.completion

    def completion(*args, **kwargs):
        from comparison_capture import request_record, response_record, usage_record, write_wire
        # The proxy's model names carry no provider prefix; say which API shape
        # they speak so litellm does not have to guess.
        kwargs.setdefault("custom_llm_provider", provider)
        if COMPACTOR is not None and "messages" in kwargs:
            kwargs["messages"] = COMPACTOR.compact(kwargs["messages"], completion, kwargs)
        if FULL_INPUT_BUDGET and estimate_full_input(kwargs, FULL_INPUT_SCALE) > FULL_INPUT_BUDGET:
            raise RuntimeError("Full input remains over the estimated token budget; model request not sent")
        if MODEL_CALL_LIMIT and TURN_STARTS and len(CALLS) - TURN_STARTS[-1] >= MODEL_CALL_LIMIT:
            raise RuntimeError("Turn reached the model call limit including compaction summaries; request not sent")
        started = time.time()
        number = len(CALLS) + 1
        if WIRE_DIR is not None:
            write_wire(WIRE_DIR, number, "request", request_record(kwargs))
        try:
            response = original(*args, **kwargs)
        except Exception as error:
            CALLS.append({"seconds": round(time.time()-started, 3), **usage_record({}), "failed": True})
            if WIRE_DIR is not None:
                write_wire(WIRE_DIR, number, "error", {"error_type": type(error).__name__})
            if CALLS_FILE is not None:
                with CALLS_FILE.open("a") as stream:
                    stream.write(json.dumps({"turn_index": max(0, len(TURN_STARTS)-1), **CALLS[-1]}) + "\n")
            raise
        if WIRE_DIR is not None:
            write_wire(WIRE_DIR, number, "response", response_record(response))
        usage = getattr(response, "usage", None)
        if COMPACTOR is not None and not COMPACTOR.summarizing and "messages" in kwargs:
            COMPACTOR.observe(estimate_tokens(kwargs["messages"]), getattr(usage, "prompt_tokens", 0) or 0)
        CALLS.append(
            {
                "seconds": round(time.time() - started, 3),
                **usage_record(response),
                **({"summary": True} if COMPACTOR is not None and COMPACTOR.summarizing else {}),
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


def build_turns(manifest: dict, gold: dict, turn_limit: int | None, *, functions=False, shared=False, prompts=None) -> list[dict]:
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
    if prompts is not None:
        from state_comparison import build_prompts
        expected = build_prompts(manifest)
        if prompts != expected:
            raise ValueError("Matched prompts do not reproduce from the solver manifest")
        shared_text = {p["turn_id"]: p["prompt"] for p in prompts}
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
    total = lambda key: sum(c[key] for c in calls) if all(c.get(key) is not None for c in calls) else None  # noqa: E731
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
        "llm_calls": sum(1 for c in calls if not c.get("summary")),
        "summary_calls": sum(1 for c in calls if c.get("summary")),
        "cost_usd": None if any(v is None for v in [input_tokens, cached, written, output]) else (
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
    ap.add_argument("--prompts-file", type=Path, help="frozen interface-neutral task text for matched comparisons")
    ap.add_argument("--matched-limits", action="store_true", help="one gateway attempt per model call, matched 8192 output cap")
    ap.add_argument("--wire-trace", action="store_true", help="capture provider requests and all returned choices, excluding credentials")
    ap.add_argument("--reset-at", type=int, default=0,
                    help="restart the kernel before this turn (upstream's reset_env_times), keeping the conversation")
    ap.add_argument("--reset-notice", default="", help="text prepended to the reset turn's message")
    ap.add_argument("--refresh-at", type=int, default=0, help="before this turn the corrected extract appears")
    ap.add_argument("--refresh-src", default="", help="the corrected copy of the task's data directory")
    ap.add_argument("--refresh-dest", default="", help="where the corrected files appear (under the data directory)")
    ap.add_argument("--refresh-notice", default="", help="text prepended to the refresh turn's message")
    ap.add_argument("--context-budget", type=int, help="compact the conversation to fit this many tokens a call")
    ap.add_argument("--compaction", choices=["summary", "inventory"], default="summary",
                    help="summary: a running summary of earlier turns; inventory: plus the live kernel variables")
    args = ap.parse_args()

    api_key = os.environ[args.api_key_env]
    args.out.mkdir(parents=True, exist_ok=True)
    global CALLS_FILE, WIRE_DIR
    CALLS_FILE = args.out / "calls.jsonl"
    WIRE_DIR = args.out / "wire" if args.wire_trace else None
    install_usage_capture("openai")
    if args.context_budget:
        global COMPACTOR
        COMPACTOR = Compactor(args.context_budget, args.compaction, args.out / "compactions.jsonl")
    agent_module.AllocatedCodeEnv = TurnMarkingEnv
    manifest = json.loads(args.manifest.read_text())
    gold = json.loads(args.gold.read_text())
    prompts = json.loads(args.prompts_file.read_text()) if args.prompts_file else None
    turns = build_turns(manifest, gold, args.turn_limit, functions=args.functions, shared=args.shared_protocol, prompts=prompts)
    if args.reset_at and args.reset_notice:
        message = turns[args.reset_at - 1]["prompt"][-1]
        message["content"] = f"{args.reset_notice}\n\n{message['content']}"
    if args.refresh_at:
        global REFRESH
        REFRESH = (args.refresh_at, Path(args.refresh_src), Path(args.refresh_dest))
        message = turns[args.refresh_at - 1]["prompt"][-1]
        message["content"] = f"{args.refresh_notice}\n\n{message['content']}"
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
        **({"max_retries": 1, "max_tokens": 8192} if args.matched_limits else {}),
    )
    bak = args.out / "bak"
    bak.mkdir(exist_ok=True)
    result = agent.solve_task(turns, bak_path=str(bak), reset_env_times=args.reset_at)
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
