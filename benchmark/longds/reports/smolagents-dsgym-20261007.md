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

# smolagents and the DSGym agent on the five Lite sessions, 2026-10-07

## Verdict

On Terra, both off-the-shelf script agents answered more questions right
than our dataflow agent: the benchmark's own DSGym agent 126 of 185,
smolagents 104 (stock prompt) and 112 (KramaBench's custom prompt), against
a mean of 86 over four dataflow runs. smolagents with its stock prompt is
also cheaper: $8.73 against $10.16 to $10.63. On Luna the agents score 44
to 57 against a dataflow mean of 40 (runs from 29 to 48); no gap reaches two
standard errors, and ours costs the most.

## Setup

Same five sessions as the scale-5 and regression runs (Kiva 1, Netflix 2,
NFL 1, Marmara 1, WiDS 3; 185 questions), same prepared inputs and gold, same
judge (`deepseek/deepseek-v4-pro`, upstream rubric), one attempt per
question, gateway rates with the cache discount.

- **smolagents** (`smolagents_session.py`): one `CodeAgent` per session, as
  the KramaBench harness builds it (its model wrapper, authorized imports,
  `open`, no tools), continued across requests (`reset=False`) so the
  conversation and the Python variables persist. smolagents 1.23.0 defaults:
  stock system prompt, 20 steps per request. Each request is worded as the
  benchmark words it, `context` then `Question: question`; the first also
  says where the data is, as DSGym's system prompt does. The model's code
  runs in smolagents' own interpreter inside the LongDS sandbox (only the
  session's data, read-only; no network; 6 GB address space).
- **smolagents, guided**: the same plus KramaBench's `CUSTOM_INSTRUCTIONS`.
- **DSGym** (`dsgym_agent.py`): upstream's `MultiTurnReActDSAgent`, its
  prompt, `<python>`/`<answer>` protocol and 40 steps a request, on the
  sandboxed persistent kernel. Gold answers enter only its result records.
- **Dataflow** and **Python catalog**: from the scale-5 run and the
  regression study (`regression-study-20261007.md`); our task text, not the
  benchmark's.

## Results

| Terra, correct of 185 | Kiva (37) | Netflix (34) | NFL (42) | Marmara (36) | WiDS (36) | Total | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dataflow, mean of 4 runs (101, 79, 82, 81) | 17.3 | 9.3 | 24.0 | 19.0 | 16.3 | **85.8** | $10.36 |
| Python catalog, 1 run | 31 | 12 | 32 | 16 | 9 | **100** | $8.72 |
| smolagents, stock prompt | 24 | 9 | 36 | 24 | 11 | **104** | $8.73 |
| smolagents, KramaBench prompt | 23 | 12 | 25 | 26 | 26 | **112** | $12.70 |
| DSGym agent | 31 | 12 | 25 | 29 | 29 | **126** | $11.71 |

| Luna, correct of 185 | Kiva | Netflix | NFL | Marmara | WiDS | Total | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dataflow, mean of 4 runs (47, 34, 48, 29) | 6.3 | 4.8 | 11.0 | 9.3 | 8.3 | **39.5** | $1.35 |
| Python catalog, 1 run | 14 | 14 | 3 | 17 | 9 | **57** | $1.07 |
| smolagents, stock prompt | 11 | 1 | 8 | 14 | 11 | **45** | $0.95 |
| smolagents, KramaBench prompt | 10 | 8 | 2 | 13 | 12 | **45** | $1.03 |
| DSGym agent | 6 | 3 | 17 | 6 | 12 | **44** | $0.65 |

A single run's 5-session total moves by about 11 questions on Terra and 9
on Luna with nothing changed (regression study). Against the four-run
dataflow mean, a single run's lead has a standard error of about 12: DSGym's
+40 is about 3.4 of them, smolagents' +18 and +26 are 1.5 and 2.2. On Luna
the standard error is about 10.5; the largest gap, our Python catalog's +17.5,
is 1.7 of them.

### Where the cost goes (Terra)

| | Calls per question | Input per call | Cached | Output per question | Cost per correct answer |
|---|---:|---:|---:|---:|---:|
| Dataflow (4 runs) | 3.5 | 31,300 | 94% | 1,850 | $0.121 |
| smolagents, stock | 1.6 | 65,600 | 96% | 1,521 | $0.084 |
| smolagents, KramaBench prompt | 2.8 | 69,100 | 98% | 1,795 | $0.113 |
| DSGym agent | 3.0 | 48,600 | 97% | 2,005 | $0.093 |

smolagents keeps the whole conversation, code and printed output included,
and never compacts: its first call of a request carries 23,000 tokens in
questions 1 to 9 and 117,000 from question 30 on (Luna 143,000). It is
cheaper because it makes half as many calls: with the stock prompt, 102 of
185 Terra requests are one code block that computes and calls
`final_answer`. The KramaBench instructions ("one operation per step")
bring that to 27 of 185, cost 45% more and gain 8 questions, within the
noise. Because its context keeps growing with the session, the cost advantage
shrinks on longer sessions.

DSGym on Luna answered 72 of 185 requests in its first response, before
seeing any result of its code, the Luna behaviour seen before; on Terra 18.

## Notes

- One smolagents-guided Terra session was ended at its first question by the
  machine's out-of-memory daemon (9 GB, before the interpreter had a memory
  cap); it was set aside (`baseline/lost/`, $0.07) and rerun with the cap.
  All 30 sessions completed every question.
- Spend: $35.86 for the runs (smoke test and lost attempt included), $2.04
  for judging.
- Material: `logs/smolagents-20261007/` (run root, per-question traces,
  `analyze.py`). Driver: `baseline_pilot.py`.
