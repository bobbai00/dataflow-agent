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
"""Outcome-independent calibration and full-request token-budget accounting.

The native input-budget.ts module uses the same UTF-16 compact-JSON estimator.
Calibrate on completed development requests; freeze one scale for every arm.
Provider usage, unknown calls and violations remain separate in the audit.
"""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path

ESTIMATOR = "utf16_compact_json_messages_tools_div3.3_v1"


def estimate_full_input(request, scale=1):
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("Scale must be positive and finite")
    text = json.dumps({"messages": request.get("messages") or [], "tools": request.get("tools") or []},
                      ensure_ascii=False, separators=(",", ":"))
    units = len(text.encode("utf-16-le", errors="surrogatepass")) // 2
    return math.ceil(math.ceil(units / 3.3) * scale)


def load_json(path):
    body = Path(path).read_bytes()
    return json.loads(gzip.decompress(body) if str(path).endswith(".gz") else body)


def wire_rows(output, phases, scale=1):
    output = Path(output)
    rows = []
    for phase in phases:
        protocol = load_json(output / phase / "manifest.json")
        for job in protocol["jobs"]:
            folder = output / phase / "runs" / f"{job['arm']}-r{job['rep']}" / job["task"].replace("/", "__")
            if job["arm"] == "dsgym":
                wire = folder / "agent/wire"
            else:
                resources = folder / "resources.json"
                if not resources.exists():
                    continue
                wire = Path(protocol.get("wire_root", output / "wire")) / load_json(resources)["agent_id"]
            for path in sorted(wire.glob("*-request.json*")):
                request = load_json(path)
                response_path = path.with_name(path.name.replace("-request.", "-response."))
                usage = load_json(response_path).get("usage") if response_path.exists() else None
                actual = (usage or {}).get("prompt_tokens")
                rows.append({"phase": phase, "arm": job["arm"], "task": job["task"], "rep": job["rep"],
                             "request": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                             "estimate": estimate_full_input(request, scale), "actual": actual})
    return rows


def calibrate(rows, margin=.05):
    if not rows or any(r.get("actual") is None or r["estimate"] <= 0 for r in rows):
        raise ValueError("Calibration requires nonempty, fully observed provider usage")
    if not math.isfinite(margin) or margin < 0:
        raise ValueError("Margin must be nonnegative")
    maximum = max(r["actual"] / r["estimate"] for r in rows)
    return {"estimator": ESTIMATOR, "observed_calls": len(rows), "margin": margin,
            "maximum_ratio": maximum, "scale": maximum * (1 + margin),
            "policy": "One fixed pooled scale from development requests, no answer scores used"}


def audit_requests(rows, budget):
    actual = [r["actual"] for r in rows if r.get("actual") is not None]
    return {"calls": len(rows), "unknown_usage": len(rows) - len(actual), "budget_tokens": budget,
            "estimated_over_budget": sum(r["estimate"] > budget for r in rows) if budget else None,
            "actual_over_budget": sum(value > budget for value in actual) if budget else None,
            "maximum_actual": max(actual) if actual else None,
            "maximum_estimated": max((r["estimate"] for r in rows), default=None)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--phases", nargs="+", default=["controlled", "hidden-history"])
    parser.add_argument("--calibrate", action="store_true")
    parser.add_argument("--scale", type=float, default=1)
    parser.add_argument("--budget", type=int, default=64000)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    rows = wire_rows(args.output, args.phases, args.scale)
    result = {"created_at": datetime.now(timezone.utc).isoformat(), "estimator": ESTIMATOR,
              "phases": args.phases, "scale": args.scale, "summary": audit_requests(rows, args.budget),
              "by_arm": {arm: audit_requests([r for r in rows if r["arm"] == arm], args.budget)
                         for arm in sorted({r["arm"] for r in rows})}, "rows": rows}
    if args.calibrate:
        if args.scale != 1:
            raise ValueError("Calibrate from unscaled estimates")
        result["calibration"] = calibrate(rows)
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    with args.destination.open("x") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({key: value for key, value in result.items() if key != "rows"}, indent=2))


if __name__ == "__main__":
    main()
