#!/usr/bin/env python
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

"""Rules in force for the gold-prefix protocol.

A LongDS session states a convention once (a tie order, a rounding rule, a
denominator, a fallback clause, a population definition) and later tasks rely
on it without restating it; in the pilot, twelve turns failed in every arm on
such a clause. This script writes, for every eligible turn t, the conventions
set by tasks 1..t-1 as a short block (`rules.md` in the turn folder), extracted
from the completed tasks' request texts by the model named on the command line.
`gold_prefix.build_message` places the block before the current question in
BOTH arms, so the protocol input is identical for the script and the dataflow
agents. A turn's block is written once and reused (`--overwrite` rewrites it);
the model call and its response are recorded next to it (`rules.json`).

    gold_prefix_rules.py --gold-state <dir> --prepared <prepared> [--model gpt-5.6-terra]
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

from gold_prefix import ARM_TEXT, build_message

SYSTEM = (
    "You extract the conventions a multi-step data analysis has to keep following. From the completed tasks' texts, "
    "list every rule that applies to later tasks: ordering and tie-breaking, rounding and scales, denominators and "
    "missing-value handling, population, window and eligibility definitions, fallback clauses, named thresholds and "
    "weights. One line per rule, starting with the task that set it in parentheses, in the task's own words where "
    "possible. Include a rule only if a task states it; never infer one. When a later task changes a rule, give the "
    "current version and name both tasks. Output only the list, at most 25 lines."
)


def task_texts(turns: list[dict], upto: int) -> str:
    parts = []
    for t in turns:
        if t["turn_id"] > upto:
            break
        parts.append(f"Task {t['turn_id']}:\n{(t.get('context') or '').strip()}\nQuestion: {(t.get('question') or '').strip()}")
    return "\n\n".join(parts)


def extract(client, model: str, turns: list[dict], upto: int, max_tokens: int) -> tuple[str, dict]:
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": task_texts(turns, upto)}],
        max_completion_tokens=max_tokens,
    )
    text = (response.choices[0].message.content or "").strip()
    usage = response.usage.model_dump() if getattr(response, "usage", None) else {}
    return text, usage


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gold-state", type=Path, required=True, help="gold_state.py output dir (manifest.json, prefix/)")
    ap.add_argument("--prepared", type=Path, required=True, help="prepared case dir (manifest.json with files)")
    ap.add_argument("--model", default="gpt-5.6-terra")
    ap.add_argument("--api-base", default=os.environ.get("LONGDS_SCRIPT_API_BASE", "http://localhost:34000/v1"))
    ap.add_argument("--api-key-env", default="LITELLM_MASTER_KEY")
    ap.add_argument("--max-tokens", type=int, default=4096)
    ap.add_argument("--turns", default="", help="comma-separated turn ids (default: every eligible turn)")
    ap.add_argument("--overwrite", action="store_true")
    args = ap.parse_args()
    from openai import OpenAI

    key = os.environ.get(args.api_key_env)
    if not key:
        raise SystemExit(f"{args.api_key_env} is required")
    client = OpenAI(base_url=args.api_base, api_key=key)
    manifest = json.loads((args.gold_state / "manifest.json").read_text())
    index = json.loads((args.gold_state / "prefix" / "index.json").read_text())
    files = json.loads((args.prepared / "manifest.json").read_text())["files"]
    wanted = {int(t) for t in args.turns.split(",") if t.strip()}
    written = 0
    for entry in index["turns"]:
        tid = entry["turn_id"]
        if not entry["eligible"] or (wanted and tid not in wanted):
            continue
        folder = Path(entry["dir"])
        target = folder / "rules.md"
        if target.exists() and not args.overwrite:
            continue
        started = time.monotonic()
        text, usage = extract(client, args.model, manifest["turns"], tid - 1, args.max_tokens)
        if not text:
            print(f"turn {tid}: empty extraction, skipped", file=sys.stderr)
            continue
        target.write_text(f"Rules in force after task {tid - 1} (stated by the completed tasks' requests):\n{text}\n")
        (folder / "rules.json").write_text(
            json.dumps({"model": args.model, "upto": tid - 1, "seconds": round(time.monotonic() - started, 1),
                        "usage": usage, "system": SYSTEM}, indent=1)
        )
        for arm in ARM_TEXT:
            (folder / f"message.{arm}.txt").write_text(build_message(arm, folder, files))
        written += 1
        print(f"turn {tid}: {len(text.splitlines())} rules, {usage.get('prompt_tokens')}+{usage.get('completion_tokens')} tokens", file=sys.stderr)
    print(f"{manifest['key']}: {written} rules blocks written", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
