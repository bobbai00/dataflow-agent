<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Context-tracker overhead experiments

These scripts measure what keeping the snapshot tree costs as a session grows: the agent service's memory, with the
context tracker and without it, and the time to jump to a snapshot. They also measure the smolagents baseline's memory
over the same kind of session. The paper's "Human Interaction Support" experiments (memory growth, jump time, tracker
memory) come from them. No model is called: every model response comes from a recorded benchmark run.

## Workload

Recorded KramaBench runs: Claude Opus 5.5 and DeepSeek V4.1 Flash, one rep each.

- **Dataflow agent:** the optimized setting's runs on stable `87a7cea92`. This is the revision these scripts start
  from, so every recorded call replays as it ran. There are 207 conversations; DeepSeek's `wildfire-hard-19` has no
  trace.
- **smolagents:** the paper table's runs, 208 conversations.

`conversations.py` turns attempt folders into one JSON line per conversation:

```bash
K=~/Desktop/optimized-row-experiments-20261024/traces/kramabench
python3 -I benchmark/tracker/conversations.py dataflow conversations-dataflow.jsonl \
  $K/claude-opus-5.5/optimized/opt1-kb-opus55/rep1 $K/deepseek-v4.1-flash/optimized-strict/opt1-kb-deepseek/rep1
S=<the smolagents rep1 folders of kramabench-experiments-20261014.zip>
python3 -I benchmark/tracker/conversations.py smolagents conversations-smolagents.jsonl \
  $S/claude-opus-5.5/smolagents/rep1 $S/deepseek-v4.1-flash/smolagents/rep1
```

## Dataflow agent

`run-arm.sh` starts an agent service of this checkout on the engine of a campaign stack (`benchmark/campaign`) and
replays every conversation through it (`replay-dataflow.ts`). The service is started by `start-agent.sh`, with its own
port, trace database and workspace, and the memory route on (`AGENT_DEBUG_MEMORY=1`). It sends its model calls to the
replayer, which answers each one with the next recorded response. Everything else runs as in a benchmark run: every
edit, every execution on the engine, and the context of every call. The replay checks that each call's input is about
as long as the recorded one, and that tool errors fall where they did.

All conversations run in one agent. Each one starts from the agent's first snapshot, the empty dataflow, so the
conversations become branches of one snapshot tree. The replayer records the service's heap and external memory after
a full collection, and the tree's size, twice per conversation. The first reading is taken right after the
conversation. The second is taken once HEAD is back at the first snapshot (`rest` lines): that is the history alone,
since the finished conversation's results have gone to disk. The paper's data uses the second reading.

```bash
R=/var/tmp/snapshot-overhead/runs C=conversations-dataflow.jsonl
benchmark/tracker/run-arm.sh $R/keep   3143 3197 $C --history keep     # the agent as it is
benchmark/tracker/run-arm.sh $R/jumps  3145 3195 $C --jumps 50 --jump-every 250
bun benchmark/tracker/structure_memory.ts $R/keep                      # the tracker's structure, per point
```

What the tracker costs is its structure over the history: the session keeps the same snapshots (dataflows, results,
observations) either way, and the tracker adds, per snapshot, its id, parent, step, time, version and action, and
the indexes over them (snapshots by id, each step's newest snapshot, the snapshots with children, the version numbers,
each step's children). `structure_memory.ts` rebuilds that structure from the run's trace (`traces.db`) for the tree
as it stood at each `rest` point, as the agent holds it, sharing strings as the agent does, and measures the live
bytes it adds in a fresh process (heap snapshots before and after). It does not measure in the agent service: there,
heap snapshots crash Bun after a few calls, and the heap's own size, counted in whole blocks, cannot show a few
megabytes in a heap that has freed more. The paper's "without" line is the agent's memory less this structure.

`--history forget` is another comparison, not the paper's: before each conversation it drops every snapshot that the
new conversation's path does not need, so the agent keeps no history of earlier dataflows. Its context is the same,
except for results the engine serves from its cache: all conversations share one workflow, so a cached result can
come from an earlier conversation, and only the kept snapshots still hold that run's statistics (62 of the 207
conversations then sent model inputs more than 2% shorter than recorded).

`--jumps K --jump-every N` checks out K random versions each time the tree passes another N snapshots
(`POST /:id/checkout-version`). Each jump is timed from the request to the GUI frame (`headChange`) that carries the
restored dataflow and results. The server's own timing comes back with the response. A jump to a version in the middle
of a step records a restore step, as a click in the version tree does, so the tree grows a little with the jumps.

## smolagents

```bash
.venv/bin/python benchmark/tracker/replay_smolagents.py conversations-smolagents.jsonl smolagents-memory.jsonl \
  --kramabench benchmark/Kramabench
```

This is the benchmarks' baseline, built by KramaBench's `CodeAgentWrapper`. It runs every conversation in one session
with `reset=False`, as the smolagents service continues a chat. Its model returns the recorded responses. Its executor
returns what each step's code printed, returned or raised, so no code runs and the memory is the agent's history,
without execution variables. After every step the replayer records the Python memory traced after a full collection.

smolagents keeps no snapshot of its Python state, so it cannot jump. To go back to step k, it would have to run the
code of steps 1 to k again. `restore_smolagents.py` times that for random steps. It uses the baseline's interpreter
(`benchmark/retrieval/script-agent/setup.sh` builds it) and executor, with the task data mounted where the benchmark
mounted it. Each step runs in a fresh process; the process start and loading pandas and numpy are not counted, since a
running session has done both already.

```bash
benchmark/retrieval/script-agent/.venv/bin/python benchmark/tracker/restore_smolagents.py \
  conversations-smolagents.jsonl smolagents-restore.jsonl --data benchmark/Kramabench/data \
  --kramabench benchmark/Kramabench --samples 300
```

## The paper's data

```bash
python3 -I benchmark/tracker/summarize.py --keep $R/keep --jumps $R/jumps \
  --smolagents smolagents-memory.jsonl --smolagents-restore smolagents-restore.jsonl \
  --out <paper repo>/scripts/plots/data
```

This writes `memory_growth.csv`, `tracker_heap.csv`, `tracker_jumps.csv` and `script_restore.csv`. The paper repository's
`scripts/plots/fig_memory_growth.py` and `fig_tracker.py` draw them.
