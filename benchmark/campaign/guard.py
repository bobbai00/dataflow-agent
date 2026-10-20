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
"""Memory guard and resource log for the runs of one benchmark stack ($STACK_DIR, default /var/tmp/texera-stable); touches only its own runs.

Pauses this campaign's runners (a PAUSE file starting "memory-guard:"; both runners wait, running attempts finish)
below 5 GB available memory or 6 GB free swap and resumes above 7 GB and 8 GB (swap lines raised 05:50 after another
session's process took free swap to 1.6 GB at 04:22) (2026-10-14 04:20: was 6/8 GB, which kept
the runs paused 96% of the time on the busy machine; now the same lines as the flow-trim guard). The flow-trim guard pauses at the same
line and the LongDS guards below 4 GB. Never kills a process. Every minute it logs memory, swap,
load, this stack's processes (JVMs, agent, runners, engine workers, smolagents children) and containers, and run
progress to logs/guard.log; the latest snapshot goes to status.txt.
Usage: [STACK_DIR=...] guard.py   (runs listed in $STACK_DIR/runs.txt, one directory per line)"""
import json, os, subprocess, time
S = os.environ.get("STACK_DIR", "/var/tmp/texera-stable").rstrip("/")
PROJECT = os.environ.get("STACK_PROJECT", os.path.basename(S))
LOG, STATUS, RUNS = S + "/logs/guard.log", S + "/status.txt", S + "/runs.txt"
OWN = (S + "/",)
PAUSE_AVAIL, PAUSE_SWAP, RESUME_AVAIL, RESUME_SWAP = 5120, 6144, 7168, 6656


def meminfo():
    info = {}
    for line in open("/proc/meminfo"):
        key, value = line.split(":")
        info[key] = int(value.split()[0]) // 1024
    return info["MemAvailable"], info["SwapFree"]


def say(message, path=LOG):
    with open(path, "a") as f:
        f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + message + "\n")


def runs():
    try:
        return [line.strip() for line in open(RUNS) if line.strip()]
    except OSError:
        return []


def own_pause(run):
    try:
        return open(os.path.join(run, "PAUSE")).read().startswith("memory-guard:")
    except OSError:
        return False


def own_processes():
    """RSS of this stack's processes: anything whose command line or working directory names it, plus engine workers
    of its master (their cwd is the worktree's amber dir, so they are matched by the master's port in their parent)."""
    total, count = 0, 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace")
            env_hit = False
            if not any(mark in cmd for mark in OWN):
                environ = open(f"/proc/{pid}/environ", "rb").read()
                env_hit = f"TEXERA_LOCAL_DEV_DIR={S}".encode() in environ
                if not env_hit:
                    continue
            rss = int([l for l in open(f"/proc/{pid}/status") if l.startswith("VmRSS")][0].split()[1]) // 1024
        except (OSError, IndexError, ValueError):
            continue
        total += rss
        count += 1
    return count, total


def containers():
    try:
        out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}={{.MemUsage}}"], capture_output=True, text=True, timeout=30).stdout
    except Exception:
        return "?"
    return " ".join(l.split("=")[0].replace(PROJECT + "-", "") + "=" + l.split("=")[1].split(" /")[0] for l in out.splitlines() if l.startswith(PROJECT + "-"))


def progress():
    parts = []
    for run in runs():
        try:
            p = json.load(open(os.path.join(run, "progress.json")))
        except (OSError, ValueError):
            continue
        done = p.get("completed") or []
        active = p.get("active") or {}
        n_active = sum(1 for a in (active.values() if isinstance(active, dict) else active) if a)
        parts.append(f"{os.path.basename(run)} {len(done)} done pass={sum((r.get('score') or 0) >= 1 for r in done)} active={n_active}")
    return "; ".join(parts)


paused = any(own_pause(r) for r in runs())
say(f"GUARD started (pause below {PAUSE_AVAIL} MB available or {PAUSE_SWAP} MB free swap, resume above {RESUME_AVAIL}/{RESUME_SWAP}; never kills; paused={paused})")
last_log = 0
while True:
    avail, swap = meminfo()
    if not paused and (avail < PAUSE_AVAIL or swap < PAUSE_SWAP):
        for r in runs():
            p = os.path.join(r, "PAUSE")
            if os.path.isdir(r) and not os.path.exists(p):
                open(p, "w").write(f"memory-guard: avail={avail}MB swapfree={swap}MB\n")
        paused = True
        say(f"PAUSE avail={avail}MB swapfree={swap}MB")
    elif paused and not (avail > RESUME_AVAIL and swap > RESUME_SWAP):
        # A run listed while the guard is already paused gets its PAUSE file too.
        for r in runs():
            p = os.path.join(r, "PAUSE")
            if os.path.isdir(r) and not os.path.exists(p):
                open(p, "w").write(f"memory-guard: avail={avail}MB swapfree={swap}MB\n")
                say(f"PAUSE (newly listed) {os.path.basename(r)}")
    elif paused and avail > RESUME_AVAIL and swap > RESUME_SWAP:
        for r in runs():
            if own_pause(r):
                os.remove(os.path.join(r, "PAUSE"))
        paused = False
        say(f"RESUME avail={avail}MB swapfree={swap}MB")
    if time.time() - last_log >= 60:
        last_log = time.time()
        n, rss = own_processes()
        load = " ".join(open("/proc/loadavg").read().split()[:3])
        line = (f"mem avail={avail}MB swapfree={swap}MB load={load} | ours: {n} procs {rss}MB containers {containers()} | "
                f"{'PAUSED' if paused else 'running'} | {progress()}")
        say(line)
        open(STATUS, "w").write(time.strftime("%H:%M:%S ") + line + "\n")
    time.sleep(5)
