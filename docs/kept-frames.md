> Historical experiment: these optional modes were retired during the shared ReAct cleanup. See [the current catalog implementation](task-history-dataflow.md). Reproduce the results below at their recorded revisions.

<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements. See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership. The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License. You may obtain a copy of the License at
  http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied. See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Kept frames: a UDF's intermediate tables as results

A multi-task session is a sequence of analyses that build on each other.
The dataflow can only carry that structure if the intermediate tables of
one task exist as results the next task can read. In the real sessions
they did not exist. Kept frames make them exist without asking the model
to plan for it.

## 1. What the traces showed

NFL session (42 tasks), campaign of 2026-09-20, three native arms
(`tasks`, `reuse`, `maint`). From task 2 to task 16 every arm built one
UDF per task whose inputs were only the task-1 base tables:

| task | operators added | references to task-1 tables | references to any later derived result | UDF code (chars) |
|---|---|---|---|---|
| 2 | 1 | 4 | 0 | 3,433 |
| 3 | 1 | 4 | 0 | 4,085 |
| 4 | 1 | 4 | 0 | 4,683 |
| 6 | 1 | 4 | 0 | 3,119 |
| 7 | 1 | 12 | 0 | 3,575 |
| … | 1 | 4–8 | 0 | 3,800–5,200 |

(`maint` arm; `tasks` and `reuse` are the same shape.) Each UDF re-derived
the whole pipeline: cleaned identities, published ranks, percentiles, the
speed signal, the protection score, the group labels. The tasks say "work
from the combined player view", "keep these labels for later comparisons",
"restore the refined speed view": the session is cumulative, the graph was
a star. Consequences: conventions drifted between tasks, code grew, column
names were misremembered (a `KeyError` repair about every third task), and
the maintenance mechanisms (invalidation, demand-driven execution,
receipts) had no dependency graph to act on.

The code agent with state retention (`coderetain`) keeps every DataFrame it
assigns and scored 11/42 on this session; the native arms scored 0–1/42.
On the university session (21 tasks) the two were close (15 vs 12).

Why the model does this: the answer is one JSON document in one cell, so
the shortest path is one UDF. The `reuse` guidance ("put final formatting
in downstream report operators") was ignored in every task.

The university session shows the boundary of the problem. Its task 5 asks
for "the cleaned dataset used for all later analysis", and the model made
that dataset an operator; 43 of the 44 input references in the remaining
tasks point at derived results, one at a base table. When a task names the
intermediate table, the model materializes it. When the intermediate is
implicit in a report ("create the first combined player view … report the
5 highest"), it lives and dies inside one UDF. Kept frames cover exactly
the implicit case.

## 2. Mechanism

**Runtime.** For a UDF with `keepFrames`, the runtime rewrites the entry
function's own `return` statements (not those of nested functions) into a
call that receives `locals()` and the returned value. Every local
DataFrame that is not an input, not the returned frame and not
`_`-prefixed is reported in the operator's profile metadata: name, rows,
schema (12 frames, 32 columns each at most). No data is copied.

**Catalog.** The UDF's line lists them:

```
task2_report = udf(def process(ws, mean, peak, ledger)) <- season_player_workspace, …; schema=answer:str; Completed; rows=1; frames: w(86×22: player_name_clean,team,side,nPlays,mean_kick,90p_kick, …+16); pm(10×4: …); pp(10×4: …)
```

**Reading a frame.** An input slot accepts `{operator, frame}`. The batch
tool synthesizes a derived view operator `task2_report__w` into the same
batch: the parent's code and inputs with `frame: "w"`, which the runtime
executes by returning that local instead of the parent's result. The view
is a real node: consumers depend on it, editing the parent regenerates
every live view derived from it, the seal retains its output like any
other. `{operator, atTask, frame}` replays the parent as sealed at that
task over its inputs as retained then (`task2_report__w__at2`): a fixed
table for rollbacks and counterfactuals. `frame` is runtime-owned; a
model-authored `frame` parameter is refused.

**Diagnostics.** A `KeyError` in a UDF now states which input carries the
column, or lists each input's columns when none does, from the frames the
runtime holds at that moment.

Setting: `nativeKeptFrames` (requires `nativeProfileCollection` and
`nativeTaskHistory`). Arm `frames` = `maint` + kept frames.

## 3. Evidence the mechanism works

`agent-service/benchmark/multiturn/interface-fixes-smoke.ts`, check 9, on
the real engine with no model calls: a UDF assigns `w` and `pm` and returns
an answer; the catalog lists `frames: w(3×3: region,units,double);
pm(1×3: …)`; an aggregate over `{operator:'calc', frame:'w'}` returns
`{total: 24}`; editing the UDF to triple the units modifies `calc` and
`calc__w` in the same batch and the aggregate returns `{total: 36}`;
`{operator:'calc', atTask:N, frame:'w'}` returns `{total: 24}` again from
the sealed definition over the retained input.

## 4. Measurements

Pending: arm `frames` on the NFL and university sessions against
dev-run2's `code`, `coderetain`, `tasks`, `reuse`, `maint`, `demand`.
The questions: does the model read frames instead of re-deriving (count
of `{operator, frame}` references per task, UDF code length); does the
score on the cumulative session approach `coderetain`; what does the extra
view execution cost in engine time and in catalog tokens.

## 5. Limits

A frame view re-executes the parent's code to produce one local; two
frames of the same UDF run it twice. On these sessions that is
milliseconds; an engine-level multi-output port would remove it. Frames
are listed by the author's variable names, so a UDF written as one
expression keeps nothing. Replays require the parent's inputs to have been
retained at that task. The profile payload is bounded (64 KB), so very
wide frames list a prefix of their columns.
