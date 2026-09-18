#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Group a real-session campaign's results by LongDS state label.

The strict per-task score is the evaluator's. This only regroups it: a task
labelled Rollback or Counterfactual is where retained state has work to do;
Initial-only tasks are the control. Labels overlap, so a task can count under
several headings; totals per heading are shown so nothing reads as a
percentage of the wrong denominator. Also prints the per-task pass matrix so
one can see which turns separate the arms, and the usage totals per arm.

    python summarize-by-state.py /tmp/texera-maint/dev-run1 --fixtures /tmp/texera-maint/fixtures
"""
import argparse
import collections
import json
from pathlib import Path

LABELS = ("Initial", "Update", "Rollback", "Counterfactual")


def load(run: Path, fixtures: Path):
    manifest = json.loads((run / "manifest.json").read_text())
    rows = manifest["primary"] + manifest["recoveries"]
    arms = manifest["arms"]
    families = manifest["families"]
    checks = {f: json.loads((fixtures / f / "checks.json").read_text()) for f in families}
    per_task = collections.defaultdict(dict)   # (family, task) -> arm -> [passed per trial]
    usage = collections.defaultdict(collections.Counter)
    for row in rows:
        label_dir = run / row["label"]
        for folder in sorted(p for p in label_dir.iterdir() if p.is_dir() and p.name.startswith("t")):
            ev, st = folder / "evaluation.json", folder / "stats.json"
            if not ev.exists():
                continue
            task = int(folder.name[1:])
            passed = bool(json.loads(ev.read_text()).get("passed"))
            per_task[(row["family"], task)].setdefault(row["arm"], []).append(passed)
            if st.exists():
                s = json.loads(st.read_text())
                for key in ("llm_calls", "input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens",
                            "historical_inputs", "direct_returns", "retained_variables", "retained_bytes"):
                    usage[row["arm"]][key] += int(s.get(key) or 0)
                usage[row["arm"]]["cost_micro"] += round((s.get("cost_usd") or 0) * 1e6)
                usage[row["arm"]]["elapsed"] += round(s.get("elapsed_seconds") or 0)
                usage[row["arm"]]["tasks"] += 1
    return manifest, arms, families, checks, per_task, usage


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run", type=Path)
    parser.add_argument("--fixtures", type=Path, required=True)
    args = parser.parse_args()
    manifest, arms, families, checks, per_task, usage = load(args.run, args.fixtures)
    print(f"revision {manifest['revision']}  arms {arms}  families {families}  finished={'finished' in manifest}")

    # By state label (overlapping) and by family.
    for family in families:
        print(f"\n== {family}: pass rate by state label (tasks counted under every label they carry)")
        header = f"{'label':<16}" + "".join(f"{arm:>14}" for arm in arms)
        print(header)
        for label in LABELS + ("(state change)", "(all)"):
            cells = []
            for arm in arms:
                hit = tot = 0
                for (fam, task), by_arm in per_task.items():
                    if fam != family or arm not in by_arm:
                        continue
                    labels = checks[fam][task - 1].get("state_type", [])
                    if label == "(all)":
                        match = True
                    elif label == "(state change)":
                        match = any(l in labels for l in ("Update", "Rollback", "Counterfactual"))
                    else:
                        match = label in labels
                    if not match:
                        continue
                    for p in by_arm[arm]:
                        tot += 1
                        hit += int(p)
                cells.append(f"{hit}/{tot}" if tot else "-")
            print(f"{label:<16}" + "".join(f"{c:>14}" for c in cells))

    # Fresh versus inherited failures. A failed task whose every dependency
    # (LongDS depends_tasks) passed in the same trial failed on its own; one
    # with a failed dependency inherited. This is the benchmark's own cascade
    # taxonomy approximated with our strict score, so it is an association,
    # not a proof of causation for any single task.
    print("\n== fresh vs inherited failures (all families; a failed dependency makes a failure 'inherited')")
    print(f"{'arm':<11}{'failed':>8}{'fresh':>8}{'inherited':>11}{'fresh on state-change turns':>30}{'fresh on Initial-only turns':>30}")
    for arm in arms:
        failed = fresh = inherited = fresh_state = fresh_initial = 0
        for (fam, task), by_arm in per_task.items():
            trials = by_arm.get(arm, [])
            deps = checks[fam][task - 1].get("depends_tasks", [])
            labels = checks[fam][task - 1].get("state_type", [])
            state_change = any(l in labels for l in ("Update", "Rollback", "Counterfactual"))
            for trial_index, passed in enumerate(trials):
                if passed:
                    continue
                failed += 1
                dep_failed = False
                for dep in deps:
                    dep_trials = per_task.get((fam, int(dep)), {}).get(arm, [])
                    if trial_index < len(dep_trials) and not dep_trials[trial_index]:
                        dep_failed = True
                if dep_failed:
                    inherited += 1
                else:
                    fresh += 1
                    if state_change:
                        fresh_state += 1
                    else:
                        fresh_initial += 1
        print(f"{arm:<11}{failed:>8}{fresh:>8}{inherited:>11}{fresh_state:>30}{fresh_initial:>30}")

    # Per-task matrix: which turns separate the arms.
    for family in families:
        print(f"\n== {family}: per-task pass matrix (each cell = passes/trials)")
        print(f"{'task':>5} {'labels':<32}" + "".join(f"{arm:>12}" for arm in arms))
        for (fam, task) in sorted(k for k in per_task if k[0] == family):
            labels = ",".join(checks[fam][task - 1].get("state_type", [])) or "-"
            cells = []
            for arm in arms:
                trials = per_task[(fam, task)].get(arm, [])
                cells.append(f"{sum(trials)}/{len(trials)}" if trials else "-")
            marker = " <" if len({c for c in cells if c != '-'}) > 1 else ""
            print(f"{task:>5} {labels:<32}" + "".join(f"{c:>12}" for c in cells) + marker)

    print("\n== usage per arm (all tasks)")
    for arm in arms:
        u = usage[arm]
        if not u["tasks"]:
            continue
        print(f"  {arm:<11} tasks={u['tasks']:>3} calls={u['llm_calls']:>4} cost=${u['cost_micro']/1e6:.4f} "
              f"in={u['input_tokens']:>8} cached={u['cached_tokens']:>8} write={u['cache_write_tokens']:>7} out={u['output_tokens']:>6} "
              f"hist={u['historical_inputs']} direct={u['direct_returns']} retained={u['retained_variables']} elapsed={u['elapsed']}s")


if __name__ == "__main__":
    main()
