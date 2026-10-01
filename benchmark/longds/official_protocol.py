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

"""The official LongDS protocol, shared by every arm of the comparison.

Contexts and questions come from the prepared upstream task unchanged. The only
text this module adds is a session preamble that lists the data files and states
the answer marker the judge needs in order to find a final answer. Nothing here
describes the *shape* of the expected answer. Upstream judges semantic and
numeric consistency without constraining output format, and its curation
deliberately strips restatements of earlier definitions, so handing the agent the
gold's key names or array lengths would change the task. Our earlier adapted
track did exactly that; this module exists so the comparison stops doing it.

The preamble differs between arms in one paragraph only: how that arm's own state
persists. Everything else, including the answer contract and the file inventory,
is byte-identical across arms.

`ANSWER_CONTRACT` and `FINAL_ANSWER_RE` are copied from `run_longds.py` so the
answers this harness produces are extracted exactly as that runner's are;
`selftest()` asserts they still match that file.
"""
import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent

FINAL_ANSWER_RE = re.compile(
    r"(?:\*\*\s*)?final answer:\s*(?:\*\*\s*)?(.+?)(?:\s*\*\*)?\s*$", re.IGNORECASE | re.DOTALL
)

ANSWER_CONTRACT = (
    "Report the answer as a single-line JSON object holding exactly the "
    "quantities this question asks for, and nothing else. For numerical answers, "
    "provide the exact value requested (rounded as specified if mentioned). Do not "
    "restate the whole chain of reasoning as the answer.\n"
    "Your last line MUST BE: **Final Answer: <single-line JSON>**"
)

#: One paragraph per arm, describing only how that arm's own state persists.
PERSISTENCE = {
    "dataflow": (
        "- The operators you create stay available to my later requests. Name them "
        "meaningfully so you and I can refer back to them.\n"
        "- Editing an operator recomputes whatever depends on it, so you do not have "
        "to rebuild downstream work by hand."
    ),
    "script": (
        "- The Python variables you define stay available to my later requests. Name "
        "them meaningfully so you and I can refer back to them.\n"
        "- Nothing is reset between requests, so you do not have to reload or "
        "recompute earlier work by hand."
    ),
}

LISTING_HINT = {
    "dataflow": (
        "- When you need the exact file names in a folder, list it with a `process` "
        "function using `glob`; `scan(path, preview=n)` shows a file's first lines."
    ),
    "script": "- When you need the exact file names in a folder, list it with `os.listdir` or `glob`.",
}

# Up to this many files are listed one per line. Beyond it the inventory is the
# data directory and its folders with file counts: upstream's agent receives the
# directory alone and lists it itself, and a 533-file inventory (policing) is
# 27k tokens that would otherwise ride on every model call of the session.
INVENTORY_FULL_LIMIT = 12


def inventory(manifest: dict) -> tuple[str, str, bool]:
    """(heading, lines, summarized)."""
    files = manifest["files"]
    if len(files) <= INVENTORY_FULL_LIMIT:
        heading = "Data files available (use these paths verbatim, they are relative — no leading slash):"
        return heading, "\n".join(f" - {path}" for path in files), False
    data_dir = manifest["data_dir"].rstrip("/")
    counts: Counter = Counter()
    for path in files:
        rel = path[len(data_dir) + 1 :] if path.startswith(data_dir + "/") else path
        parts = rel.split("/")
        counts["/".join(parts[:2]) if len(parts) > 2 else (parts[0] if len(parts) == 2 else "(top level)")] += 1
    heading = "Data directory (relative path, no leading slash) and its folders with file counts:"
    lines = [f" - {data_dir}/  ({len(files)} files)"]
    lines += [f"   - {folder}/: {count} files" for folder, count in sorted(counts.items())]
    return heading, "\n".join(lines), True


SHARED_RULES = (
    "- Do not use plotting libraries. Use text summaries and statistics.\n"
    "- Use code for every calculation rather than doing arithmetic yourself.\n"
    "- Answer only when you have evidence for the answer."
)


def build_prompts(manifest: dict, arm_kind: str) -> list[dict]:
    """Every turn's prompt. Turn 1 carries the session frame; later turns are
    context and question only, exactly as upstream presents them."""
    smolagents = arm_kind == "smolagents"
    if smolagents:
        arm_kind = "script"
    if arm_kind not in PERSISTENCE:
        raise ValueError(f"arm_kind must be one of {sorted(PERSISTENCE)}")
    answer_contract = ANSWER_CONTRACT
    if smolagents:
        # Port the evidence-only-context branch's final_answer_tool_prompt fix:
        # a plain-text closing marker contradicts CodeAgent's tool protocol.
        answer_contract = answer_contract.replace(
            "Your last line MUST BE: **Final Answer: <single-line JSON>**",
            "When you have the answer, call final_answer(<value>) inside your code, "
            "with the value in the answer format above.",
        )
    heading, files, summarized = inventory(manifest)
    rules = PERSISTENCE[arm_kind] + (f"\n{LISTING_HINT[arm_kind]}" if summarized else "")
    prompts = []
    for index, turn in enumerate(manifest["turns"]):
        body = f"{turn['context']}\nQuestion: {turn['question']}"
        if index == 0:
            body = (
                "You are an expert data scientist working through a long analysis with me. "
                "I will send you a series of requests, one at a time, about the same data.\n\n"
                f"{heading}\n"
                f"{files}\n\n"
                "How this session works:\n"
                f"{rules}\n{SHARED_RULES}\n\n"
                f"{answer_contract}\n\n"
            ) + body
        prompts.append({"turn_id": turn["turn_id"], "prompt": body})
    return prompts


def extract_answer(response: str) -> str:
    """The payload after the final-answer marker, or the whole reply if the model
    never emitted one. Never invent an answer for a turn that produced none."""
    if not response:
        return ""
    match = FINAL_ANSWER_RE.search(response.strip())
    return (match.group(1) if match else response).strip()


def write_records(run_dir: Path, task_key: str, arm: str, model: str, gold: dict, turns: list[dict]) -> None:
    """`results_with_ground_truth.json` in upstream's shape, so
    `judge_longds.py --sut <SUT>` scores this run with no change on its side."""
    by_id = {t["turn_id"]: t for t in gold["turns"]}
    records = []
    for turn in turns:
        g = by_id.get(turn["turn_id"], {})
        records.append(
            {
                "turn_id": turn["turn_id"],
                "context": g.get("context", ""),
                "question": g.get("question", ""),
                "solution": turn["answer"],
                "ground_truth": g.get("answer"),
                "state_type": g.get("state_type", []),
                "depends_tasks": g.get("depends_tasks", []),
                "depends_span": g.get("depends_span", []),
                "success": bool(turn["answer"]) and not turn.get("error"),
                "steps": turn.get("steps", 0),
                "stats": turn.get("stats", {}),
            }
        )
    (run_dir / "results_with_ground_truth.json").write_text(json.dumps(records, indent=2, ensure_ascii=False))
    (run_dir / "summary.json").write_text(
        json.dumps(
            {
                "task": task_key,
                "arm": arm,
                "model": model,
                "turns_total": len(gold["turns"]),
                "turns_completed": len(records),
                "answers_present": sum(1 for r in records if r["solution"]),
                "cost_usd": round(sum((r["stats"] or {}).get("cost_usd", 0) for r in records), 6),
                "llm_calls": sum((r["stats"] or {}).get("llm_calls", 0) for r in records),
            },
            indent=2,
        )
    )


def selftest() -> None:
    """The contract and the extraction regex must still match `run_longds.py`."""
    source = (HERE / "run_longds.py").read_text()
    assert ANSWER_CONTRACT.split("\n")[0][:60] in source, "ANSWER_CONTRACT drifted from run_longds.py"
    assert r"(?:\*\*\s*)?final answer:\s*(?:\*\*\s*)?(.+?)(?:\s*\*\*)?\s*$" in source, "regex drifted"
    assert extract_answer('blah\n**Final Answer: {"a": 1}**') == '{"a": 1}'
    assert extract_answer('blah\n**Final Answer:** {"a": 1}') == '{"a": 1}'
    assert extract_answer("") == ""
    print("official_protocol selftest OK")


if __name__ == "__main__":
    selftest()
