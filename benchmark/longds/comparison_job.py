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
"""Execute and judge one frozen comparison job, keeping the original artifacts."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from state_comparison import HERE, ROOT, cost_of, port, save, verify_sources, verify_inputs


def executor_command(manifest, workspace, number):
    data_dir = Path(manifest["data_dir"])
    command = [str(ROOT / ".venv/bin/python"), str(HERE / "dsgym_executor.py"),
               "--port", str(number), "--data-root", str((ROOT / data_dir).resolve()),
               "--workspace", str(workspace), "--timeout", "240"]
    if not data_dir.is_absolute():
        command += ["--data-relative", str(data_dir)]
    return command


def script_job(protocol, job, prepared, output):
    import requests
    manifest = json.loads((prepared / "manifest.json").read_text())
    workspace = output / "kernel"
    workspace.mkdir()
    number = port()
    manager_log = (output / "executor.log").open("x")
    manager = subprocess.Popen(executor_command(manifest, workspace, number),
        stdout=manager_log, stderr=subprocess.STDOUT)
    command = [str(HERE / ".dsgym-venv/bin/python"), str(HERE / "dsgym_agent.py"),
        "--manifest", str(prepared / "manifest.json"), "--gold", str(prepared / "gold.json"),
        "--model", protocol["model"], "--out", str(output / "agent"),
        "--executor-url", f"http://localhost:{number}", "--api-base", protocol["api_base"],
        "--prompts-file", str(prepared / "prompts.json"), "--matched-limits", "--wire-trace"]
    if job.get("turn_limit"):
        command += ["--turn-limit", str(job["turn_limit"])]
    if protocol["context_budget"]:
        command += ["--context-budget", str(protocol["context_budget"]), "--compaction", "inventory"]
    if protocol.get("script_kernel_notice"):
        command.append("--kernel-notice")
    try:
        for _ in range(60):
            if manager.poll() is not None:
                raise RuntimeError("Kernel manager exited during setup")
            try:
                if requests.get(f"http://localhost:{number}/health", timeout=1).ok:
                    break
            except requests.RequestException:
                pass
            time.sleep(.2)
        else:
            raise RuntimeError("Kernel manager did not become healthy")
        code = subprocess.call(command)
        # Upstream checkpoints every completed turn even if a later turn fails.
        trajectory = output / "agent/traj.json"
        if trajectory.exists():
            records = json.loads(trajectory.read_text()).get("solutions", [])
            stats = {a["turn_id"]: a["stats"] for a in json.loads((output / "agent/answers.json").read_text())}
            for row in records:
                row["stats"] = stats.get(row["turn_id"], {})
            gold = {t["turn_id"]: t for t in json.loads((prepared / "gold.json").read_text())["turns"]}
            for row in records:
                g = gold[row["turn_id"]]
                row.update({k: g.get(k) for k in ["state_type", "depends_tasks", "depends_span"]})
            save(output / "results_with_ground_truth.json", records)
        return code
    finally:
        manager.terminate()
        try:
            manager.wait(timeout=15)
        except subprocess.TimeoutExpired:
            manager.kill()
            manager.wait()
        manager_log.close()


def reprice(output):
    file = output / "results_with_ground_truth.json"
    if not file.exists():
        return []
    rows = json.loads(file.read_text())
    for row in rows:
        stats = row.get("stats") or {}
        if "cost_usd" in stats:
            stats["original_cost_usd"] = stats["cost_usd"]
        stats["cost_usd"] = cost_of(stats)
        row["stats"] = stats
    save(file, rows)
    return rows


def judge(protocol, prepared, output, rows):
    from concurrent.futures import ThreadPoolExecutor
    from openai import OpenAI
    from judge_longds import judge_one, load_judge_prompt
    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=os.environ["OPENROUTER_API_KEY"], max_retries=0)
    prompt = load_judge_prompt()
    # Identical answer/question/reference triples share a judgment across arms,
    # preventing judge inconsistency from manufacturing an accuracy difference.
    cache = output.parents[3] / "judge-cache"
    cache.mkdir(parents=True, exist_ok=True)

    def one(row):
        identity = json.dumps([protocol["judge"], hashlib.sha256(prompt.encode()).hexdigest(),
                               row["context"], row["question"], row["ground_truth"], row["solution"]], sort_keys=True)
        key = hashlib.sha256(identity.encode()).hexdigest()
        target = cache / (key + ".json")
        lock = cache / (key + ".lock")
        # Different session jobs may finish together; the lock elects one caller.
        while True:
            if target.exists():
                verdict = json.loads(target.read_text())
                return {**row, "judge": {**verdict, "cache_reused": True}}
            try:
                fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                break
            except FileExistsError:
                try:
                    stale = time.time()-lock.stat().st_mtime > 600
                except FileNotFoundError:
                    continue
                if stale:
                    raise RuntimeError("Stale judge lock; preserve it for recovery")
                time.sleep(.2)
        try:
            verdict = judge_one(client, protocol["judge"], prompt, row, retries=3, max_tokens=8000)
            save(target, verdict)
            return {**row, "judge": verdict}
        finally:
            lock.unlink(missing_ok=True)

    with ThreadPoolExecutor(max_workers=3) as pool:
        judged = list(pool.map(one, rows))
    save(output / "results_eval.json", judged)
    return judged


def main():
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env", override=False)
    ap = argparse.ArgumentParser()
    ap.add_argument("--protocol", type=Path, required=True)
    ap.add_argument("--prepared", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    protocol = json.loads(args.protocol.read_text())
    verify_sources(protocol)
    job = json.loads((args.output / "job.json").read_text())
    verify_inputs(protocol, job["task"], args.prepared)
    if job["arm"] == "dsgym":
        code = script_job(protocol, job, args.prepared, args.output)
    else:
        env = dict(os.environ)
        env.update({"TEXERA_DASHBOARD_SERVICE_ENDPOINT": os.environ.get("TEXERA_DASHBOARD_SERVICE_ENDPOINT", "http://localhost:38080"),
                    "TEXERA_COMPUTING_UNIT_ENDPOINT": os.environ.get("TEXERA_COMPUTING_UNIT_ENDPOINT", "http://localhost:38888"),
                    "WORKFLOW_EXECUTION_SERVICE_ENDPOINT": os.environ.get("WORKFLOW_EXECUTION_SERVICE_ENDPOINT", "http://localhost:38086")})
        code = subprocess.call(["bun", "run", str(ROOT / "agent-service/benchmark/multiturn/run-comparison-session.ts"),
            str(args.prepared), str(args.output), str(args.protocol)], env=env)
    rows = reprice(args.output)
    if rows:
        if job.get("benchmark") == "krama":
            from scope_verification import score_krama
            judged = score_krama(protocol, args.prepared, args.output, rows)
        else:
            judged = judge(protocol, args.prepared, args.output, rows)
        save(args.output / "judgment-summary.json", {"observed": len(rows), "expected": job["turns_total"],
             "judged": sum(r["judge"].get("score") is not None for r in judged),
             "correct": sum(r["judge"].get("score") == 1 for r in judged)})
    raise SystemExit(code)


if __name__ == "__main__":
    main()
