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
"""How well can a model select context from each index? Offline, from full-history runs.

For every request from the third on, each index (selection.py) is built as it
stood then, from that agent's own full-history run, and a model is asked which
earlier tasks the request builds on. Picks are scored against the benchmark's
dependencies (gold depends_tasks; task 1 is always kept, so it is left out of
the scoring on both sides). The dataflow index is also asked for tables, scored
against the earlier tables the full-history run actually read in that request.

Usage (from the repository root, inside the stack's environment):
    python -m benchmark.longds.selection_eval --root R --out R/selection-eval.json
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
import json
import os
from pathlib import Path
import re
import statistics

from openai import OpenAI

from benchmark.longds.common import load
from benchmark.longds.selection import (SET, IDENT, dataflow_tasks, render_index, request_text, script_tasks,
                                        select_tables, select_tasks)

PRICE = {"input": 0.2e-6, "cached": 0.02e-6, "output": 1.2e-6}  # gpt-5.6-luna


def steps_of(run):
    return {int(re.search(r"/t(\d+)/", str(path)).group(1)): load(path) for path in Path(run).glob("t*/steps.json.gz")}


def first_inputs(steps, script):
    """First model call's input tokens per request (the history grows by what each request added)."""
    out = {}
    for task, steps_ in steps.items():
        if script:
            calls = [s for s in steps_ if s.get("type") == "action" and s.get("token_usage")]
            if calls: out[task] = calls[0]["token_usage"]["input_tokens"]
        else:
            calls = [s for s in steps_ if s.get("role") == "agent" and s.get("usage")]
            if calls: out[task] = calls[0]["usage"]["inputTokens"]
    return out


def tables_read(steps, task, before):
    """Earlier tables (created before `task`) that `task`'s edits read."""
    read = set()
    for step in steps.get(task, []):
        for result in step.get("toolResults") or []:
            for action in (result.get("output") or {}).get("actions", []):
                if action["action"]["type"] == "edit" and action["status"] == "ok":
                    for _, _, args in SET.findall(action["action"].get("changes") or ""):
                        read |= {name for name in IDENT.findall(args.split("lambda")[0]) if name in before}
    return read


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    client = OpenAI(base_url=os.environ["LITELLM_BASE_URL"].rstrip("/") + "/v1", api_key=os.environ["LITELLM_MASTER_KEY"],
                    max_retries=3, timeout=600)
    jobs, meta = [], {}
    for prepared in sorted((args.root / "prepared").iterdir()):
        key = prepared.name
        flow_run, script_run = args.root / "runs" / f"{key}__transcript__r1", args.root / "runs" / f"{key}__smolagents__r1"
        if not (flow_run / "records.json").exists() or not (script_run / "records.json").exists():
            continue
        texts = {p["turn_id"]: request_text(p["prompt"]) for p in load(prepared / "prompts.json")}
        gold = {t["turn_id"]: set(t.get("depends_tasks") or []) for t in load(prepared / "gold.json")["turns"]}
        flow_steps, script_steps = steps_of(flow_run), steps_of(script_run)
        flow_answers = {r["turn_id"]: r["answer"] for r in load(flow_run / "records.json")}
        script_answers = {r["turn_id"]: r["answer"] for r in load(script_run / "records.json")}
        meta[key] = {"flow_first": first_inputs(flow_steps, False), "script_first": first_inputs(script_steps, True)}
        for r in range(3, max(texts) + 1):
            if r not in flow_steps or r not in script_steps:
                continue
            earlier_flow = {k: v for k, v in flow_steps.items() if k < r}
            earlier_script = {k: v for k, v in script_steps.items() if k < r}
            flow_rec, script_rec = dataflow_tasks(earlier_flow), script_tasks(earlier_script)
            created_before = {oid for info in flow_rec.values() for oid, _, _, _ in info["tables"]}
            truth = {d for d in gold[r] if 1 < d < r}
            indexes = {
                "texts": render_index("texts", texts, {}, r),
                "answers (dataflow run)": render_index("answers", texts, flow_answers, r),
                "answers (script run)": render_index("answers", texts, script_answers, r),
                "script": render_index("script", texts, script_answers, r, script_rec),
                "dataflow": render_index("dataflow", texts, flow_answers, r, flow_rec),
            }
            for name, index in indexes.items():
                jobs.append({"session": key, "request": r, "index": name, "kind": "tasks", "text": index,
                             "request_text": texts[r], "truth": sorted(truth)})
            jobs.append({"session": key, "request": r, "index": "dataflow", "kind": "tables", "text": indexes["dataflow"],
                         "request_text": texts[r], "truth": sorted(tables_read(flow_steps, r, created_before))})

    def run(job):
        try:
            if job["kind"] == "tasks":
                picked, usage, raw = select_tasks(client, args.model, job["text"], job["request_text"], job["request"])
            else:
                picked, usage, raw = select_tables(client, args.model, job["text"], job["request_text"])
        except Exception as error:  # noqa: BLE001 - a failed call is recorded, not fatal
            return {**job, "picked": None, "error": str(error), "usage": None}
        return {**job, "picked": picked, "usage": usage, "raw": raw[:500], "index_tokens_estimate": len(job["text"]) // 4}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(run, jobs))
    for result in results:
        result.pop("text", None)
    args.out.write_text(json.dumps({"meta": meta, "results": results}, indent=1))
    report(results, meta)


def report(results, meta):
    print(f"{len(results)} selections, {sum(1 for r in results if r['picked'] is None)} failed\n")
    rows = {}
    for r in results:
        if r["picked"] is None:
            continue
        key = (r["kind"], r["index"])
        row = rows.setdefault(key, {"n": 0, "found": 0, "needed": 0, "picked": 0, "right": 0, "covered": 0,
                                    "missed": 0, "extra": 0, "kept": [], "cost": 0.0})
        truth = set(r["truth"])
        picked = {p for p in r["picked"] if p != 1} if r["kind"] == "tasks" else set(r["picked"])
        row["n"] += 1
        row["needed"] += len(truth); row["found"] += len(truth & picked)
        row["picked"] += len(picked); row["right"] += len(truth & picked)
        row["covered"] += truth <= picked
        row["missed"] += len(truth - picked); row["extra"] += len(picked - truth)
        u = r["usage"]
        row["cost"] += (u["input_tokens"] - u["cached_tokens"]) * PRICE["input"] + u["cached_tokens"] * PRICE["cached"] + \
            u["output_tokens"] * PRICE["output"]
        if r["kind"] == "tasks":
            first = meta[r["session"]]["flow_first" if "dataflow" in r["index"] else "script_first"]
            added = {k: first[k + 1] - first[k] for k in first if k + 1 in first}
            history = sum(added.get(k, 0) for k in range(1, r["request"]))
            kept = sum(added.get(k, 0) for k in ({1} | picked) if k < r["request"])
            if history > 0:
                row["kept"].append(kept / history)
    print(f"{'selection':10s} {'index':24s} {'requests':>8s} {'dependencies found':>18s} {'picks right':>11s} {'all found':>9s} "
          f"{'missed/req':>10s} {'extra/req':>9s} {'history kept':>12s} {'$ selector':>10s}")
    for (kind, index), row in rows.items():
        kept = f"{statistics.mean(row['kept']):.0%}" if row["kept"] else "–"
        print(f"{kind:10s} {index:24s} {row['n']:8d} {row['found'] / max(row['needed'], 1):18.0%} "
              f"{row['right'] / max(row['picked'], 1):11.0%} {row['covered'] / row['n']:9.0%} {row['missed'] / row['n']:10.2f} "
              f"{row['extra'] / row['n']:9.2f} {kept:>12s} {row['cost']:10.3f}")


if __name__ == "__main__":
    main()
