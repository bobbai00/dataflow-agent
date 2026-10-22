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

"""Check the traces an end-to-end run left behind, straight from the database.

Every run finished and is fully timed (each step's model call and code execution
nested inside the step, the steps inside the run), every record belongs to the
user who owns its run, figure files sit in their owner's folder, and the runs
overlapped in time. Prints a per-user summary; exits 1 on any problem.

    python tests/e2e/check_traces.py DATA_DIR USERNAME_PREFIX [RUNS_PER_USER]
"""

import sqlite3
import sys
from pathlib import Path

EPSILON = 0.01


def check(data_dir: Path, prefix: str, runs_per_user: int) -> int:
    db = sqlite3.connect(f"file:{data_dir / 'traces.db'}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    users = db.execute("SELECT id, username FROM users WHERE username LIKE ? ORDER BY id", (prefix + "%",)).fetchall()
    problems, table, intervals = [], [], []

    def expect(condition, message):
        if not condition:
            problems.append(message)

    expect(users, f"no users named {prefix}*")
    for user in users:
        runs = db.execute("SELECT * FROM run_summary WHERE user_id = ? ORDER BY started_at", (user["id"],)).fetchall()
        expect(len(runs) == runs_per_user, f"{user['username']}: {len(runs)} runs")
        totals = dict(steps=0, seconds=0.0, llm=0.0, python=0.0, tokens_in=0, tokens_out=0, ttft=[], figures=0)
        for run in runs:
            name = f"{user['username']} turn {run['turn']}"
            intervals.append((run["started_at"], run["ended_at"]))
            if run["kind"] == "script":  # the user's own code: one execution, no model
                expect(run["status"] == "ok", f"{name}: script status {run['status']}")
                execs = db.execute("SELECT COUNT(*) FROM python_execs WHERE run_id = ?", (run["id"],)).fetchone()[0]
                expect(execs == 1 and run["steps"] == 0 and run["llm_calls"] == 0, f"{name}: script run's records")
                continue
            expect(run["status"] == "ok" and run["final_answer"], f"{name}: status {run['status']}")
            steps = db.execute("SELECT * FROM step_timing WHERE run_id = ? ORDER BY step_number",
                               (run["id"],)).fetchall()
            expect(steps, f"{name}: no steps")
            for step in steps:
                label = f"{name} step {step['step_number']}"
                expect(run["started_at"] - EPSILON <= step["started_at"] <= step["ended_at"]
                       <= run["ended_at"] + EPSILON, f"{label}: outside its run")
                calls = db.execute("SELECT * FROM llm_calls WHERE run_id = ? AND step_number = ?",
                                   (run["id"], step["step_number"])).fetchall()
                execs = db.execute("SELECT * FROM python_execs WHERE run_id = ? AND step_number = ?",
                                   (run["id"], step["step_number"])).fetchall()
                expect(len(calls) == 1, f"{label}: {len(calls)} model calls")
                for call in calls:
                    expect(step["started_at"] - EPSILON <= call["started_at"] <= call["ended_at"]
                           <= step["ended_at"] + EPSILON, f"{label}: model call outside the step")
                    expect(call["first_token_at"] and call["started_at"] <= call["first_token_at"] <= call["ended_at"],
                           f"{label}: no first-token time")
                    expect((call["input_tokens"] or 0) > 0 and (call["output_tokens"] or 0) > 0, f"{label}: no tokens")
                    expect(call["input_messages"], f"{label}: no context")
                    if call["first_token_at"]:
                        totals["ttft"].append(call["first_token_at"] - call["started_at"])
                for execution in execs:
                    expect(step["started_at"] - EPSILON <= execution["started_at"] <= execution["ended_at"]
                           <= step["ended_at"] + EPSILON, f"{label}: execution outside the step")
                    expect(execution["worker_seconds"] is None
                           or execution["worker_seconds"] <= execution["ended_at"] - execution["started_at"],
                           f"{label}: worker time longer than the round trip")
                expect(step["seconds"] + EPSILON >= step["llm_seconds"] + step["python_seconds"],
                       f"{label}: parts longer than the step")
            totals["steps"] += len(steps)
            totals["seconds"] += run["seconds"]
            totals["llm"] += run["llm_seconds"]
            totals["python"] += run["python_seconds"]
            totals["tokens_in"] += run["input_tokens"]
            totals["tokens_out"] += run["output_tokens"]
        for artifact in db.execute("SELECT * FROM artifacts WHERE user_id = ? AND kind = 'figure'", (user["id"],)):
            totals["figures"] += 1
            path = Path(artifact["path"])
            expect(path.is_file() and path.is_relative_to(data_dir / "users" / str(user["id"])),
                   f"{user['username']}: figure {path} outside the user's folder")
        ttft = sorted(totals["ttft"])
        table.append([user["username"], len(runs), totals["steps"], totals["seconds"], totals["llm"], totals["python"],
                      totals["seconds"] - totals["llm"] - totals["python"], ttft[len(ttft) // 2] if ttft else 0,
                      totals["tokens_in"], totals["tokens_out"], totals["figures"]])

    for kind in ("steps", "llm_calls", "python_execs", "artifacts"):
        leaked = db.execute(f"SELECT COUNT(*) FROM {kind} x JOIN runs r ON r.id = x.run_id "
                            "WHERE x.user_id != r.user_id")
        expect(leaked.fetchone()[0] == 0, f"{kind}: rows owned by someone other than their run's user")

    edges = sorted([(start, 1) for start, _ in intervals] + [(end, -1) for _, end in intervals if end])
    running = peak = 0
    for _, change in edges:
        running += change
        peak = max(peak, running)

    header = ["user", "runs", "steps", "run s", "LLM s", "Python s", "other s", "median TTFT s", "in tok", "out tok",
              "charts"]
    print(" | ".join(header))
    for row in table:
        print(" | ".join(f"{v:.1f}" if isinstance(v, float) else str(v) for v in row))
    print(f"\n{len(users)} users, {len(intervals)} runs; at most {peak} runs in progress at once")
    for problem in problems:
        print("PROBLEM:", problem)
    print("OK" if not problems else f"{len(problems)} problems")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(check(Path(sys.argv[1]).resolve(), sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2))
