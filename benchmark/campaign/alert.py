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
"""Event stream for the runs of one benchmark stack ($STACK_DIR, default /var/tmp/texera-stable) (one line per event, for a Monitor): attempts with a problem (no score, non-zero
exit, timeout, audit violations, no billed cost), a PAUSE file not written by the memory guard, non-200 answers from the
proxy stand-in, memory-guard pauses, a progress line every 20 attempts per run, and each run's end. Exits when every run
has ended. Usage: alert.py <run name>..."""
import ast, json, os, re, sys, time
G = os.environ.get("STACK_DIR", "/var/tmp/texera-stable").rstrip("/")
RUNS = sys.argv[1:]
state = {r: {"pos": 0, "n": 0, "pass": 0, "cost": 0.0, "secs": 0.0, "ended": False, "pause": None} for r in RUNS}
proxy_pos = os.path.getsize(f"{G}/logs/computing-unit-master.log") if os.path.exists(f"{G}/logs/computing-unit-master.log") else 0
guard_pos = os.path.getsize(f"{G}/logs/guard.log") if os.path.exists(f"{G}/logs/guard.log") else 0
bad_proxy = 0
guard_pauses = 0


# A re-armed watch (QUIET_START=1) replays the existing log lines silently, so counts stay whole and only new events print.
quiet = os.environ.get("QUIET_START") == "1"


def emit(msg):
    if not quiet:
        print(time.strftime("%H:%M:%S ") + msg, flush=True)


def tail(path, pos):
    try:
        with open(path) as f:
            f.seek(pos)
            data = f.read()
            return data, f.tell()
    except OSError:
        return "", pos


while not all(s["ended"] for s in state.values()):
    for r, s in state.items():
        data, s["pos"] = tail(f"{G}/logs/{r}.log", s["pos"])
        for line in data.splitlines():
            if line.startswith("DONE "):
                d = ast.literal_eval(line[5:])
                a = d.get("audit") or {}
                s["n"] += 1
                s["pass"] += (d.get("score") or 0) >= 1
                s["cost"] += d.get("cost_usd") or 0
                s["secs"] += d.get("seconds") or 0
                problems = [p for p, bad in [("no score", d.get("score") is None), (f"exit {d.get('exit_code')}", d.get("exit_code") not in (0, None)),
                                             ("TIMEOUT", d.get("timeout")), (f"violations {a.get('violations')}", a.get("violations")),
                                             ("no billed cost", d.get("cost_usd") is None)] if bad]
                if problems:
                    emit(f"{r} {d['task']}: {'; '.join(problems)} (score {d.get('score')}, {round(d.get('seconds') or 0)} s)")
                if s["n"] % 20 == 0:
                    emit(f"{r}: {s['n']} done, {s['pass']} pass ({100 * s['pass'] / s['n']:.1f}%), ${s['cost'] / s['n']:.4f}/attempt, {s['secs'] / s['n']:.0f} s/attempt; guard pauses so far {guard_pauses}")
            elif line.startswith(("complete ", "incomplete ")) or "Traceback" in line:
                emit(f"{r}: {line.strip()[:300]}")
                if line.startswith(("complete ", "incomplete ")):
                    s["ended"] = True
                    emit(f"{r} ENDED: {s['n']} done, {s['pass']} pass, ${s['cost']:.2f} billed")
        p = f"{G}/runs/{r}/PAUSE"
        try:
            text = open(p).read().strip()
        except OSError:
            text = None
        if text != s["pause"]:
            if text and not text.startswith("memory-guard:"):
                emit(f"{r} PAUSED: {text[:300]}")
            elif text is None and s["pause"] and not s["pause"].startswith("memory-guard:"):
                emit(f"{r} pause removed")
            s["pause"] = text
    data, proxy_pos = tail(f"{G}/logs/computing-unit-master.log", proxy_pos)
    for line in data.splitlines():
        # Engine-side failures that are not the model's: the cold-start catalog race and its broken-workflow NPE.
        if "duplicate key value" in line or 'executionRuntimeService()" is null' in line and "Sync execution error" in line:
            bad_proxy += 1
            if bad_proxy <= 20 or bad_proxy % 50 == 0:
                emit(f"engine: {line.strip()[:220]} (#{bad_proxy})")
    data, guard_pos = tail(f"{G}/logs/guard.log", guard_pos)
    for line in data.splitlines():
        # Guard cycles are routine while the machine is busy: count them; they show in the progress lines.
        if " PAUSE " in line:
            guard_pauses += 1
    if quiet:
        quiet = False
        emit("watch re-armed: " + ", ".join(f"{r} {v['n']} done, {v['pass']} pass" for r, v in state.items()))
    time.sleep(10)
emit("ALL RUNS ENDED")
