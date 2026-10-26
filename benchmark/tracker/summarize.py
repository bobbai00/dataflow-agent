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
"""The overhead experiments' results as the paper's plot data (scripts/plots/data in the paper repository).

    python3 -I summarize.py --keep RUN --jumps RUN --smolagents FILE --smolagents-restore FILE --out DIR

RUN is a run folder of run-arm.sh (its replay.jsonl); the smolagents files are the outputs of replay_smolagents.py and
restore_smolagents.py. Writes:
- memory_growth.csv (agent, interactions, memory_growth_mib): memory held for the session's history (the dataflow
  agent, after each conversation, once HEAD is back at the first snapshot: JavaScript heap and external memory after a
  full collection; smolagents, after each step: Python memory traced after a full collection), minus what it held
  after the first conversation, which also holds one-time costs (modules loaded, caches warmed). Interactions are agent
  steps, one per model call.
- tracker_heap.csv (tracker, snapshots, heap_mib): the dataflow agent's heap and external memory at the same points,
  with the context tracker ("with"), and with the same snapshots but without the tracker's structure over them
  ("without": that memory less the structure's, which structure_memory.ts measured into the run's structure.jsonl).
- tracker_jumps.csv (snapshots, ms, restore_ms, head_change_bytes): one row per jump; ms is from the request to the
  GUI frame with the restored dataflow and results (client side), restore_ms the server's restore alone.
- script_restore.csv (step, steps_run, ms): smolagents going back to a step, which means running the code of every
  step up to it again; one row per sampled step that finished.
"""
import argparse
import csv
import json
from pathlib import Path

MIB = 2**20


def lines(path: Path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def held(memory):
    return memory["heapUsed"] + memory["external"]


def rests(run: Path):
    """The measurements taken after each conversation, once HEAD is back at the first snapshot."""
    return [line for line in lines(run / "replay.jsonl") if line["kind"] == "rest"]


def write(path: Path, header, rows):
    with path.open("w", newline="") as sink:
        writer = csv.writer(sink)
        writer.writerow(header)
        writer.writerows(rows)
    print(f"{path}: {len(rows)} rows")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    for name in ("keep", "jumps"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--smolagents", type=Path, required=True)
    parser.add_argument("--smolagents-restore", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    keep = rests(args.keep)
    structure = {line["index"]: line["bytes"] for line in lines(args.keep / "structure.jsonl")}

    system = [(c["agentSteps"], (held(c["memory"]) - held(keep[0]["memory"])) / MIB) for c in keep]
    steps = [line for line in lines(args.smolagents) if line.get("conversation")]
    first = [line for line in steps if line["conversation"] == steps[0]["conversation"]][-1]
    script = [(line["steps"], (line["bytes"] - first["bytes"]) / MIB) for line in steps if line["steps"] >= first["steps"]]
    write(args.out / "memory_growth.csv", ["agent", "interactions", "memory_growth_mib"],
          [("system", x, round(y, 3)) for x, y in system] + [("script", x, round(y, 3)) for x, y in script])

    write(args.out / "tracker_heap.csv", ["tracker", "snapshots", "heap_mib"],
          [("with", c["snapshots"], round(held(c["memory"]) / MIB, 3)) for c in keep]
          + [("without", c["snapshots"], round((held(c["memory"]) - structure[c["index"]]) / MIB, 3)) for c in keep])

    restores = [line for line in lines(args.smolagents_restore) if line.get("seconds") is not None]
    write(args.out / "script_restore.csv", ["step", "steps_run", "ms"],
          [(line["step"], line["steps"], round(line["seconds"] * 1000, 3)) for line in restores])

    jumps = [line for line in lines(args.jumps / "replay.jsonl") if line["kind"] == "jump"]
    write(args.out / "tracker_jumps.csv", ["snapshots", "ms", "restore_ms", "head_change_bytes"],
          [(j["snapshots"], round(j["headChangeMs"], 3), round(j["restoreMs"], 3), j["headChangeBytes"]) for j in jumps])


if __name__ == "__main__":
    main()
