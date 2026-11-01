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
"""Compare a gate run with its baseline smoke, attempt by attempt: every model request, prompt.txt, settings.json,
answer.json, evaluation.json (without its clocks), PrepBench outputs/ and the billed cost.

Attempts are matched by arm and task: the arm comes from the SUT folder name (..._<arm>_Rep1), Script ReAct's arm is
"smolagents". Settings keys in --allow are reported but do not fail the comparison (settings the agent removed, or
values that fell back to an inert default once the runner stopped sending them).

    python3 -I compare.py [--wire BASE_WIRE GATE_WIRE] BASE_RUN GATE_RUN [...] [--allow key ...]

A LongDS run root (one folder per arm) is compared by its records, settings and, for the dataflow arms, every model
request, read from the stack wire roots given by --wire.
"""
import argparse
import json
import re
import sys
from pathlib import Path

CLOCKS = re.compile(r"(runtime|seconds|_at|timestamp|time)$")


def attempts(run):
    manifest = json.loads((run / "manifest.json").read_text())
    arms = sorted(manifest.get("arms") or {}, key=len, reverse=True)
    out = {}
    for attempt in run.glob("system_scratch/*/*"):
        if not attempt.is_dir():
            continue
        arm = next((a for a in arms if f"_{a}_Rep" in attempt.parent.name), "smolagents")
        out[(arm, attempt.name)] = attempt
    return out


def requests(attempt):
    if (attempt / "wire").is_dir():
        return [json.loads((attempt / "wire" / f"{m.name[:-len('-meta.json')]}-request.json").read_text())
                for m in sorted((attempt / "wire").glob("*-meta.json")) if json.loads(m.read_text()).get("status") == 200]
    trace = attempt / "model-request-trace.jsonl"
    if trace.exists():
        return [line["request"] for line in map(json.loads, trace.read_text().splitlines()) if line.get("phase") == "request"]
    return []


def load(path):
    return json.loads(path.read_text()) if path.exists() else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tracker", type=Path, default=Path(__file__).resolve().parents[2] / "tracker",
                        help="benchmark/tracker, for compare_replays.Normalizer")
    parser.add_argument("--allow", nargs="*", default=[])
    parser.add_argument("--wire", nargs=2, type=Path, metavar=("BASE_WIRE", "GATE_WIRE"),
                        help="the stack wire roots of a LongDS baseline and gate run (dataflow sessions keep their calls there)")
    parser.add_argument("runs", nargs="+", type=Path)
    args = parser.parse_args()
    sys.path.insert(0, str(args.tracker))
    from compare_replays import Normalizer, differences, excerpt

    def same(x, y):
        return not list(differences(Normalizer().value(x), Normalizer().value(y)))

    def wire_requests(root, arm):
        agent = (load(arm / "resource.json") or {}).get("agentId")
        if not (root and agent and (root / agent).is_dir()):
            return []
        return [json.loads((root / agent / f"{m.name[:-len('-meta.json')]}-request.json").read_text())
                for m in sorted((root / agent).glob("*-meta.json")) if json.loads(m.read_text()).get("status") == 200]

    failures = checked = 0
    for base_run, gate_run in zip(args.runs[::2], args.runs[1::2]):
        if not (base_run / "manifest.json").exists():  # a LongDS run root: one folder per arm
            for arm in sorted(p.parent.name for p in base_run.glob("*/protocol.json")):
                checked += 1
                b, g = base_run / arm, gate_run / arm
                problems, notes = [], []
                rb, rg = load(b / "records.json") or [], load(g / "records.json") or []
                if len(rb) != len(rg):
                    problems.append(f"{len(rb)} vs {len(rg)} requests answered")
                # A Script ReAct session keeps only input/output token counts per step, so its replayed usage lacks the
                # cache split its recorded cost used: compare cost only for the dataflow arms.
                fields = ["answer", "completed", "end", "llm_calls", "dataflow_calls", "error"]
                if (load(b / "resource.json") or {}).get("agentId"):
                    fields.append("cost_usd")
                for x, y in zip(rb, rg):
                    for field in fields:
                        if x.get(field) != y.get(field):
                            problems.append(f"turn {x.get('turn_id')} {field}: {str(x.get(field))[:80]!r} -> {str(y.get(field))[:80]!r}")
                qb = wire_requests(args.wire[0] if args.wire else None, b)
                qg = wire_requests(args.wire[1] if args.wire else None, g)
                if qb and len(qb) != len(qg):
                    problems.append(f"{len(qb)} vs {len(qg)} model calls")
                for i, (x, y) in enumerate(zip(qb, qg)):
                    found = list(differences(Normalizer().value(x), Normalizer().value(y)))
                    if found:
                        at, u, v = found[0]
                        eu, ev = excerpt(u, v)
                        problems.append(f"request {i + 1} differs at {at} ({len(found)} places)\n        A: {eu}\n        B: {ev}")
                        break
                sb, sg = load(b / "settings.json") or {}, load(g / "settings.json") or {}
                for k in sorted(set(sb) | set(sg)):
                    if sb.get(k) != sg.get(k):
                        (notes if k in args.allow else problems).append(f"settings.{k}: {sb.get(k)!r} -> {sg.get(k)!r}")
                failures += bool(problems)
                print(f"{'FAIL' if problems else 'ok  '} longds {arm}" + (f" ({len(qb)} requests compared)" if qb else ""))
                for line in problems + [f"(allowed) {n}" for n in notes]:
                    print("     " + line)
            continue
        base, gate = attempts(base_run), attempts(gate_run)
        for key in sorted(set(base) | set(gate)):
            checked += 1
            problems, notes = [], []
            if key not in gate or key not in base:
                problems.append("only in " + ("baseline" if key in base else "gate"))
            else:
                b, g = base[key], gate[key]
                rb, rg = requests(b), requests(g)
                if len(rb) != len(rg):
                    problems.append(f"{len(rb)} vs {len(rg)} model calls")
                for i, (x, y) in enumerate(zip(rb, rg)):
                    found = list(differences(Normalizer().value(x), Normalizer().value(y)))
                    if found:
                        at, u, v = found[0]
                        eu, ev = excerpt(u, v)
                        problems.append(f"request {i + 1} differs at {at} ({len(found)} places)\n        A: {eu}\n        B: {ev}")
                        break
                for name in ["prompt.txt", "response.txt"]:
                    if (b / name).exists() and (b / name).read_text() != ((g / name).read_text() if (g / name).exists() else None):
                        problems.append(f"{name} differs")
                sb, sg = load(b / "settings.json") or {}, load(g / "settings.json") or {}
                for k in sorted(set(sb) | set(sg)):
                    if sb.get(k) != sg.get(k):
                        (notes if k in args.allow else problems).append(f"settings.{k}: {sb.get(k)!r} -> {sg.get(k)!r}")
                for name in ["answer.json", "evaluation.json"]:
                    x, y = load(b / name), load(g / name)
                    if isinstance(x, dict) and isinstance(y, dict):
                        x = {k: v for k, v in x.items() if not CLOCKS.search(k)}
                        y = {k: v for k, v in y.items() if not CLOCKS.search(k)}
                    if not same(x, y):
                        problems.append(f"{name} differs")
                for out in sorted((b / "outputs").glob("*")) if (b / "outputs").is_dir() else []:
                    if not (g / "outputs" / out.name).exists() or out.read_bytes() != (g / "outputs" / out.name).read_bytes():
                        problems.append(f"outputs/{out.name} differs")
                cb, cg = (load(b / "stats.json") or {}).get("cost_usd"), (load(g / "stats.json") or {}).get("cost_usd")
                if cb is not None and cg is not None and abs(cb - cg) > 1e-9:
                    problems.append(f"cost {cb} -> {cg}")
            failures += bool(problems)
            print(f"{'FAIL' if problems else 'ok  '} {key[0]} {key[1]}")
            for line in problems + [f"(allowed) {n}" for n in notes]:
                print("     " + line)
    print(f"attempts equal: {checked - failures} of {checked}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
