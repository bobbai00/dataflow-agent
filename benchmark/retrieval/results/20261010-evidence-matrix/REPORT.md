# Evidence matrix on KramaBench (2026-10-10)

## Verdict

Neither evidence option made the agent more accurate on KramaBench. Over the five models, the
baseline passed 366 of 520 attempts, +statistics 373, +flow 371 and +both 365. No model's difference
survives a correction for the 15 comparisons. For each model, the four settings give the same
outcome on 84 to 91 of the 104 tasks. Where they disagree, the disagreement follows the task, not
the setting.

Every dataflow setting beats the smolagents baseline: 365–373 passes against 325 of 520. smolagents
ran the day before, on the same tasks, files, models and judge. On the GPT models the margin is
large and we cost less: at baseline, Luna passes 18 more tasks at 0.72× smolagents' cost, Sol 13
more at 0.54× and Terra 6 more at 0.45×. On Opus 4.8 and DeepSeek the two agents are level (+2
each), and we cost 1.3× as much.

The two options do change cost, in opposite directions. The statistics settings cost 1–11% less per
task. They also make a five-row sample the default view, so receipts are 22–30% shorter. Flow
evidence costs 4–10% more, mostly because its guidance adds 2,658 characters to the system prompt,
which every call resends.

Telemetry worked. The offline audit of all 2,089 traced attempts found no violations and no
warnings, and all 13,621 executions carried their phase metrics. The runs surfaced six problems, and
all six are fixed (section 8). Nine affected attempts were rerun; one more is waiting for OpenAI
credit.

## 1. What was run

Every one of the 104 KramaBench tasks was run with five models in four settings, once each: 2,080
attempts. The agent is the one-tool agent on `feat/new-input-output-format`. It has a single
`dataflow({python, statements})` tool, and a reply without the tool is the answer. It was served on
:3088, with at most 25 model calls per task and `MODEL_RETRIES_PER_TURN=2`. The harness is
KramaBench `608e9fe`, and each task sees only its own files (`--use_truth_subset`). The harness lock
fix from section 8 (now KramaBench `e0a1c61`) went in at 01:29 and does not change scoring. The run
directories are named `20261011-matrix-*`, although the runs took place on 2026-10-10 local time
(01:08–05:36).

| Model | Gateway model | Workers | Time limit per attempt |
|---|---|---|---|
| Luna | gpt-5.6-luna | 2 | 900 s |
| Terra | gpt-5.6-terra (medium reasoning) | 2 | 900 s |
| Sol | gpt-5.6-sol | 2 | 900 s |
| Opus 4.8 | claude-opus-4.8 | 2 | 900 s |
| DeepSeek | deepseek-v4.1-flash via OpenRouter | 3, then 2–3 per setting | 1,800 s |

**smolagents baseline.** These are the runs from the 2026-10-09 campaign
(`20261009-smolagents-*` in the campaign worktree's `benchmark/retrieval/runs/`): smolagents
`CodeAgent` with KramaBench's custom instructions, 25 steps, a 5,000-character limit on printed
output and a 1,200 s limit per attempt. It ran in a bubblewrap sandbox that holds only the task's
input files and has no network. DeepSeek's six timeouts were rerun at 1,800 s; one of the reruns
passed, and the reruns replace the originals, as in that day's report. It used the same 104 tasks,
the same file subset, the same gateway routes and the same evaluator and judge (gpt-5-mini, before
the outage). The task text is the same except for the final-answer instruction. The dataflow agent
is priced with the same frozen rates, applied to each recorded model response.

The settings differ only in what a result shows the agent:

| Setting | What `show result` can return | Flow lines | System prompt |
|---|---|---|---|
| baseline | `full` only: every record, within 5,000 characters | no | 13,185 chars |
| +statistics | default `sample_stats`: at most 5 records within 2,000 characters, plus column statistics within another 2,000; `full` on request | no | 14,450 chars |
| +flow | `full` only | yes | 15,843 chars |
| +both | as +statistics | yes | 17,108 chars |

A flow line reports what a built-in operator measured while it ran, including operators upstream of
the requested result. Statistics describe the requested table itself. This receipt excerpt from Luna
(+both, legal-easy-19) shows both:

```
## show result records
executed: records
result records (scan): 36 rows × 3 columns
- flow: Scan: 2 header cells of `2024_CSN_Fraud_Reports_by_Amount_Lost.csv` are blank.
columns: Fraud Reports by Amount Lost str, "Unnamed: 1" str, "Unnamed: 2" str
records: sample_stats; 5 of 36 rows, 3 of 3 columns (first and last retained records; … marks omitted rows)
| Fraud Reports by Amount Lost | Unnamed: 1 | Unnamed: 2 |
| null | null | null |
| Number of Fraud Reports | 2,600,678 | null |
| … |
statistics: full table, 36 of 36 rows, 3 of 3 columns
| column | type | nulls | distinct | values |
| Unnamed: 2 | str | 35 | 1 | all: 38% of the total 1 |
- note: full table: duplicate rows=4, all-null rows=5, all-null columns=[].
```

Other flow lines that were common in these runs:

- "input column "Organism" was read by no operator on the way here; over the 63160 rows reduced it
  is "Enterococci":37770, "E. Coli":25390."
- "right eligible unmatched-key examples (not exhaustive): ["ARAF"] × 1; ["BCR"] × 1."
- "Union input rows=[14968,14956,15243], sum=45167, output=45167."

**Code during the runs.** The runs started on `76288867c`. They were paused at 01:33 for three
fixes (`a8bea121d`, `6885e4f19`, `2107f0352`) and resumed at 01:44 on `2107f0352`. The sandbox guard
(`e8af5de69`) went into the engine's Python wrapper at 02:22. These attempts started before the
pause: Luna 87, Terra 100, Sol 76, Opus 63 and DeepSeek 16, out of about 416 per model. Each fix
matters only in a narrow case: a column name with a leading or trailing space, several tool calls in
one response, a nearly spent step budget, or model code that searches the disk. Every attempt
started before a fix that hit its case was rerun after the fix (9 reruns), with one exception
(section 9). DeepSeek takes about five minutes per task. To add workers, its remaining tasks moved
to per-setting runners at 02:47 and 03:37, and the two slowest settings split once more at 04:33.

## 2. Accuracy

Each cell gives the passes out of 104. In brackets are the tasks gained and lost against the same
model's baseline, and the exact McNemar p-value. Timeouts count as failures.

| Model | smolagents | baseline | +statistics | +flow | +both |
|---|---|---|---|---|---|
| Luna | 57 | **75** | **73** (+4/−6, p=0.75) | **71** (+4/−8, p=0.39) | **67** (+2/−10, p=0.04) |
| Terra | 63 | **69** | **72** (+8/−5, p=0.58) | **75** (+8/−2, p=0.11) | **71** (+5/−3, p=0.73) |
| Sol | 61 | **74** | **76** (+4/−2, p=0.69) | **78** (+5/−1, p=0.22) | **74** (+4/−4, p=1.00) |
| Opus 4.8 | 73 | **75** | **74** (+4/−5, p=1.00) | **74** (+2/−3, p=1.00) | **78** (+6/−3, p=0.51) |
| DeepSeek | 71 | **73** | **78** (+7/−2, p=0.18) | **73** (+7/−7, p=1.00) | **75** (+6/−4, p=0.75) |
| All five (of 520) | 325 | **366** | **373** | **371** | **365** |

With 15 comparisons, a difference needs p < 0.0033 to count, and none comes close. The smallest
p-value is Luna with both options, 0.04 (2 gained, 10 lost). Pooled over the five models, the
options change little: +statistics gains 27 tasks and loses 20 (p=0.38), +flow gains 26 and loses
21 (p=0.56), and +both gains 23 and loses 24 (p=1.00). Earlier KramaBench campaigns with Luna
measured a standard deviation of about 3 points between repeated runs of the same setting. That
puts the noise on the difference between two runs at about 4 points, and every difference in this
table is within two of those.

**Against smolagents.** The paired comparison uses the same 104 tasks per model. In each cell
below, the first number counts tasks only the dataflow agent passed, the second counts tasks only
smolagents passed, and p is the exact McNemar p-value. With 20 comparisons, a result needs
p < 0.0025 to count.

| Model | baseline | +statistics | +flow | +both |
|---|---|---|---|---|
| Luna | +24/−6, p=0.001 | +22/−6, p=0.004 | +21/−7, p=0.01 | +18/−8, p=0.08 |
| Terra | +13/−7, p=0.26 | +16/−7, p=0.09 | +18/−6, p=0.02 | +15/−7, p=0.13 |
| Sol | +17/−4, p=0.007 | +19/−4, p=0.003 | +20/−3, p=0.0005 | +17/−4, p=0.007 |
| Opus 4.8 | +5/−3, p=0.73 | +4/−3, p=1.00 | +4/−3, p=1.00 | +8/−3, p=0.23 |
| DeepSeek | +6/−4, p=0.75 | +9/−2, p=0.07 | +7/−5, p=0.77 | +9/−5, p=0.42 |

Pooled over the five models, the baseline passes 65 tasks that smolagents fails and fails 24 that
smolagents passes (p=0.00002). The other three settings give the same picture. Two cells clear the
corrected threshold on their own: Luna at baseline and Sol with flow. Every Luna and Sol cell
favours the dataflow agent. The runs are one repetition each, and smolagents ran a day earlier,
so provider drift between the days is not controlled.

## 3. Where the settings disagree

Over all 20 model-and-setting combinations, 48 tasks pass every time and 15 fail every time. The
141 flips against a baseline land on only 39 tasks, and 60% of them land on twelve. These tasks
sit on a boundary that any small change pushes one way or the other. Here is Luna on three of them:

| Task | Gold | baseline | +statistics | +flow | +both |
|---|---|---|---|---|---|
| biomedical-easy-2 (average age, serous tumors) | 68.5 | 68.5 | 68.1 | 68.1 | 68.1 |
| environment-easy-3 (beaches worse in 2013 than 2012) | 268 | 268 | 267 | 267 | 267 |
| astronomy-easy-6 (semi-major axis decay, km/day) | [0.0193, −0.0020] | [0.0193, −0.0020] | same | [−0.0193, 0.0020] | [−0.0193, 0.0020] |

Each miss is one inclusion decision or one sign convention. The same tasks flip the other way for
other models: Sol and DeepSeek both gain biomedical-easy-2, with flow and with statistics.

The 2×2 design allows a sharper test. Each model ran two settings with flow and two without. If
flow helps, some tasks should pass in both flow settings and fail in both of the others. Over the
five models, 2 tasks follow that pattern in flow's favour and 4 against it. For statistics the
count is 3 and 3.

## 4. Cost

| Model | smolagents | baseline | +statistics | +flow | +both |
|---|---|---|---|---|---|
| Luna | $0.0041 | $0.0030 (0.72×) | $0.0027 (−8%) | $0.0032 (+9%) | $0.0031 (+3%) |
| Terra | $0.0600 | $0.0268 (0.45×) | $0.0240 (−11%) | $0.0279 (+4%) | $0.0260 (−3%) |
| Sol | $0.0995 | $0.0538 (0.54×) | $0.0494 (−8%) | $0.0583 (+8%) | $0.0501 (−7%) |
| Opus 4.8 | $0.0872 | $0.1144 (1.31×) | $0.1128 (−1%) | $0.1240 (+8%) | $0.1212 (+6%) |
| DeepSeek | $0.0145 | $0.0191 (1.32×) | $0.0187 (−2%) | $0.0210 (+10%) | $0.0167 (−13%) |

The baseline column shows the cost relative to smolagents. The evidence columns show the change
from the dataflow baseline.

| Model | Calls per task (base / stat / flow / both; smolagents) | Input tokens per task, thousands | Output tokens per task (baseline; smolagents) | Input read from cache |
|---|---|---|---|---|
| Luna | 4.58 / 4.70 / 4.72 / 4.85; 5.00 | 31.3 / 30.0 / 35.5 / 35.5; 25.7 | 1,175; 2,438 | 83% / 86% / 84% / 87%; 88% |
| Terra | 4.20 / 4.26 / 4.11 / 4.25; 5.42 | 27.4 / 25.5 / 29.5 / 28.2; 28.0 | 1,039; 3,908 | 82% / 85% / 83% / 86%; 88% |
| Sol | 4.20 / 4.40 / 4.38 / 4.39; 5.82 | 28.8 / 28.2 / 33.4 / 30.2; 34.7 | 1,157; 3,367 | 82% / 85% / 83% / 86%; 89% |
| Opus 4.8 | 5.30 / 5.91 / 5.40 / 5.88; 6.95 | 56.1 / 59.5 / 62.0 / 66.7; 59.4 | 1,587; 1,162 | 86% / 89% / 86% / 89%; 92% |
| DeepSeek | 9.81 / 10.17 / 9.47 / 9.97; 11.29 | 133.1 / 123.9 / 134.1 / 121.8; 94.4 | 11,507; 8,673 | 88% / 89% / 87% / 89%; 87% |

On the GPT models, smolagents writes two to four times as many output tokens per task, about half
of them hidden reasoning. Output costs five to six times as much as input on these models and makes
up 68–78% of smolagents' bill, which is why we cost 45–72% of smolagents there. Opus is the other
way round. Each of our calls adds a receipt that has to be written to the prompt cache, at 1.25×
the input rate: 8,110 cache-write tokens per task against smolagents' 4,939. We also write more
output, 1,587 tokens against 1,162. On DeepSeek we generate more reasoning, 9,047 tokens per task
against 7,066.

The statistics settings change two things at once: they add statistics, and they make the 2,000-
character sample the default view in place of the 5,000-character full view. The agent read
`sample_stats` in 30–54% of its reads, and an average receipt got 22–30% shorter. That is where the
saving comes from. Opus is the exception: it made more calls with statistics (5.91 against 5.30),
which used up most of the saving. Flow lines make receipts only 4–6% longer. Most of the flow
overhead is the 2,658 characters of flow guidance, which every call resends, although mostly from
the cache.

The 2,080 attempts in the table cost $91: Opus $49.12, Sol $22.01, Terra $10.90, DeepSeek $7.86
and Luna $1.25. Costs are frozen-rate estimates from the recorded usage. In 14 attempts at least one
model request has no recorded usage, because it timed out at the gateway or was in flight when the
time limit stopped the attempt. Those attempts are priced from their known requests only, so their
costs are lower bounds.

## 5. Did the evidence reach the model?

Yes, and only in the settings that enable it. The audit reads every receipt that a later model
request actually carried.

| Model | Receipts with flow lines (+flow / +both) | Receipts with statistics (+statistics / +both) | Reads that chose `sample_stats` |
|---|---|---|---|
| Luna | 30% / 36% | 33% / 34% | 44% |
| Terra | 25% / 30% | 43% / 40% | 50% |
| Sol | 37% / 37% | 44% / 43% | 50% |
| Opus 4.8 | 40% / 40% | 43% / 40% | 54% |
| DeepSeek | 28% / 30% | 23% / 24% | 30% |

In every setting where an option is off, the count of flow lines or statistics is 0.

## 6. Telemetry

- **Offline audit** (`matrix_audit.py`, 2,089 traced attempts): 0 violations and 0 warnings. It
  checked that the tool was offered without forcing it and with parallel calls disabled, and that
  each request repeated the previous one unchanged before adding to it (9,987 checks). It checked
  that no flow text or statistics appeared where the setting disables them, that no internal
  telemetry leaked into a receipt, and that every "full table" statistics caption was true.
- **Execution telemetry:** 13,621 executions, every one with its phase metrics.
- **Wire capture:** 12,076 model requests recorded. Sixteen have no usage: 9 were cancelled when the
  time limit stopped their attempt, 4 were gateway timeouts (504) and 3 were client timeouts. The
  agent retried the timed-out requests.
- **Timeouts:** 13 attempts (DeepSeek 11, Luna 1, Terra 1). Seven of DeepSeek's are astronomy
  tasks. The others are wildfire-hard-19 twice, environment-hard-10 and legal-hard-29. All made 19
  to 25 calls with 280k to 730k input tokens. Nine of them were still waiting for a model reply when
  time ran out (DeepSeek takes about 90 s per reply at that length). The Luna and Terra timeouts are
  both astronomy-hard-11: a pymsis atmosphere-model computation over a year of satellite data was
  still running in the engine.
- **Replies cut at the output limit:** 3 of 12,076 responses, all DeepSeek, all text replies at
  8,192 tokens. Each attempt ended with no answer. Two of them are in the final table.
- **Unanswered attempts in the audit count:** the agent records a stopped turn as an ending step
  with the text "Generation stopped by user.". The audit had counted that step as an answer. It no
  longer does (`6fbae3800`). The scores were never affected.

## 7. Resources

- **Memory** (31 GB RAM and 30 GB swap). A guard paused new attempts whenever available memory
  fell below 4 GB. It paused 11 times, for 136 s in total; the longest pause was 50 s. Four times,
  available memory fell to 0.8–1.4 GB. Each time the cause was one engine Python worker running
  Terra's wildfire-hard-19. The guard killed three of these workers, which held 8.5–16.1 GB, and I
  killed the fourth by hand. Each time, the attempt saw an execution error and still finished with
  an answer, and the engine stayed up. Swap use held at 13–14 GB.
- **Disk:** the matrix runs take 6.2 GB, the engine's result store 6.0 GB (on /home) and the wire
  capture 0.8 GB. Free space at the end was 39 GB on / and 91 GB on /home.

## 8. Problems found during the runs, and their fixes

1. **Column names with a trailing space could not be selected** (`a8bea121d`).
   `show result desc["Variable Name "]` dropped the trailing space, so the column was not found. It
   hit Opus and Sol on wildfire-hard-20. Only whitespace outside the quotes is trimmed now. The
   Opus attempt was rerun; the Sol attempt still waits (section 9).
2. **Several tool calls in one response broke the step** (`6885e4f19`). DeepSeek sometimes splits
   one step into a statements call that uses a predicate and a definitions call that defines it.
   It does this even though parallel calls are disabled: 217 responses in these runs. Each call ran
   as its own batch. The first failed, and every later call then failed with the internal error
   "Cannot change a completed snapshot". The calls of one response now run as one call: definitions
   register first, then the edits, then the requests. The six DeepSeek attempts with that error
   were rerun. After the fix, 201 responses took this path, and the error never came back.
3. **The step-budget reminders named the removed Answer action** (`2107f0352`). They now ask for
   the final reply without the tool. One affected DeepSeek attempt was rerun.
4. **Model code read other attempts' results** (`e8af5de69`). The engine's result store holds every
   attempt's tables, and each Python worker can reach it. On astronomy-easy-6 (+both), DeepSeek
   walked the directory tree, found the store and read result tables that other attempts of the
   same task had saved. On astronomy-easy-5 (baseline), it listed the store's files while searching
   for library code. A startup hook in every worker now refuses three things while model code is
   running: listing directories outside the task data, reading the store, and starting processes.
   Both attempts were rerun. After deployment, the hook
   refused two more searches (astronomy-hard-12 listed a directory; astronomy-easy-5 tried to start
   a process). A scan of all 12,076 responses finds paths to the store only in the two rerun
   attempts. Before the hook, no other attempt walked directories.
5. **The KramaBench harness raced on its shared results file** (KramaBench `e0a1c61`). Concurrent
   evaluations rewrote `results/aggregated_results.csv` without a lock, so one of them read an
   empty file and exited 1 after scoring. This happened once (Opus, +both, environment-hard-19),
   and the score was already saved. The rewrite now holds a lock and replaces the file atomically.
   The paraphrase verdict cache merges with the file on disk under a lock.
6. **The audit skipped timed-out attempts** (`6fbae3800`). A stopped harness leaves no trace file,
   or a truncated one, so the audit skipped 10 timed-out attempts and failed on one truncated trace.
   It now reads the runner's watchdog copy of the trace. It also stops counting the stop step as an
   answer (section 6).

**The judge went down at 04:03.** Both OpenAI keys, the judge key in KramaBench's `.env` and the
gateway's key, ran out of credit. By then Luna, Terra and Sol had finished. Four DeepSeek answers
to string questions were left without a verdict: wildfire-hard-18 in three settings and
astronomy-easy-4 (+both). The same judge model, gpt-5-mini, judged them through OpenRouter: two
pass and two fail. Each is marked `"judge_route": "openrouter:openai/gpt-5-mini"` in its
`evaluation-rescored.json`. Their verdicts went to a separate cache, not KramaBench's fixture.

## 9. Open items

- **Sol rerun of wildfire-hard-20 (baseline).** The quoted-column bug hit this attempt, but it still
  passed. The rerun needs OpenAI credit.
- **Judge the four DeepSeek answers again with the OpenAI key** once credit returns.
- **`091c736cb` is not exercised.** A reply cut at the output limit now gets one correction instead
  of ending the turn without an answer. The fix is unit-tested but was not deployed in these runs,
  and only 3 of 12,076 responses would have needed it.
- **One worker can still take the machine's memory.** Terra's wildfire-hard-19 code asks for 8–16
  GB in one worker, and only the external guard stopped it. A memory limit per worker in the
  engine's Python wrapper would turn this into a `MemoryError` for that attempt.
- **DeepSeek is slow on long tasks:** 11 timeouts at 1,800 s, 7 of them on astronomy tasks, all
  after 19 or more calls.
- **KramaBench has 50 failing tests** in `tests/`, all in the native pilot suites. A clean `608e9fe`
  checkout fails 52, so these failures predate this work, and they were not touched here.

## Appendix: how the table was built

The table comes from the runners' `progress.json` and each attempt's `stats.json`. Each of the nine
reruns replaces the original attempt for its model, setting and task. The four re-judged answers use
their `evaluation-rescored.json`. An attempt passes when the best of KramaBench's headline metrics
(success, llm_paraphrase, rae_score, f1, f1_approximate) is 1. `matrix-final.json` in this directory
holds every cell, including per-task passes, gained and lost lists, timeouts, reruns and
lower-bound cost counts.

Run directories, under `benchmark/retrieval/runs/`:

- `20261011-matrix-{luna,terra,sol,opus48}`: one runner per model, all four settings.
- `20261011-matrix-deepseek`: stopped at 02:47, after 61 attempts.
- `20261011-matrix-deepseek-<setting>-rest{1,2,3}`: the rest of DeepSeek. `rest1` of
  `evidence_full_flow0` and `evidence_full_flow1` were stopped at 04:33, after 31 attempts each, and
  continued in `rest3`.
- `20261011-matrix-rerun-*`: the nine reruns.
- smolagents: `20261009-smolagents-{luna,terra,sol,opus48,deepseek41flash}` and
  `20261009-smolagents-deepseek41flash-rerun1800`, in the campaign worktree's
  `benchmark/retrieval/runs/`.
