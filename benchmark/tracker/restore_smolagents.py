# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""What it takes smolagents to go back to an earlier step: run the recorded code of every step up to it again.

smolagents keeps no snapshot of its Python state, so returning to step k of a conversation means a fresh interpreter
state and the code of steps 1..k, run again in order. For random (conversation, step) pairs, this runs that code in
the baseline's interpreter (benchmark/retrieval/script-agent) and its executor, in a fresh child process per pair with
the task data where the benchmark mounted it, and records the time the code took (the process's start and loading
pandas and numpy, which a running session has done already, are not counted).

    benchmark/retrieval/script-agent/.venv/bin/python benchmark/tracker/restore_smolagents.py \\
        CONVERSATIONS.jsonl OUT.jsonl --data benchmark/Kramabench/data --kramabench benchmark/Kramabench [--samples 300]
"""
import argparse
import json
import random
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# Runs in the child: the baseline's executor, the code of steps 1..k, the time it took.
CHILD = r"""
import json, sys, time
sys.path.insert(0, sys.argv[1])
from code_agent import AUTHORIZED_IMPORTS, DEFAULT_MAX_PRINT_OUTPUTS_LENGTH
from smolagents.default_tools import FinalAnswerTool
from smolagents.local_python_executor import LocalPythonExecutor
codes = json.load(sys.stdin)
executor = LocalPythonExecutor(AUTHORIZED_IMPORTS, max_print_outputs_length=DEFAULT_MAX_PRINT_OUTPUTS_LENGTH or 5000,
                               additional_functions={"open": open})
executor.send_tools({"final_answer": FinalAnswerTool()})
# A session's interpreter has its libraries loaded already: only running the code again is counted.
import numpy, pandas  # noqa: E401,F401
errors = 0
started = time.perf_counter()
for code in codes:
    try:
        executor(code)
    except Exception:
        errors += 1
print(json.dumps({"seconds": time.perf_counter() - started, "errors": errors}))
"""


def codes_of(conversation):
    """The code each step ran: recorded, or for a conversation without a memory dump, parsed from the model output."""
    from smolagents.utils import parse_code_blobs

    codes = []
    for step, response in zip(conversation["steps"], conversation["responses"]):
        code = step.get("code_action")
        if code is None:
            try:
                code = parse_code_blobs(response["choices"][0]["message"]["content"] or "", ("<code>", "</code>"))
            except Exception:
                code = None
        codes.append(code)
    return codes


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("conversations", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--data", type=Path, required=True, help="the KramaBench data folder the tasks read")
    parser.add_argument("--kramabench", type=Path, required=True, help="the KramaBench checkout (its code_agent.py)")
    parser.add_argument("--samples", type=int, default=300)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    conversations = [json.loads(line) for line in args.conversations.read_text().splitlines()]
    steps = [(c, k) for c in conversations for k, code in enumerate(codes_of(c), 1) if code]
    pairs = random.Random(args.seed).sample(steps, min(args.samples, len(steps)))
    with args.out.open("w") as sink:
        for index, (conversation, k) in enumerate(pairs, 1):
            codes = [code for code in codes_of(conversation)[:k] if code]
            with tempfile.TemporaryDirectory() as workspace:
                (Path(workspace) / "data").symlink_to(args.data.resolve())
                started = time.monotonic()
                try:
                    run = subprocess.run([sys.executable, "-c", CHILD, str(args.kramabench.resolve())],
                                         input=json.dumps(codes), capture_output=True, text=True, cwd=workspace,
                                         timeout=args.timeout)
                    result = json.loads(run.stdout.strip().splitlines()[-1])
                except (subprocess.TimeoutExpired, IndexError, json.JSONDecodeError) as error:
                    result = {"seconds": None, "failed": type(error).__name__}
            line = {"conversation": conversation["id"], "step": k, "steps": len(codes), **result,
                    "wall": time.monotonic() - started}
            sink.write(json.dumps(line) + "\n")
            sink.flush()
            print(f"{index}/{len(pairs)} {conversation['id']} step {k}: {result.get('seconds')}", flush=True)


if __name__ == "__main__":
    main()
