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

# The $0 runner gate

Replays recorded Claude Haiku 5.5 smokes through this checkout's runners with a stub model, and checks that every
attempt sends the same model requests and ends the same way. No model is called. Use it after any change to the
harness, the agent or the engine that is not meant to change what a model sees.

- `replay_model.py`: an OpenAI chat-completions stub. It answers a request only if a recorded attempt sent exactly that
  request (after `benchmark/tracker/compare_replays.py`'s normalization of ids, timestamps and hashes); anything else
  gets a 500, which shows up as a divergence. Every request is logged; `"attempt": null` marks an unmatched one.
- `compare.py`: per (arm, task), every model request, prompt.txt, response.txt, settings.json (keys in `--allow` are
  reported, not failed), answer.json, evaluation.json without its clocks, PrepBench `outputs/` byte for byte, and the
  billed cost. LongDS arms: records, settings and, for the dataflow arms, every request.
- `rgate.sh <out> [kb] [kbflow] [pb] [kbsmol] [pbsmol]`: the KramaBench and PrepBench runners (28 attempts): BobFlow on
  3 KramaBench tasks x 3 paper arms (smk2-kb), both Flow Evidence arms on 5 tasks (smk5-kbflow), BobFlow on 2 PrepBench
  cases x 2 arms (smk2-pb), Script ReAct on the same KramaBench and PrepBench tasks (smk0-kbsmol, smk0-pbsmol). Ports:
  gate agent :3152, stub :3192.
- `rgate-longds.sh <out>`: the three LongDS paper arms on the first 2 requests of netflix task2 (smk2-longds). Ports
  :3153 and :3193.
- `allow-keys.txt`: the settings the agent removed after the smokes were recorded (Phase A). Nothing else may differ.

The references are the baseline smokes in `$STACK_DIR/runs` (`GATE_BASELINE` overrides), recorded on the cleanup
stack (`STACK_DIR`, default `/var/tmp/texera-cleanup`). The stack's services must be up; each gate starts its own agent
from this checkout. The runners get an invalid `OPENAI_API_KEY`, so a judge-cache miss shows as an unscored answer
(and fails the comparison) instead of a paid call:

```bash
benchmark/tests/gate/rgate.sh /var/tmp/texera-cleanup/tools/rgate/<name>
benchmark/tests/gate/rgate-longds.sh /var/tmp/texera-cleanup/tools/rgate/<name>-longds
```

Each prints one line per attempt (`ok` or `FAIL` with the first difference), `attempts equal: N of N` and the number
of unmatched stub requests, which must be 0.
