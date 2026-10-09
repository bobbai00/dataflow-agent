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

# Slimmer task entries and a shorter prompt on the Kiva Lite session, 2026-10-07

## Verdict

Both changes work and keep every rule. Input per call fell 14% for Terra and
7% for Luna, and both agents read earlier definitions a third less often.
Cost did not fall for Terra, for two reasons outside the change: the provider
dropped its cached prefix three times mid-session, and Terra wrote 15% more
output. Accuracy moved within the noise of one rep: Terra 23 of 37 (previous
run 18, Python 23), Luna 10 of 37 (previous run 13, Python 10 of 35).

Build 13db85d68 against the previous run on 8503423d1 (same session, models,
judge and settings; one rep each):

| Kiva, 37 questions | Luna before | Luna after | Terra before | Terra after |
|---|---:|---:|---:|---:|
| Correct | 13 | 10 | 18 | 23 |
| Cost | $0.33 | $0.29 | $2.29 | $2.31 |
| Model calls | 219 | 168 | 143 | 139 |
| Input tokens per call | 36,280 | 33,830 | 38,690 | 33,385 |
| Cache hit rate | 96% | 93% | 95% | 93% |
| Output tokens per question | 2,556 | 2,212 | 1,598 | 1,831 |
| Calls that only read definitions | 35 | 19 | 28 | 18 |
| Held statements | 7 | 1 | 8 | 2 |

For the same session, Python costs $1.93 (Terra) and $0.25 (Luna) once its
recorded cost is repriced with fair caching.

## What changed

**Task entries.** A step whose columns follow from its first input's now
says so instead of repeating the list: `columns: same as `scores``, or
`same as `restored_country_sector_pressure`; plus funding_strain_no_wait
float64, no_wait_pressure float64`. The list stays wherever it is shorter or
the column order changes. The signature line (the definition already shows
every setting) and the scope line (a limit's definition says what it selects)
are gone. Code stays hidden.

| Entry text at the last question | Luna before | Luna after | Terra before | Terra after |
|---|---:|---:|---:|---:|
| Characters per task | 3,232 | 2,801 | 4,357 | 3,802 |
| Characters per operator | 739 | 415 | 722 | 562 |
| Column lines per operator | 305 | 117 | 332 | 140 |
| Column lines' share of the entries | 28% | 21% | 35% | 18% |

Per task the saving is smaller than per operator, because Luna built 5.1
operators per task instead of 3.0, more of them catalog joins, projects and
maps. Terra's definitions grew from 154 to 234 characters per operator, from
longer filter and map lambdas.

**System prompt.** 8,781 to 7,924 tokens (38.2k to 33.9k characters); the
single-task prompt goes from 7,346 to 6,979. Every rule is kept: rules that
were stated two or three times now appear once (keep the complete table and
cut with `limit`; how to answer from a table; read an earlier definition
before reuse; what the execute receipt compares), diff's output columns moved
into its catalog entry, and one-input operators lost the `Inputs:` line their
signature already gives. A sentence-by-sentence comparison of the two prompts
found one remedy dropped by the first draft (cut tables over 50 rows with
`limit`), which is back.

## Where Terra's cost went

| Terra, change in cost | |
|---|---:|
| Cached input (5.27M to 4.32M tokens) | −$0.19 |
| Fresh input from three provider cache misses | +$0.11 |
| Output (59.1k to 67.7k tokens) | +$0.10 |
| Net | +$0.02 |

The misses came 9 to 19 seconds after the previous call, so they were not
expiry. After each one, the next call found only the system prompt cached.
The previous run had none after question 1. Counting an ordinary call in
place of each miss, fresh input is flat for Terra (261k tokens before and
after) and lower for Luna (344k before, 290k after). Neither arm sends OpenAI a per-session
`prompt_cache_key`, which is meant to keep a session's requests on one cache.

## Health

All 74 questions completed. Column-name errors rose (Luna 6 to 11, Terra 0 to
3). The ones traced were slips in the agents' own code: a guessed column name
in a 78-column table, whose column list is cut at 16 in both builds, and a
pandas merge whose suffixes never applied. None came from a `same as` line.

Two defects turned up and are fixed:

- **The history example's execute receipt showed only its header.** The
  example filter dropped the `changed since` lines that real receipts report.
  Fixed before the run (13db85d68).
- **An edit with a held statement was left out of the task entry.** The edit
  reports an error so the call stops, but its other statements apply. The
  entry skipped it, so in question 1 Terra's `cleaned_loans` appeared as
  "updated" and after the tables that read it. An operator created that way
  and never touched again would be missing. Fixed after the run (b5d14b7d2);
  the previous run had the same defect.

Run root: `/var/tmp/versions-stateops-kiva3-20261007`.
