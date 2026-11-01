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
"""Compare two real-model smokes (smoke.sh), attempt by attempt.

Model output varies between runs, so this reports what should hold anyway: every attempt completes, scores and costs
stay in the same range, and Flow Evidence attempts still carry runtime-stats lines.

    python3 -I compare_smoke.py <runs dir> <base prefix> <smoke prefix>
"""
import json
from pathlib import Path
import sys

ARMS = ("evidence_data1_flow0_opt_strict", "evidence_data1_flow0_opt", "evidence_data1_flow0", "evidence_full_flow0",
        "evidence_data1_flow1", "evidence_full_flow1")


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def arm_of(sut):
    return next((arm for arm in ARMS if f"_{arm}_Rep" in sut), "smolagents")


def flow_lines(attempt):
    """Whether the attempt's model requests carry a runtime-stats line (Flow Evidence)."""
    wire = attempt / "wire"
    return wire.is_dir() and any("runtime stats:" in request.read_text() for request in wire.glob("*-request.json"))


def attempts(run):
    out = {}
    for attempt in sorted(path for path in run.glob("system_scratch/*/*") if path.is_dir()):
        evaluation = load(attempt / "evaluation.json") or {}
        stats = load(attempt / "stats.json") or {}
        out[(arm_of(attempt.parent.name), attempt.name)] = {
            "done": (attempt / "evaluation.json").exists(), "success": evaluation.get("success"),
            "cost": stats.get("cost_usd"), "steps": stats.get("num_steps"), "flow": flow_lines(attempt)}
    return out


def money(value):
    return "-" if value is None else f"${value:.4f}"


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    runs, base, smoke = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    total = {base: 0.0, smoke: 0.0}
    for name in ("kb", "kbflow", "pb", "kbsmol", "pbsmol"):
        a, b = attempts(runs / f"{base}-{name}"), attempts(runs / f"{smoke}-{name}")
        keys = sorted(set(a) | set(b))
        done = sum(1 for key in keys if b.get(key, {}).get("done"))
        print(f"== {smoke}-{name} vs {base}-{name}: {done} of {len(keys)} attempts complete")
        for key in keys:
            x, y = a.get(key, {}), b.get(key, {})
            flow = f"  flow lines {int(bool(x.get('flow')))}->{int(bool(y.get('flow')))}" if "flow1" in key[0] else ""
            print(f"   {key[0]:32s} {key[1]:20s} success {x.get('success')}->{y.get('success')}  "
                  f"cost {money(x.get('cost'))}->{money(y.get('cost'))}  steps {x.get('steps')}->{y.get('steps')}{flow}")
        total[base] += sum(v["cost"] or 0 for v in a.values())
        total[smoke] += sum(v["cost"] or 0 for v in b.values())
        passes = [sum(1 for v in side.values() if v["success"] == 1) for side in (a, b)]
        costs = [sum(v["cost"] or 0 for v in side.values()) for side in (a, b)]
        flows = (f"; attempts with flow lines {sum(v['flow'] for v in a.values())} -> {sum(v['flow'] for v in b.values())}"
                 if name == "kbflow" else "")
        print(f"   success {passes[0]} -> {passes[1]}; cost {money(costs[0])} -> {money(costs[1])}{flows}")
    for prefix in (base, smoke):
        for run in (load(runs / f"{prefix}-longds" / "summary.json") or {}).get("runs", []):
            print(f"== {prefix}-longds {run['arm']:20s} answered {run['answered']}/{run['turns']} "
                  f"correct {run['correct']} cost ${run['cost_usd']:.4f} calls {run['llm_calls']}")
            total[prefix] += run["cost_usd"]
    print(f"total cost: {base} {money(total[base])}, {smoke} {money(total[smoke])}")


if __name__ == "__main__":
    main()
