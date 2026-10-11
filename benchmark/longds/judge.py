# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Judge LongDS session runs with the benchmark's own judge.

The prompt is upstream's `JUDGE_PROMPT`, loaded by path from the DataMind
checkout so an upstream edit cannot desynchronize scoring. The judge model is
the paper's, deepseek-v4-pro, through OpenRouter (OPENROUTER_API_KEY). Each
answer is scored 0 or 1; an empty answer scores 0 without a call, and a reply
with no score is left unscored (None) rather than counted as a failure.
Verdicts are cached by (model, prompt, turn), so re-judging costs nothing.

Usage (from the repository root):
    python -m benchmark.longds.judge --runs R/runs
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re

from benchmark.longds.common import JUDGE_PROMPT, load, save

MODEL = "deepseek/deepseek-v4-pro"
BASE_URL = "https://openrouter.ai/api/v1"
SCORE = re.compile(r"<score>\s*(\d)\s*</score>")
REASON = re.compile(r"<reasoning>(.*?)</reasoning>", re.DOTALL)


def judge_prompt():
    spec = importlib.util.spec_from_file_location("longds_upstream_prompt", JUDGE_PROMPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.JUDGE_PROMPT


def verdict(client, template, gold_turn, answer, retries=2):
    """One answer against its gold, as upstream scores it."""
    gold = gold_turn["answer"]
    if not gold or not (answer or "").strip():
        return {"score": 0, "reason": "empty answer", "usage": []}
    prompt = template.format(question=f"{gold_turn['context']}\nQuestion: {gold_turn['question']}",
                             ground_truth=json.dumps(gold, ensure_ascii=False) if isinstance(gold, (dict, list))
                             else str(gold), solution=answer)
    usage, text = [], ""
    for _ in range(retries + 1):
        try:
            # max_tokens leaves room for the judge's hidden reasoning before the score tag;
            # OpenRouter reports each call's cost when asked.
            response = client.chat.completions.create(model=MODEL, temperature=0.0, max_tokens=8192,
                                                      messages=[{"role": "user", "content": prompt}],
                                                      extra_body={"usage": {"include": True}})
        except Exception as error:  # noqa: BLE001 - a transport failure is not a verdict
            return {"score": None, "reason": f"judge call failed: {error}", "usage": usage}
        usage.append(response.usage.model_dump() if response.usage else {})
        text = response.choices[0].message.content or ""
        if (match := SCORE.search(text)) and match.group(1) in ("0", "1"):
            reason = REASON.search(text)
            return {"score": int(match.group(1)), "reason": reason.group(1).strip() if reason else "", "usage": usage}
    return {"score": None, "reason": "no score in the reply", "raw": text, "usage": usage}


def judge_run(run, client, template, cache, workers=8):
    """Judge every request of one session run; writes tNN/judge.json."""
    protocol = load(run / "protocol.json")
    gold = {turn["turn_id"]: turn for turn in load(Path(protocol["prepared"]) / "gold.json")["turns"]}
    records = load(run / "records.json") if (run / "records.json").exists() else []

    def one(record):
        target = run / f"t{record['turn_id']:02d}" / "judge.json"
        if target.exists() and load(target).get("score") is not None:
            return load(target)
        turn = gold[record["turn_id"]]
        key = hashlib.sha256(json.dumps([MODEL, template, turn["context"], turn["question"], turn["answer"],
                                         record["answer"]], sort_keys=True, default=str).encode()).hexdigest()
        cached = cache / f"{key}.json"
        if cached.exists():
            result = load(cached)
        else:
            result = verdict(client, template, turn, record["answer"])
            if result["score"] is not None:
                save(cached, result)
        save(target, result)
        return result

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, records))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=Path, required=True, help="folder of session runs")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    from openai import OpenAI
    client = OpenAI(base_url=BASE_URL, api_key=os.environ["OPENROUTER_API_KEY"], max_retries=2, timeout=900)
    template = judge_prompt()
    cache = args.runs.parent / "judge-cache"
    for run in sorted(path for path in args.runs.iterdir() if (path / "protocol.json").exists()):
        verdicts = judge_run(run, client, template, cache, args.workers)
        scored = [v for v in verdicts if v["score"] is not None]
        print(f"{run.name}: {sum(v['score'] for v in scored)}/{len(verdicts)} correct"
              f"{f', {len(verdicts) - len(scored)} unscored' if len(scored) < len(verdicts) else ''}")


if __name__ == "__main__":
    main()
