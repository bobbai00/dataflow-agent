<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# LongDS sessions

LongDS v1.1 Lite has 24 sessions of 15 to 42 dependent requests over one
dataset. Each request builds on earlier answers: an Update changes a rule from
now on, a Rollback returns to an earlier rule, and a Counterfactual compares a
variant with the current result. One native agent serves a whole session, with
one workflow and one computing unit, so later requests read the Dataflow and
functions that earlier ones left.

The arm fixes the agent's multi-request settings
([design](../../docs/native-multi-request-design.md)):

| arm | earlier requests in context | prompt section 5, signatures, constant-column notes |
|---|---|---|
| `off` | their full transcript (stable's single-request agent) | no |
| `transcript` | their full transcript | yes |
| `catalog` | request text plus one catalog entry each | yes |
| `catalog-compact` | as `catalog`; documented functions by signature and docstring | yes |
| `hybrid` | as `catalog-compact`, but the 5 to 9 most recent requests as transcript | yes |

## Inputs

`DataMind` links to the upstream checkout (tasks, gold, data, judge prompt).
The engine reads session data from the stack's `NATIVE_SOURCE_DATA` tree at
`longds/<domain>/<dataset>/<task>/data/`. Copy the files there; do not link
them, because the sandbox mounts only that tree.

## Steps

From the repository root, with the stack's environment (`run-env.sh`) for the
steps that call the agent or the judge:

```bash
python -m benchmark.longds.prepare --out R/prepared sports/nfl_big_data_bowl_2023/task1
python -m benchmark.longds.campaign --root R --sessions sports__nfl_big_data_bowl_2023__task1 \
    --arms off transcript catalog --reps 3 --parallel 6
python -m benchmark.longds.judge --runs R/runs       # deepseek-v4-pro via OpenRouter
python -m benchmark.longds.report --runs R/runs --json R/summary.json
```

`run_session` runs one session alone. It sends every request once. A request
still running after 30 minutes is stopped, and one that ends without an answer
is recorded as incomplete; either way the session goes on. No request starts
once the session has spent its limit (default $5). Costs are token estimates
from `benchmark/retrieval/metrics.py`.

## Outputs

`R/runs/<session>__<arm>__r<rep>/` holds:
- `protocol.json`: arm, model, settings, source revision;
- `system-info.json` and `settings.json`, as the agent reports them;
- `tNN/record.json`: answer, completion, usage, cost and time of request NN;
- `tNN/steps.json.gz`: its full trace, with each call's input messages;
- `tNN/judge.json`: its score.

`report` gives accuracy by state type, cost, calls per request, input per call
and the behavior of each run (`behavior.py`): earlier functions called, rules
changed by a setting, alternatives built beside the current version, earlier
tables read, rescans, and new functions per request.

Tests: `python -m pytest benchmark/longds`.
