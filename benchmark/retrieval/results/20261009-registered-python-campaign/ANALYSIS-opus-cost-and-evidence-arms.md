# Opus cost and evidence arms — analysis of the 2026-10-09 KramaBench campaign

Scope: GPT-5.6 Luna, GPT-5.6 Terra and Claude Opus 4.8. The dataflow agent ran at campaign revision
e8bd686e3 in four evidence arms (none, stats, flow, both). The smolagents `CodeAgent` baseline ran once
per model. Each cell is one repetition of all 104 KramaBench tasks. Accuracy counts timeouts and unscored
attempts as failures. Cost is a frozen public-rate token estimate per task; cache reads and writes are
priced separately. All numbers come from the raw wire logs under `benchmark/retrieval/runs/20261009-*`
(merged as in `REPORT.md`). Analysis date: 2026-10-09.

## Summary

- **GPT (Luna, Terra):** the dataflow agent is more accurate than smolagents at equal cost (Luna) or 60%
  of the cost (Terra). We are cheaper because smolagents' GPT model spends 3–5× more hidden reasoning
  tokens, and on GPT output is the expensive part of the bill.
- **Opus costs 2× smolagents at about the same accuracy.**
  - It is not more calls: 7.4 vs 7.0 per task. Each call carries twice as much.
  - Three parts of similar size drive the gap: the fixed prefix, the observations and the model's own
    output.
  - Opus also wastes about half a call per task on malformed calls that our runtime rejects.
- **Evidence arms:** the differences between arms are inside rerun noise.
  - A trace review of 72 flipped tasks found only 4 caused by what a knob showed the model.
  - Flow cannot see inside the registered Python functions where GPT does its work.
  - When flow did show the deciding fact, the model usually ignored it.
- **Plan:**
  - Three cuts that do not touch what the model learns from bring Opus from $0.173–0.192 to about
    $0.150–0.163 per task (2.0–2.2× → 1.7–1.9× smolagents).
  - For the evidence: measure inside registered functions, and test whether the model reacts before
    building it.

## 1. Results

| Model | none | stats | flow | both | smolagents |
|---|---|---|---|---|---|
| Luna: accuracy | 62.5% | 62.5% | 59.6% | 63.5% | 54.8% |
| Luna: $/task | 0.0039 | 0.0038 | 0.0042 | 0.0042 | 0.0040 |
| Terra: accuracy | 68.3% | 63.5% | 67.3% | 71.2% | 60.6% |
| Terra: $/task | 0.034 | 0.036 | 0.036 | 0.036 | 0.058 |
| Opus 4.8: accuracy | 68.3% | 74.0% | 73.1% | 69.2% | 70.2% |
| Opus 4.8: $/task | 0.173 | 0.178 | 0.189 | 0.192 | 0.087 |

## 2. Why Opus costs 2× smolagents

### 2.1 Same number of calls, heavier calls

Opus makes 7.4 calls per task with our agent and 7.0 with smolagents. On the 13 tasks where both agents
passed in exactly the same number of calls, we still cost 2.08×. The median task costs $0.125 vs $0.051,
with the same median of 6 calls. The gap is spread evenly across tasks: our ten most expensive tasks are
27% of spend, against 35% for smolagents.

To attribute each dollar, every token is priced over its whole life:
- **Prefix** (system prompt, tool schema, task): read again on every call.
- **Observations**: written to cache once, then re-read on each later call.
- **Model output**: billed as output, then re-sent as history like an observation.

This accounting reproduces the measured cost within 0.3%.

| Per task, Opus | Ours (none arm) | smolagents |
|---|---|---|
| Calls | 7.41 | 6.95 |
| Prefix tokens (first call) | 11,343 | 5,184 |
| Observation tokens added per call | 912 | 535 |
| Output tokens per call | 326 | 167 |
| $ prefix | 0.046 | 0.021 |
| $ observations | 0.049 | 0.027 |
| $ output, incl. re-sends | 0.078 | 0.038 |
| **Total** | **0.173** | **0.087** |

The smolagents observation figure includes the tool-call text it echoes back into its history.

Lifetime price of one token on Opus (identical for both agents):
- 1k prefix tokens cost $0.004 per task.
- An observation token costs $8.5 per million.
- An output token costs $32 per million (the $25 output price plus the cache write and later re-reads).

**The cache is not the problem.**
- It is append-only: on 2,695 later calls, cache writes equal history growth exactly.
- The shared prefix hits the cache on 98–99% of first calls.

### 2.2 One task, end to end

legal-easy-19 asks for the share of fraud reporters who lost $1–$500. Both agents answered correctly in
3 calls; ours cost $0.055 and smolagents $0.027.

| Call | Ours: prompt / output tokens | smolagents: prompt / output tokens |
|---|---|---|
| 1 | 11,277 / 185 | 5,118 / 86 |
| 2 | 12,413 / 538 | 5,591 / 116 |
| 3 | 13,338 / 154 | 6,511 / 140 |

- **Call 1 already costs twice as much**, before either agent has done anything. Our prefix is the
  21k-character system prompt plus the 9k-character tool schema; smolagents' is a 14k-character prompt.
- **Our compute step is longer.** The prompt requires every final number to come from an operator, so
  Opus wrote a 13-line function with a docstring and a lookup helper (538 output tokens). smolagents added
  the five numbers it had printed in six lines (140 tokens).
- **The answer table is small.** It is three rows, wrapped in a receipt that prints the operator's shape,
  columns and "row selection inside Python is unknown; inspect its definition" twice: once under execute
  and once under retrieve.

### 2.3 The prefix: 11.3–12.1k tokens vs 5.2k

A fit of first-call prompt tokens against system-prompt and task length over 416 first calls (R² 0.994)
splits our prefix as follows:

| Part | Size | Tokens |
|---|---|---|
| System prompt | 20,902 chars (none) to 23,092 (both) | ≈ 6.9k–7.7k |
| `dataflow` tool schema + Anthropic's tool framing | 9,246 chars | ≈ 4.0k |
| Task message | ~870 chars | ≈ 0.35k |

smolagents' whole system prompt is 14,060 characters, about 4.8k tokens.

**Why the schema is so large.** `createRegisteredDataflowTool` (`agent-service/src/agent/tools/dataflow-actions.ts`)
builds the tool with `strict: true` for every provider. Strict mode allows no optional fields, so each
combination of optional fields becomes its own variant:
- `inspect schema` and `inspect source`, each with and without paging;
- `inspect graph` with and without IDs;
- `inspect namespace` with and without names;
- `execute` with and without IDs;
- `retrieve` with and without columns.

That gives 16 action variants, 10 of them `inspect` (5,224 of the 9,246 characters). Opus inspects about
1.3 times per task, but pays for the inspect schema on every call. Every ID string also carries a
full-match regex, `^[\s\S]*\S[\s\S]*$`, added for open-model decoders (13 copies).

### 2.4 Output: 326 tokens per call vs 167

A least-squares fit of output tokens against the size of each field of the tool call explains Opus's
output well: 3,008 single-tool-call responses, R² 0.986.

| Part of an Opus call | Tokens per call |
|---|---|
| Python code (0.50 tokens/char) | 111 |
| `changes` statements | 48 |
| `reasoning` field | 31 |
| Answer text | 14 |
| Per action (~20 tokens × 2.4 actions) | 48 |
| Fixed per tool call | 71 |
| **Total** | **323** |

smolagents writes code at the same rate (0.55 tokens/char): 126 tokens of code and 51 of thought per
call. The Python is the same size in both agents. Our extra ~160 tokens per call are protocol: the JSON
action wrapper and tool-call framing (~120) plus the `changes` statements (48).

### 2.5 Observations: 0.9–1.2k tokens per call vs 0.5k

In the none arm, an Opus observation averages 1,873 characters.
- **Data rows are only 47% of it.**
- **The rest is receipt text:**
  - "scope: … row selection inside Python is unknown" lines (9%);
  - column lists (9%);
  - edit receipts (6%);
  - headers, result shapes and execute summaries (about 20%).
- **Flow adds 376–390 characters per call (+17%).** Statistics tables add about 217 (+11%).

smolagents' observations are whatever the model printed, usually raw lines or a few values.

### 2.6 Rejected calls: an Opus-specific waste

| Per attempt | Opus | Luna | Terra |
|---|---|---|---|
| Rejected edits (`EDIT_REJECTED`) | 0.43 | 0.08 | 0.07 |
| Calls rejected by schema validation (`CALL_REJECTED`) | 0.34 | 0.005 | 0 |

OpenAI enforces the strict schema while generating, so GPT's calls are valid. On our Anthropic route,
Opus's calls are not constrained, and three shapes recur:

1. **`actions` sent as a JSON string instead of a list (101 calls).** In wildfire-hard-7 (both arm) and
   astronomy-hard-10 (stats arm) the repetition tripped the repeated-failure guard and ended the task.
2. **One edit split into two, in the wrong order (90 of the 124 "not a registered public function"
   errors).** Example from biomedical-hard-4:

   ```json
   {"type": "edit", "python": "", "changes": "set pep: filter(variants, predicate='is_peptide')"},
   {"type": "edit", "python": "def is_peptide(row):\n    return row['Peptide'] == 'HPKPEVLGSSADGALLVSLDGLR'", "changes": ""}
   ```

   Edits are validated one at a time, so the first fails with "'is_peptide' is not a registered public
   function" and everything after it is skipped. The next call sends the two merged into one edit, which
   works.
3. **`inspect` without a `target` (35 calls).**

Priced with the history each failed call leaves behind, these three shapes cost:

| Arm | Wasted calls per task | $/task | Share of cost |
|---|---|---|---|
| none | 0.47 | 0.012 | 6.9% |
| flow | 0.64 | 0.020 | 10.5% |
| stats | 0.54 | 0.015 | 8.5% |
| both | 0.53 | 0.015 | 7.8% |

### 2.7 Why GPT doesn't show the gap

| Output tokens per task | Ours (4 arms) | smolagents |
|---|---|---|
| Luna: total / hidden reasoning | 1,515–1,730 / 443–502 | 2,438 / 1,429 |
| Terra: total / hidden reasoning | 1,453–1,533 / 394–442 | 3,908 / 2,102 |
| Opus: total / hidden reasoning | 2,282–2,531 / 0 | 1,162 / 0 |

Neither agent sets a reasoning effort.
- **GPT:** smolagents' model reasons 3–5× more per task, and GPT output is priced 6× input. In the Terra
  none arm, output costs us $0.018 per task against $0.047 for smolagents. That outweighs our heavier
  input.
- **Opus:** it runs without thinking, so smolagents writes little and input volume decides the bill.
  Anthropic also bills cache writes at 1.25× the input rate.

## 3. Plan to cut Opus cost

All three steps leave what the model learns from unchanged.

| Step | Change | Before | After | Saves per task (none / both) |
|---|---|---|---|---|
| 1 | Accept two of the malformed shapes (1–2 in §2.6): read string `actions` as a list; commit consecutive edits in one call together, definitions first | 0.38 / 0.46 rejected calls per task | ~0 | $0.010 / $0.013 (measured) |
| 2 | Anthropic only: compact non-strict schema, one variant per action type, no regex, short descriptions | 9,246 chars ≈ 3,750 tokens per call | 2,143 chars ≈ 870 tokens | ≈ $0.011 (estimated) |
| 3 | Print each operator's block once per observation; drop the "row selection inside Python is unknown" line and flow pointer/boilerplate lines | 1,872 / 2,505 chars per observation | 1,718 / 2,164 | $0.0025 / $0.0054 (measured) |
| | **Total** | **$0.173 / $0.192** | **≈ $0.150 / $0.163** | **−13% / −15%** |

That takes us from 2.0–2.2× smolagents to about 1.7–1.9×.
- **Step 1's numbers come from replaying the actual failed calls.** In each case the model's next call
  sends the same content in the accepted shape.
- **Step 2 is an estimate.** It uses the first-call fit in §2.3 and assumes about 300 tokens of
  Anthropic tool framing; Anthropic's free token-count endpoint would confirm it. GPT and the open models
  keep the strict schema.
- **Step 3 comes from replaying all Opus observations.**

**Correction to an earlier claim.** The duplicated receipt blocks (step 3) are a small lever. I first
listed them among the largest; the replay shows $0.0025–0.0054 per task.

Two further cuts need an accuracy A/B first:
- **Make `reasoning` optional:** 31 output tokens per call, about $0.007 per task.
- **Shorten the system prompt:** $0.004 per task for every 1k tokens removed. The earlier lean-prompt
  A/B (10-06) both cut cost and raised Luna accuracy.

The remaining ~1.7× is the design itself:
- a 6.9k-token prompt against 4.8k;
- receipts and Markdown tables around every result;
- about 170 tokens of JSON actions and `changes` statements per call.

Closing that would take a protocol change, not a trim.

## 4. Do the flow and stats arms help or hurt?

### 4.1 The differences are the size of rerun noise

Four Luna runs of the same configuration differed only in display caps, which change accuracy by at most
3 points: both, both@100k, both@sample2k and both@basecaps. Between any two of them, 4–15 tasks flip
(mean 10.3), with net swings of +1 to +3. Against that:

| Comparison | Tasks flipped | Net |
|---|---|---|
| Luna none → flow | 13 | −3 |
| Luna stats → both | 13 | +1 |
| Terra none → flow | 11 | −1 |
| Terra stats → both | 10 | +8 |
| Terra none → stats | 13 | −5 |
| Opus none → flow | 5 | +5 |
| Opus stats → both | 7 | −5 |

No arm is consistently best. Terra's weakest arm (stats, 63.5%) sits next to its best (both, 71.2%), so
statistics are not reliably harmful either.

### 4.2 Trace review of 72 flipped tasks

The review covered every task where turning flow (or, for Terra, statistics) on or off changed pass/fail.
For each task:
- read the gold solution;
- walk both traces call by call, reading the code rather than the model's prose;
- find the first wrong decision;
- quote what the model had on screen at that point.

| Comparison | Flips | Caused by the knob's content | Grader or format quirk | Run-to-run luck |
|---|---|---|---|---|
| GPT, flow on vs off (Luna + Terra, 5 pairs) | 47 | 1 loss, 1 likely gain | 3 | 42 |
| Terra, none → stats | 13 | 2 losses | 1 | 10 |
| Opus, flow on vs off | 12 | 0 | 1 | 11 |

The failing decisions are misreadings of meaning that runs with the knob off make too:
- dropping "top" in "top report category";
- averaging over excluded patients;
- counting a metro area once per state file;
- reading the wrong column as ap;
- comparing a 26-year mean with a 25-year one;
- keying beaches by name only.

### 4.3 Why flow can't help GPT

GPT models put the computation into registered Python functions, which flow cannot see into.

| | Luna | Terra | Opus |
|---|---|---|---|
| Attempts whose only built-in is `scan` | 58–74% | 49–66% | 23–31% |
| Non-scan built-in operators per attempt | 0.6–1.2 | 0.8–1.4 | 2.6–3.0 |

For a registered function, flow can only say "input rows=[N], output=M; row/column mapping unknown"
(`evidence.ts`). About 70–75% of the 14–17 flow lines per GPT attempt are this kind of boilerplate:
"mapping unknown", "see action N", or "files selected=1/1". Seven of the eight Luna losses with flow on
went wrong inside a Python function. The informative lines (filter kept/rejected, join unmatched) arrive
after the deciding code is already written.

The scan header hint is the most actionable flow line. On the tasks where it appeared, pass counts are
identical with and without flow: Luna 19/24 vs 19/24, Terra 20/24 vs 20/24, Opus 15/17 vs 15/17.

### 4.4 When flow showed the deciding fact, the model ignored it

There are at least five such cases.
- **Opus, legal-hard-1, both arm.** The join receipt listed
  `["nashville-davidson-murfreesboro-franklin, tn"]` as unmatched in four observations. The model's name
  normalizer kept the CSV's double hyphens, so Nashville (4,470 reports, over 1M people) dropped out. It
  answered 13,122.19; the gold is 12,964.87.
- **Opus, biomedical-easy-2, flow arm.** The receipt said twice: `input column "Case_excluded" was read
  by no operator on the way here; over the 14 rows reduced it is "No":12, "Yes":2`. The model averaged
  all 14 serous cases and answered 68.1; the gold is 68.5, over the 12 analyzed cases.
- **Luna, archeology-easy-11 (both@100k).** A filter receipt showed `kept=11138/44691` with three capital
  levels kept; the model kept the wrong filter.
- **Luna, legal-hard-2 (both@sample2k).** `per-group min=2, max=4` showed every metro area duplicated;
  the model summed the duplicates.
- **Luna, wildfire-hard-5 (flow).** `Filter kept=26/26` against `kept=25/42` showed misaligned years; the
  model answered anyway.

### 4.5 The losses the knobs did cause

- **Flow, Terra environment-hard-12.** The scan receipt said "skip_lines=2 gives the header … Tag,
  Enterococcus" for four single-site beach files. The model used that header for all eight files and
  skipped the raw-layout check the none arm ran. It read only the first of Wollaston's four sampling
  sites: 34 failing samples instead of 129. The both arm got the same hint, checked the other files and
  passed.
- **Statistics, Terra astronomy-hard-10.** The statistics showed a density range up to 9.99e+32, a fill
  value. The model dropped those rows, and r moved from −0.1934 to −0.1912; the gold applies no filter.
  The both arm saw the same line, masked the values instead of dropping rows, and passed.
- **Statistics, Terra wildfire-easy-3.** Coordinate ranges of ±538° pushed the model's recovery from an
  unrelated geometry error onto a workaround that undercounts Nevada.

The one gain that lines up with flow is Luna legal-hard-29. It passes in all 6 flow-on runs and fails in
both flow-off runs, but no flow line mentions Puerto Rico. The likely carrier is the flow paragraph in
the prompt ("compare these measurements with the requested population"); this is inferred, not shown.

### 4.6 Opus and the watch list

**Opus.** None of its 12 flips trace to flow content. Each is one arm deviating from the other three,
which is the pattern of luck, not of a knob.

**Worth a cheap rerun.** Three Luna legal tasks on the same metro-area files split along the flow knob
across 8 runs:
- legal-hard-29: passes 6/6 with flow, 0/2 without;
- legal-hard-1: 1/6 with flow, 2/2 without;
- legal-hard-2: 2/6 with flow, 2/2 without.

The traces do not explain them; five reruns per arm cost well under a dollar on Luna.

**Grader noise.** wildfire-hard-18 flipped on wording in four of the seven review groups: same numbers,
same conclusion, different verdict from the gpt-5-mini paraphrase judge.

## 5. What "measure inside registered functions" means

**Today flow measures only built-in operators.** When the engine runs `filter`, `join` or `cast`, it knows
what the operator does and counts kept and rejected rows, unmatched keys or failed conversions. A
registered function is a black box: the engine sees the tables going in and out, nothing more.

**Example: Luna, wildfire-hard-7, stats arm.**
- The whole analysis is one registered function, `wildfire_anomaly`. It melts the tables, converts the
  values, sums per area and year, computes z-scores and picks the top row.
- Line 11 is `long['acres'] = pd.to_numeric(long['acres'], errors='coerce')`. The files write acres as
  "3,512", so 540 of the 556 values silently became NaN.
- The function worked from the 16 values that survived and answered "Northwest, 2001" with 394 acres.
  The gold is Northwest, 2020.
- The receipt said only "row selection inside Python is unknown; inspect its definition."

Had the conversion been a built-in `cast(errors="null")`, the receipt would have counted the failed
conversions with examples. Measuring inside means giving pandas calls in a registered function the same
measurement:

```
- flow: wildfire_anomaly, line 11: pd.to_numeric(errors="coerce") turned 540 of 556 non-null "acres" values into NaN, e.g. "3,512", "11,843", "663,564".
```

**The hook already exists.** `_ProcessTrace` in `agent-service/src/agent/native/python/runtime.py` wraps
`read_csv`, `merge`, boolean row selection and `concat` while a registered function runs.
- It records only selections and merges that return zero rows, and rows duplicated across stacked files.
- Those lines reach the model only when `nativeChecks` is on (`dataflow-action-runtime.ts:756`), and it
  was off in this campaign.

Extending it means also recording:
- values a conversion turned to null;
- rows a selection kept and dropped, with the most common dropped values;
- keys a merge failed to match;
- input columns the function never read.

**Measuring is only half the fix (§4.4).** Before building it, test whether the model reacts:
1. Take the failed traces where such a line would have shown the bug.
2. Insert the line at that call and resample the model's next call a few times.
3. If the model usually fixes the bug, build it. If not, the warning has to block the answer rather than
   sit in the receipt. The 2026-09-28 check-line A/B shows that false alarms cost accuracy, so such a
   block must be precise.

## 6. Next steps

1. **Don't choose an arm from one repetition.** Run at least 3 per arm; that costs about $0.41 per arm on
   Luna and $3.64 on Terra.
2. **Apply the three Opus cuts in §3.** Confirm step 2 with a token count, then rerun a subset of tasks.
3. **Prototype in-function measurement** by extending `_ProcessTrace`, and run the uptake test before a
   campaign.
4. **Rerun the three watch-list tasks** (§4.6) five times per arm on Luna.

## Appendix: evidence and method

- **Per-task reviews:** `flip-reviews/flip-report-g1.md` … `g7.md` in this directory, one section per
  flipped task with the gold plan, the first wrong decision and quoted context.
  - g1: Luna none→flow losses;
  - g2: Luna none→flow gains and stats→both losses;
  - g3: Luna stats→both gains;
  - g4: Terra none→flow;
  - g5: Terra stats→both;
  - g6: Terra none→stats;
  - g7: Opus.
- **Measurements:** made with ad hoc scripts in the analysis session's scratchpad, which may since have
  been cleaned. Each number above names its source: wire request/response pairs, `react_steps.json`, or
  the gold solutions under `benchmark/Kramabench/solutions/`.
  - per-call usage from wire logs;
  - lifetime cost attribution;
  - output and first-call regressions;
  - observation line classes and replay;
  - rejected-call classes;
  - operator mix;
  - flow-line classes.
