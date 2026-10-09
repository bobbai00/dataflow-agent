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

"""Run ONE LongDS turn from gold state with the paper's script agent.

The script-arm counterpart of `run-gold-prefix.ts`: DSGym's
`MultiTurnReActDSAgent`, system prompt and `<python>`/`<answer>` protocol over
the local persistent kernel (`dsgym_executor.py`). Before the turn, the kernel
executes the reference solution of turns 1..t-1 (`seed_kernel.py`), so it holds
the reference variables, helpers and constants; the single request is the same
message text the dataflow arm receives (`message.script.txt`). Model calls are
capped at the turn limit, with the matched output cap and reasoning effort.

    .dsgym-venv/bin/python gold_prefix_dsgym.py --turn-dir <prefix/turns/tNN> \
        --prepared <prepared/case> --out <dir> --model gpt-5.6-terra
"""
import argparse
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
KB_VENV_PYTHON = Path(
    os.environ.get("LONGDS_KERNEL_PYTHON", "/home/bob/Desktop/dataflow-agent/benchmark/Kramabench/.venv/bin/python")
)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--turn-dir", type=Path, required=True)
    ap.add_argument("--prepared", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--api-base", default=os.environ.get("LONGDS_SCRIPT_API_BASE", "http://localhost:34000/v1"))
    ap.add_argument("--api-key-env", default="LITELLM_MASTER_KEY")
    ap.add_argument("--max-steps", type=int, default=40)
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--reasoning-effort", default="medium")
    ap.add_argument("--rates", type=Path, help="JSON {input, cache_read, cache_creation, output} USD per token")
    args = ap.parse_args()

    turn_dir = args.turn_dir.resolve()
    turn_id = int(re.sub(r"^t0*", "", turn_dir.name))
    manifest = json.loads((args.prepared / "manifest.json").read_text())
    gold = next(t for t in json.loads((args.prepared / "gold.json").read_text())["turns"] if t["turn_id"] == turn_id)
    message = (turn_dir / "message.script.txt").read_text()
    seed_code = (turn_dir / "seed_kernel.py").read_text()
    gold_state_root = turn_dir.parents[2]  # <gold_state>/<case>/prefix/turns/tNN -> <gold_state>/<case>
    base = gold_state_root / "base"
    assert base.is_dir(), f"reference base dir missing: {base}"
    if args.out.exists() and any(args.out.iterdir()):
        raise SystemExit(f"output dir must be new or empty: {args.out}")
    args.out.mkdir(parents=True, exist_ok=True)
    wire = args.out / "wire"
    wire.mkdir(exist_ok=True)

    # The harness module (upstream agent + local kernel manager), by path.
    spec = importlib.util.spec_from_file_location("gold_prefix_dsgym_agent", HERE / "dsgym_agent.py")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    if args.rates:
        rates = json.loads(args.rates.read_text())
        runner.RATES = {"input": rates["input"] * 1e6, "cached": rates["cache_read"] * 1e6,
                        "write": rates["cache_creation"] * 1e6, "output": rates["output"] * 1e6}

    # One turn: the system prompt plus the shared message.
    system_prompt = runner.SYSTEM_PROMPT.format(PATH=str(Path(manifest["data_dir"]).resolve()))

    def build_turns(*_args, **_kwargs):
        return [{
            "turn_id": turn_id,
            "context": gold["context"],
            "question": gold["question"],
            "answer": gold["answer"],
            "prompt": [{"role": "system", "content": system_prompt}, {"role": "user", "content": message}],
        }]

    runner.build_turns = build_turns

    # Seed the kernel right after allocation, before any model call.
    seed_record: dict = {}
    original_init = runner.TurnMarkingEnv.init

    def init(self, prompt, **extras):
        result = original_init(self, prompt, **extras)
        started = time.monotonic()
        text = str(self.tool_group.execute_code(seed_code))
        seed_record.update({"seconds": round(time.monotonic() - started, 3), "output": text[-2000:]})
        (args.out / "seed-receipt.json").write_text(json.dumps(seed_record, indent=2))
        if "seeded turns" not in text:
            raise RuntimeError(f"kernel seeding failed: {text[-1500:]}")
        return result

    runner.TurnMarkingEnv.init = init

    # Matched call budget, output cap and effort; passive wire capture.
    original_completion = runner.litellm.completion
    calls = {"n": 0}
    previous = {"messages": None}

    def completion(*cargs, **kwargs):
        calls["n"] += 1
        if calls["n"] > args.max_steps:
            raise RuntimeError(f"Matched {args.max_steps}-call limit reached for this turn")
        kwargs.update(max_tokens=args.max_tokens, reasoning_effort=args.reasoning_effort, num_retries=0, timeout=180)
        kwargs.pop("temperature", None)
        allowed = {"model", "messages", "max_tokens", "max_completion_tokens", "reasoning_effort", "stop", "tools",
                   "tool_choice"}
        request = json.loads(json.dumps({k: v for k, v in kwargs.items() if k in allowed}))
        prefix_changed = previous["messages"] is not None and request["messages"][: len(previous["messages"])] != previous["messages"]
        previous["messages"] = request["messages"]
        stem = wire / f"{calls['n']:06d}"
        stem.with_name(stem.name + "-request.json").write_text(json.dumps(request, indent=2))
        started = time.monotonic()
        response = original_completion(*cargs, **kwargs)
        raw = response.model_dump()
        stem.with_name(stem.name + "-response.json").write_text(json.dumps(raw, indent=2))
        usage = raw.get("usage", {})
        with (wire / "audit.jsonl").open("a") as out:
            out.write(json.dumps({"call": calls["n"], "seconds": time.monotonic() - started,
                                  "prefix_changed": prefix_changed,
                                  "finish_reason": raw["choices"][0].get("finish_reason"), "usage": usage}) + "\n")
        return response

    runner.litellm.completion = completion

    # The local kernel executor, with the reference base directory mounted.
    port = free_port()
    executor_url = f"http://127.0.0.1:{port}"
    data_root = Path(manifest["data_dir"]).resolve()
    with (args.out / "executor.log").open("w") as executor_log:
        executor = subprocess.Popen(
            [str(KB_VENV_PYTHON), str(HERE / "dsgym_executor.py"), "--port", str(port),
             "--data-root", str(data_root), "--workspace", str(args.out / "kernel-workspaces"),
             "--extra-ro", str(base)],
            cwd=HERE, stdout=executor_log, stderr=subprocess.STDOUT,
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
            sys.argv = [
                "dsgym_agent.py", "--manifest", str(args.prepared / "manifest.json"),
                "--gold", str(args.prepared / "gold.json"), "--model", args.model, "--out", str(args.out / "agent"),
                "--executor-url", executor_url, "--api-base", args.api_base, "--api-key-env", args.api_key_env,
                "--turn-limit", "1", "--max-steps", str(args.max_steps),
            ]
            started = time.monotonic()
            code = runner.main()
            elapsed = time.monotonic() - started
        finally:
            executor.terminate()
            try:
                executor.wait(timeout=30)
            except subprocess.TimeoutExpired:
                executor.kill()
    answers = json.loads((args.out / "agent/answers.json").read_text())
    answer = answers[0] if answers else {"answer": "", "error": "no answer recorded", "steps": 0, "stats": {}}
    traj = json.loads((args.out / "agent/traj.json").read_text())
    conversation = traj.get("conversation", [])
    code_blocks = [m for m in conversation if m.get("role") == "assistant" and "<python>" in str(m.get("content"))]
    raw_reads = sum(1 for m in code_blocks if re.search(r"read_csv|read_parquet|read_excel|open\(", str(m.get("content"))))
    record = {
        "turn_id": turn_id,
        "context": gold["context"],
        "question": gold["question"],
        "solution": answer.get("answer") or "",
        "ground_truth": gold["answer"],
        "state_type": gold.get("state_type"),
        "depends_tasks": gold.get("depends_tasks"),
        "depends_span": gold.get("depends_span"),
        "success": bool(answer.get("answer")) and not answer.get("error"),
        "error": answer.get("error") or "",
        "steps": answer.get("steps", 0),
        "stats": {**answer.get("stats", {}), "elapsed_seconds": round(elapsed, 3), "seed_seconds": seed_record.get("seconds")},
        "protocol": "gold-prefix",
        "arm": "dsgym",
        "model": args.model,
        "state_use": {"code_blocks": len(code_blocks), "blocks_reading_files": raw_reads},
    }
    (args.out / "results_with_ground_truth.json").write_text(json.dumps([record], indent=2, ensure_ascii=False))
    (args.out / "protocol.json").write_text(json.dumps({
        "protocol": "gold-prefix", "arm": "dsgym", "model": args.model, "task": manifest["key"], "turn_id": turn_id,
        "max_steps": args.max_steps, "max_output_tokens": args.max_tokens, "reasoning_effort": args.reasoning_effort,
        "api_base": args.api_base, "kernel_python": str(KB_VENV_PYTHON), "turn_dir": str(turn_dir),
        "dataset_revision": manifest.get("dataset_revision"),
    }, indent=2))
    print(json.dumps({"turn": turn_id, "answer": bool(record["solution"]), "steps": record["steps"],
                      "calls": calls["n"], "seconds": round(elapsed, 1)}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
