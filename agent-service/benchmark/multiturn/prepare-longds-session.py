#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Prepare any prepared LongDS session for the strict multi-task harness.

The GitHub adaptation hand-wrote one answer contract per turn. That does not
scale to 42-turn sessions whose answers are nested objects, so this preparer
derives each contract from the *shape* of the gold answer — key names, array
lengths, nesting, scalar kinds — and nothing else. Values never enter the
contract; ordering is left to the question's own words, exactly as it is for
every agent that takes the official benchmark. Both arms receive the same text.

Public side, session.json: file inventory, context, question, contract.
Private side, gold.json (parsed answers) and checks.json (per turn: the LongDS
state labels and dependency list, so results can be grouped by Update /
Rollback / Counterfactual without the model ever seeing them).

Upstream gold carries presentation metadata the questions never request
(`answer_type`, `primary_metric`, `model`); those keys are dropped from gold
and are listed in the run log, as the GitHub preparer did for its two cases.
"""
import argparse
import ast
import json
from pathlib import Path

STRIP_DEFAULT = ("answer_type", "primary_metric", "model")


def parse_answer(raw):
    if not isinstance(raw, str):
        return raw
    for loader in (json.loads, ast.literal_eval):
        try:
            return loader(raw)
        except (ValueError, SyntaxError):
            continue
    raise ValueError(f"unparseable gold answer: {raw[:80]!r}")


def parse_list(raw):
    if isinstance(raw, list):
        items = raw
    else:
        try:
            items = ast.literal_eval(raw)
        except (ValueError, SyntaxError):
            items = []
    out = []
    for item in items:
        if isinstance(item, str) and item.startswith("task_"):
            item = int(item.split("_", 1)[1])
        out.append(item)
    return out


def kind(value):
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "null"
    return "value"


def describe(value, depth=0):
    """Structure only: key names, counts, nesting and scalar kinds."""
    if isinstance(value, dict):
        if not value:
            return "empty object"
        if all(not isinstance(v, (dict, list)) for v in value.values()):
            return "object with " + ", ".join(f"{k} ({kind(v)})" for k, v in value.items())
        return "object with " + "; ".join(f"{k}: {describe(v, depth + 1)}" for k, v in value.items())
    if isinstance(value, list):
        n = len(value)
        if not value:
            return "empty array"
        first = value[0]
        if isinstance(first, dict):
            keys = list(first.keys())
            return f"array of {n} objects with {', '.join(keys)}"
        if isinstance(first, list):
            return f"array of {n} arrays"
        return f"array of {n} {kind(first)}s"
    return kind(value)


def contract_for(answer):
    body = describe(answer)
    body = body[0].upper() + body[1:]
    return (
        body
        + ". Use exactly these keys; arrays in the order the question asks for; "
        + "numbers as JSON numbers with the precision the session's instructions specify."
    )


def prepare(source: Path, destination: Path, family: str, strip, overrides):
    manifest = json.loads((source / "manifest.json").read_text())
    gold_turns = json.loads((source / "gold.json").read_text())["turns"]
    assert len(manifest["turns"]) == len(gold_turns), "manifest and gold disagree on turn count"
    destination.mkdir(parents=True, exist_ok=False)
    public, gold, checks, log = [], [], [], []
    for index, (task, gold_turn) in enumerate(zip(manifest["turns"], gold_turns), 1):
        assert str(task["turn_id"]) == str(gold_turn["turn_id"])
        answer = parse_answer(gold_turn["answer"])
        dropped = []
        if isinstance(answer, dict):
            for key in strip:
                if key in answer:
                    answer.pop(key)
                    dropped.append(key)
        contract = overrides.get(str(index)) or contract_for(answer)
        inventory = ("Available files:\n" + "\n".join(manifest["files"]) + "\n\n") if not public else ""
        context = (task.get("context") or "").strip()
        prompt = inventory + (context + "\n\n" if context else "") + task["question"].strip()
        prompt += "\n\nReturn only JSON. Answer format: " + contract
        public.append(dict(id=str(task["turn_id"]), prompt=prompt))
        gold.append(answer)
        checks.append(
            dict(
                fields={},
                correction=False,
                state_type=parse_list(gold_turn.get("state_type", [])),
                depends_tasks=parse_list(gold_turn.get("depends_tasks", [])),
            )
        )
        log.append(dict(turn=index, contract_chars=len(contract), dropped_gold_keys=dropped, state_type=checks[-1]["state_type"]))
    (destination / "session.json").write_text(json.dumps(dict(family=family, files=manifest["files"], turns=public), indent=2))
    (destination / "gold.json").write_text(json.dumps(gold, indent=2))
    (destination / "checks.json").write_text(json.dumps(checks, indent=2))
    (destination / "prepare-log.json").write_text(
        json.dumps(dict(source_key=manifest["key"], family=family, stripped_keys=list(strip), turns=log), indent=2)
    )
    return log


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="prepared/<key> directory with manifest.json and gold.json")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--family", required=True)
    parser.add_argument("--strip", default=",".join(STRIP_DEFAULT), help="top-level gold keys the questions never request")
    parser.add_argument("--contracts", type=Path, help='JSON {"<turn index>": "<contract text>"} overriding generated ones')
    args = parser.parse_args()
    overrides = json.loads(args.contracts.read_text()) if args.contracts else {}
    strip = tuple(k for k in args.strip.split(",") if k)
    for entry in prepare(args.source, args.destination, args.family, strip, overrides):
        print(json.dumps(entry))
