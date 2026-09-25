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

**DSGym inability answers and Dataflow context cost, 2026-09-24.**
This audit reads existing first-pass traces, recorded usage and the frozen-r3
implementation. No model calls, executions, service restarts or rejudging were
performed. The [structured audit](analysis-state-context-cost-audit.json) contains
per-call usage, context character counts, paired cost groups and source hashes.
The earlier [accuracy audit](analysis-state-vs-dsgym-audit.md) explains the
successful analytical mechanisms.

**What DSGym declined to do.** At Education BI turn 1, the model answered:
“Unable to determine the requested raw-data results because the dataset is not
accessible for execution in this environment.” It had submitted no Python and
received no execution error. Turns 2–6 repeated the inability claim. At turn 7,
the same session listed the files, read the CSV, handled an actual UTF-8 decoding
error by using cp1252, and correctly computed the requested education-level
means. The model's claim of unavailable execution was therefore unsupported by
the trace; it was not an observed executor denial or API refusal event.

The baseline uses upstream DSGym's text protocol. The model receives instructions
to write `<python>...</python>`; the harness extracts and executes that text and
returns `<information>...</information>`. There are no API function-tool
definitions in its requests. A normal `<answer>...</answer>` ends the question,
even when its content says “unable.” The harness does not require an attempted
read before accepting such an answer. Its 40-step limit is a maximum, not a
minimum. The local wrapper checks kernel allocation before model calls; a
failed allocation is supposed to abort setup.

This establishes the observed sequence, not the model's internal reason for
choosing it. The text-only execution interface is a plausible contributor. The
saved inability answers also remain in the conversation and can reinforce the
wrong premise, but no ablation isolates that effect. Dataflow receives a
structured tool plus a stronger first-turn preamble: explicit file paths for
small inventories, folder summaries for large inventories, persistence guidance,
and an instruction to use code for every calculation. DSGym receives its upstream
system prompt naming the directory and the raw benchmark question/context.
Consequently, the measured accuracy difference includes execution-interface and
prompt differences as well as state representation. The comment in
`official_protocol.py` about matched file inventories does not describe the
actual DSGym branch, which builds prompts separately in `dsgym_agent.py`.

Across the first-pass baseline, 45 questions have inability wording in the final
answer and no Python submission in that question: Goodbooks 10, BI 7, Los Angeles
15, NFL 13. These are not all false environment claims: later turns sometimes
lack valid earlier analytical components. For example, NFL turn 26 attempts
Python twice, obtains NaNs, and then cannot rank the players; it is outside this
45-turn category. Fourteen of the existing Dataflow arm's 29 exclusive passes
face a no-Python inability answer. Those wins cannot establish a graph-state
advantage in isolation.

Evidence: [BI first response](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_dsgym_luna_t1/education__bi__task2/agent/bak/turn_1_result.json),
[BI successful execution at turn 7](../benchmark/longds/system_scratch/LongDS_Isolated_20260924_dsgym_luna_t1/education__bi__task2/agent/bak/turn_7_result.json),
[upstream stopping logic](../benchmark/longds/DataMind/longds/runners/DSGym/dsgym/agents/environment/envs/allocated_code/env.py),
[baseline wrapper](../benchmark/longds/dsgym_agent.py).

**The catalog still compresses completed work, but the evaluated variants differ.**
There are two meanings of catalog: the static reference describing available
operators, and the dynamic record of analytical objects built during a session.
The static operator reference is part of the system prompt; it is not itself
compressed session history.

The history code supports three representations:

| Representation | What it supplies to the model | Global history limit |
| --- | --- | --- |
| Original compact catalog branch | Completed request/answer pairs and current operator signatures, schemas, status and provenance | None |
| Evaluated `react-entries` | Every completed task's request, landed changes, function bodies, table samples and answer; current live-table index | None |
| Evaluated `react-analysis` | Selected requests, table cards and exact function definitions; archived task index | 24,000 characters for selected memory |

Both evaluated Dataflow arms replace completed action traces. The existing arm
retains rich, immutable entries to preserve formulas, scope and stable cache
prefixes. It is not merely a small menu of operator names. Requests and answers
remain whole. Each referenced function can contribute up to 80 lines; table
contents have a 4,000-character budget per completed task. Neither rule bounds
total historical context. Although both configurations record
`nativeTaskMemoryChars: 24000`, that setting is consumed only by the analysis
memory branch. It does not cap `react-entries`.

The newer arm's cap is characters, not tokens. It excludes the system prompt,
tool definitions, current question and current question's action/observation
trace. Inspection returns exact definitions; recall returns full rich task
entries. These reads can therefore reintroduce far more history than the initial
selection budget. Thought replay is off in both arms, but active tool calls and
their observations remain visible.

The frozen implementation is in
[task-context.ts](/tmp/texera-analysis-state/frozen-r3/agent-service/src/agent/native/task-context.ts),
[task-entries.ts](/tmp/texera-analysis-state/frozen-r3/agent-service/src/agent/native/task-entries.ts),
and [analysis-memory.ts](/tmp/texera-analysis-state/frozen-r3/agent-service/src/agent/native/analysis-memory.ts).

**Model cost across the six first-pass tasks.** There are 209 judged questions
per arm. Unreached questions are failures; these are session totals under the
recorded wall limits, not estimates for completing every question. Existing
Dataflow reaches three Goodbooks questions; the candidate reaches seventeen
Goodbooks and twenty-eight Survey questions, including interrupted work.
First-pass results are primary; repeats are not pooled or selected best-of.
Scores below are task-macro averages of the existing GPT-5.2 binary labels.

| Arm | Accuracy | Model calls | Input tokens | Mean input/call | Cache-read share | Model cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Persistent DSGym | 30.12% | 424 | 14,915,256 | 35,177 | 97.30% | $0.769010 |
| DSGym + function guidance | 29.06% | 418 | 17,403,392 | 41,635 | 97.51% | $0.850480 |
| Existing Dataflow entries | 40.15% | 534 | 27,963,203 | 52,366 | 94.52% | $1.361320 |
| New analysis-state Dataflow | 37.55% | 875 | 22,100,622 | 25,258 | 84.65% | $1.837192 |

Input includes cache reads and writes. Repeated input tokens count on every call;
they are not unique history tokens. Cached reads are discounted, not free.
These are repository estimates at $0.20/M ordinary input, $0.02/M cache reads,
$0.25/M cache writes and $1.20/M output. They exclude judges and infrastructure
and are not invoices or a claim about current public provider pricing.

| Cost component | DSGym | Existing Dataflow | New Dataflow |
| --- | ---: | ---: | ---: |
| Cache reads | $0.290246 | $0.528610 | $0.374181 |
| Cache writes | $0.099534 | $0.382774 | $0.847231 |
| Other input | $0.000959 | $0.000320 | $0.000525 |
| Output, including reported reasoning | $0.378270 | $0.449615 | $0.615254 |
| **Total** | **$0.769010** | **$1.361320** | **$1.837192** |

Existing Dataflow costs 77.0% more, combining 25.9% more calls with 48.9% more
input per call. Of its $0.592310 premium, 47.8% is additional cache-write cost,
40.2% additional cached reads and 12.0% output. The new arm costs 138.9% more
than DSGym despite fewer input tokens per call: it makes 106.4% more calls and
creates 3.389M cache-write tokens versus 0.398M. Writes account for 70.0% of its
premium, output 22.2% and cached reads 7.9%.

| Task | DSGym cost | Existing Dataflow cost | New Dataflow cost |
| --- | ---: | ---: | ---: |
| Goodbooks | $0.169894 | $0.029223 | $0.258890 |
| Survey | $0.111423 | $0.169544 | $0.172440 |
| Education BI | $0.037062 | $0.074787 | $0.092718 |
| Water | $0.194849 | $0.250977 | $0.374913 |
| Los Angeles | $0.117811 | $0.345869 | $0.385890 |
| NFL | $0.137970 | $0.490918 | $0.552341 |

**Where the input goes.** Logged `inputMessages` omit the separately supplied
system prompt and tool definitions. The following are character shares of logged
context, summed across model calls, not a billable-token allocation:

| Existing-arm context component | Share |
| --- | ---: |
| Historical changes, including code and operator metadata | 63.44% |
| Historical table samples | 11.51% |
| Historical requests | 8.42% |
| Historical answers and source names | 6.14% |
| Active tool results | 6.04% |
| Active assistant/tool-call content | 2.31% |
| Live table index | 1.63% |
| Current question | 0.51% |

About 89.5% of logged context is completed-task history. Function bodies with
their display indentation contribute 28.1% of the total, inside the changes
category. Exact duplicate function blocks within a prompt contribute only 0.44%;
simple code deduplication alone is therefore a small target. The larger target is
replaying all older changes and definitions regardless of current relevance.

Offline reconstruction from frozen-r3 gives 34,555 characters of system prompt
and 3,344 of tool definition for entries; the operator reference is 8,137 of
those system-prompt characters. The candidate has 33,632 system characters and
4,476 tool-definition characters. These are source-string sizes, not exact wire
serialization or token counts. In the BI first call, provider-reported input is
9,172 tokens for existing Dataflow versus 766 for DSGym, before substantial
session history exists. Static instructions have a real cost, though caching
discounts later repetitions.

At BI turn 30, entries replay 29 historical entries totaling 91,372 characters,
plus a 2,654-character live index and the current question. The first model call
uses 33,779 input tokens. The candidate's selected memory is 22,881 characters;
its first call uses 14,415 input tokens. Compression reduces that input by 57.3%.
Nevertheless, across BI the candidate makes 77 calls versus 63 and costs
$0.092718 versus $0.074787: 24.0% more for the same 28/30 score.

**Why the bounded candidate becomes expensive.** Its active tool results are
60.0% of logged context, while selected memory is 32.5%. Inspection/recall text
accounts for 20.06M of 32.24M raw tool-result characters replayed across calls
(62.2%). Counted only on each result's first appearance, these reads introduce
4.47M characters. There are 180 dataflow calls containing inspection and 126
containing recall; categories overlap. Twenty-one observed results report a
request exceeding the six-definition/three-task retrieval limit.

At NFL turn 32, one initial inspect/recall response is 81,176 characters. About
16,446 characters precede the actual inspection section, including many
operator re-execution/status lines. Later reads retrieve batches of archived
tasks. By the ninth call, accumulated tool messages occupy 266,984 characters
in the audit's structured-content measure. The initial 24,000-character memory
cap cannot control this growth. The agent does perform useful reasoning and
repairs during this turn; these counts do not establish that all reads are wasted.

The candidate also rewrites selected memory between questions instead of
appending only immutable entries. At question-start calls it reads 67.36% of
input from cache, versus 93.09% for entries. Later calls within a question read
86.95% versus 95.14%. Selection churn plausibly contributes to the difference;
this is not a causal allocation of every cache miss. Most candidate write tokens
occur within questions (2.544M), rather than at their first calls (0.845M), so
optimizing only the between-question catalog misses much of the expense.

Some extra spend accompanies correct answers where DSGym declines to execute.
However, the premium persists on the 47 questions both existing Dataflow and
DSGym pass: $0.192489 versus $0.130783, 47.2% more. On their 123 shared failures,
the corresponding costs are $0.937854 versus $0.541641. These are descriptive
partitions of call costs, not causal attribution: earlier work can support later
questions. Examples of avoidable overhead include Survey turn 16's loader-arity
repair and additional read for a row omitted from its display. Useful reuse can
also save cost: Survey turn 13 and Water turn 10 take fewer calls in Dataflow.

**Next changes, in priority order.**

1. Start from the accuracy-winning entries arm. Keep complete tables, exact
   formulas, dependency edges, cohort identity and historical versions in stored
   state. Replace indiscriminate prompt replay with compact records of analytical
   objects and definition changes. Keep original conventions and rounding rules
   explicitly available; a blanket character cutoff can lose them.
2. Retrieve the needed historical definition or dependency subgraph directly.
   Resolve named tables and version references before the model's calculation
   call when possible. Avoid importing whole task entries to find one formula.
   Bound retrieval response size and handle batching without model repair turns.
   Preserve exact selected source and full-precision values; semantic summaries
   alone would risk the Survey normalization and partial-rollback successes.
3. Reduce active observation overhead. Render the requested inspection once,
   with concise execution receipts for unaffected graph nodes. Investigate the
   large graph-status blocks on read-only first calls against the task-start
   snapshot before changing their semantics. Return complete small answer tables
   within the chosen output budget to avoid follow-up reads for omitted rows.
4. Keep stable memory records in the cached prefix and changing selections near
   the current question. Avoid reordering the stable prefix when selecting new
   evidence. Make generated programs easier to validate and batch so syntax,
   loader-arity and retrieval-limit repairs need fewer model calls.

The prior retrieval audit found that 149 of 163 inspected calls returned at
least one existing definition absent from selected task-start memory. That
supports improving selection, but is not proof that 149 calls can be removed.
The small exact-duplicate-code share also argues against claiming deduplication
alone solves the cost problem.

The user's 25% premium target allows $0.961262 against this first-pass baseline.
Entries needs a 29.4% reduction from its current cost; the candidate needs 47.7%.
Neither saving has been demonstrated. Future validation should preserve the
observed Survey 13/14/17/18/22 and NFL 26 behaviors, cover all six representative
tasks, and separately label any Python control with matched tool interfaces and
first-turn instructions. No new evaluations were launched for this audit.
