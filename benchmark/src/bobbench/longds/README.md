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

Every request ends with a line that names the earlier tasks it builds on (the
benchmark's annotated dependencies). The arm fixes what a request sees of the
earlier ones:

| arm | runner | earlier requests in context |
|---|---|---|
| `catalog-gold` | `run_session` | the task catalog: every earlier task by its request, dataflow changes and answer, the ones it builds on in detail |
| `transcript-depnote` | `run_session` | their full transcript |
| `smolagents-depnote` | `smolagents_session` | their full transcript |

Both dataflow arms set `multiRequest: "transcript"`: prompt section 5, function
signatures in receipts and notes on constant columns
([design](../../../../docs/native-multi-request-design.md)).

The script-agent baseline (`smolagents_session.py`) is smolagents' `CodeAgent` set up as
`bobbench/scriptreact/code_agent.py` sets it up (no tools, its authorized imports, stock
system prompt, 20 steps a request), continued across the session's requests, sent the same
prepared requests, its code run in smolagents' interpreter inside a sandbox that sees the
session's data read-only and has no network.

## Inputs

`benchmark/bench setup longds` makes everything:

- `benchmark/longds/DataMind` (`LONGDS_DATAMIND`): the upstream checkout's judge prompt, the
  Lite sessions' tasks, gold and data;
- `benchmark/Kramabench/data/longds/<domain>/<dataset>/<task>/data/`: the copy of each
  session's data the engine reads (the stack's `NATIVE_SOURCE_DATA` tree; not links, because
  the sandbox mounts only that tree);
- `benchmark/longds/prepared/<key>/` (`LONGDS_PREPARED`): the requests and the gold;
  `bench longds prepare` makes the same bytes every time;
- netflix task3's `working_tables`, seven tables a run left in its data folder on 2026-09-23.
  Every paper run saw them and its requests list them; LongDS does not ship them, so they
  live next to this file in `data/`.

## Steps

From the repository root, with the stack's environment (`run-env.sh`) for the steps that
call the agent or the judge:

```bash
S=/var/tmp/bobflow-bench R=$S/runs/longds-luna
bash $S/run-env.sh benchmark/bench longds campaign --root $R --model gpt-5.6-luna --parallel 6 \
    --sessions sports__nfl_big_data_bowl_2023__task1    # default: every prepared session
bash $S/run-env.sh benchmark/bench longds judge --runs $R/runs   # deepseek-v4-pro via OpenRouter
benchmark/bench longds report --runs $R/runs --json $R/summary.json
```

`bench longds run` and `bench longds smolagents` run one session alone. A session sends every
request once. A request still running after 30 minutes is stopped, and one that ends without
an answer is recorded as incomplete; either way the session goes on. No request starts once
the session has spent its limit (default $5). Costs are each response's token usage at the
rates in `bobbench/models.py`.

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

Tests: `benchmark/bench test tests/longds`.
