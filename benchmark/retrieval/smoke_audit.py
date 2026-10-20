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
"""Audit a single-task run directory: outcome, cost, prompt, receipts and integrity.

Usage: python benchmark/retrieval/smoke_audit.py <run output directory>
Reports per task the score, cost, calls and cached share; that the system
prompt is the single-task prompt with balanced fences; the recorded settings;
that receipts use the observation format; how the answer was submitted; any
harness preflight error; and model code that probes the filesystem, processes
or network, together with sandbox denials in the receipts.
"""
import json
import re
import sys
from pathlib import Path

PROBES = re.compile(r"subprocess|os\.walk|os\.listdir|glob\.glob|\bopen\(|socket|urllib|requests\.|/proc/|\bgit\b|\.\./")
DENIALS = re.compile(r"Read-only file system|not a git repository|Permission denied|Network is unreachable|"
                     r"Temporary failure in name resolution|File I/O operations are not allowed")
MULTI_TASK = ["Earlier tasks in the session", "Historical state", "Task catalog"]


def steps_of(path):
    data = json.loads(path.read_text())
    return data if isinstance(data, list) else data.get("steps", [])


def audit_task(task):
    row = {"task": task.name}
    if (task / "preflight.json").exists():
        row["preflight"] = json.loads((task / "preflight.json").read_text())
    evaluation = json.loads((task / "evaluation.json").read_text()) if (task / "evaluation.json").exists() else {}
    row["answer"] = json.loads((task / "answer.json").read_text()).get("answer") if (task / "answer.json").exists() else None
    stats = json.loads((task / "stats.json").read_text()) if (task / "stats.json").exists() else {}
    row.update(cost=stats.get("cost_usd"), calls=stats.get("num_steps"),
               cached=round(stats.get("cached_tokens", 0) / max(stats.get("input_tokens", 1), 1), 2))
    info = json.loads((task / "system-info.json").read_text()) if (task / "system-info.json").exists() else {}
    prompt = info.get("systemPrompt", "")
    row["prompt"] = {"chars": len(prompt), "sections": [l[3:] for l in prompt.splitlines() if l.startswith("## ")],
                     "multi_task_text": [k for k in MULTI_TASK if k in prompt],
                     "fences_balanced": prompt.count("```") % 2 == 0}
    settings = json.loads((task / "settings.json").read_text()) if (task / "settings.json").exists() else {}
    row["settings"] = {k: settings.get(k) for k in ["retrievalViews", "dataEvidence", "flowEvidence", "multiTask",
                                                    "stateHistory", "stateLedger", "tableFormat", "maxResultRows"]}
    answers, receipts, probes, denials, headings = [], 0, [], [], 0
    if (task / "react_steps.json").exists():
        for step in steps_of(task / "react_steps.json"):
            for call in step.get("toolCalls") or []:
                for action in (call.get("input") or {}).get("actions", []) or []:
                    if not isinstance(action, dict):
                        continue
                    if action.get("type") == "answer":
                        answers.append("from" if "from" in action else "content")
                    if action.get("type") == "edit":
                        probes += sorted(set(PROBES.findall(action.get("changes", ""))))
            receipts += len(step.get("toolResults") or [])
        # Receipts as the model read them: tool messages in the last request.
        last = next((s for s in reversed(steps_of(task / "react_steps.json")) if s.get("inputMessages")), {})
        for message in last.get("inputMessages") or []:
            if message.get("role") != "tool":
                continue
            text = json.dumps(message.get("content"))
            headings += len(re.findall(r"### \d+\. [a-z]+", text))
            denials += DENIALS.findall(text)
    row.update(answers=answers, receipts=receipts, receipt_headings=headings,
               probes=sorted(set(probes)), denials=sorted(set(denials)))
    return row, evaluation


def main():
    root = Path(sys.argv[1])
    progress = json.loads((root / "progress.json").read_text()) if (root / "progress.json").exists() else {}
    scores = {r["task"]: r.get("score") for r in progress.get("completed", [])}
    for sut in sorted((root / "system_scratch").iterdir()):
        for task in sorted(p for p in sut.iterdir() if p.is_dir()):
            row, _ = audit_task(task)
            print(f"== {row['task']}: score={scores.get(row['task'])} cost=${row['cost']} calls={row['calls']} "
                  f"cached={row['cached']} answers={row['answers']} answer={str(row['answer'])[:50]!r}")
            print(f"   prompt {row['prompt']['chars']} chars, sections={row['prompt']['sections']}, "
                  f"multi-task text={row['prompt']['multi_task_text']}, fences balanced={row['prompt']['fences_balanced']}")
            print(f"   settings {row['settings']}")
            print(f"   receipts={row['receipts']} with {row['receipt_headings']} '### N. action' headings; "
                  f"probing code={row['probes']}; sandbox denials={row['denials']}"
                  + (f"; PREFLIGHT {row['preflight']}" if "preflight" in row else ""))


if __name__ == "__main__":
    main()
