#!/usr/bin/env python3
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

"""Paired analysis of a gold-prefix campaign: the same turns across arms.

Reads every judged job under `<root>/runs/<arm>/<session>/tNN/`, pairs turns
across arms, and reports: accuracy on the turns all arms completed, by label and
by session; cost, calls and output per turn; how each dataflow arm used the
loaded state (seeded tables read before use, wired in, rebuilt from files); and,
for the ledger arm, how often provenance cards and execution notes appeared and
whether the turn was right when they did. Prints a markdown summary and writes
`analysis.json`.
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from gold_prefix_campaign import RATES, cost_of


def load_jobs(root: Path) -> dict[str, dict[tuple[str, int], dict]]:
    arms: dict[str, dict[tuple[str, int], dict]] = defaultdict(dict)
    for path in sorted(root.glob("runs/*/*/t*/results_eval.json")):
        arm, session = path.parents[2].name, path.parents[1].name
        record = json.loads(path.read_text())[0]
        folder = path.parent
        extra: dict = {}
        if (folder / "state-use.json").exists():
            extra["state_use"] = json.loads((folder / "state-use.json").read_text())
        if (folder / "react_steps.json").exists():
            steps = json.loads((folder / "react_steps.json").read_text())
            provenance = notes = inspects = retrieves_before_edit = 0
            first_edit_seen = False
            for step in steps:
                for call in step.get("toolCalls") or []:
                    for action in (call.get("input") or {}).get("actions", []):
                        if action.get("type") == "retrieve" and not first_edit_seen:
                            retrieves_before_edit += 1
                        if action.get("type") == "edit":
                            first_edit_seen = True
                        if action.get("type") == "inspect":
                            inspects += 1
                for result in step.get("toolResults") or []:
                    output = result.get("output")
                    if not isinstance(output, dict) or output.get("kind") != "dataflow-actions":
                        continue
                    for item in output.get("actions", []):
                        out = item.get("output")
                        if not isinstance(out, dict):
                            continue
                        if item["action"]["type"] == "edit" and out.get("provenance"):
                            provenance += 1
                        if item["action"]["type"] == "execute":
                            notes += sum(len(op.get("checks") or []) for op in out.get("operators", []))
            extra["trace"] = {
                "provenance_receipts": provenance,
                "notes": notes,
                "inspects": inspects,
                "retrieves_before_first_edit": retrieves_before_edit,
                "steps": len(steps),
            }
        if (folder / "anomalies.json").exists():
            extra["anomalies"] = [a["kind"] for a in json.loads((folder / "anomalies.json").read_text())]
        arms[arm][(session, record["turn_id"])] = {**record, **extra}
    return arms


def score(record: dict):
    return (record.get("judge") or {}).get("score")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", required=True)
    args = ap.parse_args()
    root = Path(args.root)
    arms = load_jobs(root)
    names = sorted(arms)
    common = set.intersection(*(set(a) for a in arms.values())) if arms else set()
    judged = {k for k in common if all(score(arms[a][k]) is not None for a in names)}
    print(f"arms: {names}")
    print(f"turns judged in every arm: {len(judged)} (per arm: {', '.join(f'{a}={len(arms[a])}' for a in names)})\n")

    def table(keys, title):
        print(f"### {title} ({len(keys)} turns)\n")
        print("| arm | correct | acc | $/turn | calls/turn | out tok/turn | sec/turn |")
        print("|---|---:|---:|---:|---:|---:|---:|")
        for a in names:
            rows = [arms[a][k] for k in keys]
            if not rows:
                continue
            correct = sum(1 for r in rows if score(r) == 1)
            cost = sum(cost_of(r) or 0 for r in rows) / len(rows)
            calls = sum((r.get("stats") or {}).get("llm_calls") or r.get("steps") or 0 for r in rows) / len(rows)
            out = sum((r.get("stats") or {}).get("output_tokens") or 0 for r in rows) / len(rows)
            sec = sum((r.get("stats") or {}).get("elapsed_seconds") or 0 for r in rows) / len(rows)
            print(f"| {a} | {correct}/{len(rows)} | {correct / len(rows):.1%} | {cost:.4f} | {calls:.2f} | {out:.0f} | {sec:.0f} |")
        print()

    table(sorted(judged), "Paired turns, all sessions")

    def decomposition(keys, title):
        print(f"### Cost decomposition per turn ({title}, {len(keys)} turns)\n")
        print("| arm | fresh input $ | cached input $ | output $ | total $ | prompt tok (first call) | cached share |")
        print("|---|---:|---:|---:|---:|---:|---:|")
        for a in names:
            rows = [arms[a][k] for k in keys]
            if not rows:
                continue
            rates = RATES.get(rows[0].get("model") or "", RATES["gpt-5.6-terra"])
            fresh = cached = output = prompt = 0.0
            cached_tokens = input_tokens = 0
            for r in rows:
                st = r.get("stats") or {}
                i, c, w, o = (st.get("input_tokens") or 0), (st.get("cached_tokens") or 0), (st.get("cache_write_tokens") or 0), (st.get("output_tokens") or 0)
                fresh += max(0, i - c - w) * rates["input"] + w * rates["cache_creation"]
                cached += c * rates["cache_read"]
                output += o * rates["output"]
                input_tokens += i
                cached_tokens += c
            n = len(rows)
            print(f"| {a} | {fresh / n:.4f} | {cached / n:.4f} | {output / n:.4f} | {(fresh + cached + output) / n:.4f} | — | {cached_tokens / max(1, input_tokens):.0%} |")
        print()

    decomposition(sorted(judged), "paired turns")
    sessions = sorted({k[0] for k in judged})
    for s in sessions:
        table(sorted(k for k in judged if k[0] == s), s)
    labels = sorted({l for k in judged for l in (arms[names[0]][k].get("state_type") or [])})
    print("### By label (paired turns; a turn counts under each of its labels)\n")
    print("| label | n | " + " | ".join(names) + " |")
    print("|---|---:|" + "---:|" * len(names))
    for label in labels:
        keys = [k for k in judged if label in (arms[names[0]][k].get("state_type") or [])]
        print(f"| {label} | {len(keys)} | " + " | ".join(f"{sum(1 for k in keys if score(arms[a][k]) == 1)}" for a in names) + " |")
    print()

    print("### Paired turns where the arms disagree\n")
    for k in sorted(judged):
        marks = {a: score(arms[a][k]) for a in names}
        if len(set(marks.values())) > 1:
            print(f"- {k[0][:40]} t{k[1]:02d} {arms[names[0]][k].get('state_type')}: " + ", ".join(f"{a.replace('gpt-5.6-terra-', '')}={v}" for a, v in marks.items()))
    print()
    # Agreement across arms on the paired turns.
    if len(names) >= 2:
        print("### Agreement on paired turns\n")
        for i, a in enumerate(names):
            for b in names[i + 1 :]:
                both = sum(1 for k in judged if score(arms[a][k]) == 1 and score(arms[b][k]) == 1)
                only_a = sum(1 for k in judged if score(arms[a][k]) == 1 and score(arms[b][k]) != 1)
                only_b = sum(1 for k in judged if score(arms[a][k]) != 1 and score(arms[b][k]) == 1)
                neither = len(judged) - both - only_a - only_b
                print(f"- {a} vs {b}: both {both}, only {a} {only_a}, only {b} {only_b}, neither {neither}")
        print()

    # State use in the dataflow arms.
    print("### State use (all judged turns of each arm)\n")
    for a in names:
        rows = [r for r in arms[a].values() if score(r) is not None]
        used = [r for r in rows if "seeded_inputs_used" in (r.get("state_use") or {})]
        if not used:
            continue
        wired = sum(1 for r in used if r["state_use"]["seeded_inputs_used"])
        read_first = sum(1 for r in used if r["state_use"]["seeded_tables_retrieved"])
        rebuilt = sum(1 for r in used if r["state_use"]["new_source_reads"])
        right_wired = sum(1 for r in used if r["state_use"]["seeded_inputs_used"] and score(r) == 1)
        right_not = sum(1 for r in used if not r["state_use"]["seeded_inputs_used"] and score(r) == 1)
        trace = [r["trace"] for r in used if r.get("trace")]
        prov = sum(1 for t in trace if t["provenance_receipts"])
        notes = sum(1 for t in trace if t["notes"])
        right_notes = sum(1 for r in used if r.get("trace", {}).get("notes") and score(r) == 1)
        print(
            f"- {a}: {len(used)} turns; wired a loaded table into new operators in {wired} "
            f"(right {right_wired}/{wired}; without wiring right {right_not}/{len(used) - wired}); "
            f"retrieved a loaded table in {read_first}; read a source file anew in {rebuilt}; "
            f"provenance cards in {prov}; execution notes in {notes} (right {right_notes}/{notes}); "
            f"mean inspects {sum(t['inspects'] for t in trace) / max(1, len(trace)):.2f}"
        )
    script = [r for a in names if a.endswith("dsgym-r1") or "dsgym" in a for r in arms[a].values() if score(r) is not None]
    if script:
        blocks = sum((r.get("state_use") or {}).get("code_blocks", 0) for r in script)
        reads = sum((r.get("state_use") or {}).get("blocks_reading_files", 0) for r in script)
        no_code = sum(1 for r in script if (r.get("state_use") or {}).get("code_blocks", 0) == 0)
        print(f"- script arm: {len(script)} turns; {blocks} code blocks, {reads} of them read a file; {no_code} turns answered without code")
    print()
    anomalies = Counter(kind for a in names for r in arms[a].values() for kind in r.get("anomalies", []))
    if anomalies:
        print("### Anomalies\n", dict(anomalies), "\n")
    (root / "analysis.json").write_text(
        json.dumps(
            {
                "arms": names,
                "paired_turns": sorted(judged),
                "records": {a: {f"{k[0]}#{k[1]}": {"score": score(r), "cost": cost_of(r), "stats": r.get("stats"), "state_use": r.get("state_use"), "trace": r.get("trace")} for k, r in arms[a].items()} for a in names},
            },
            indent=1,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
