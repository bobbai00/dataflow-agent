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

# Several requests in one session

A native agent can serve a session of several requests, for example a LongDS
session of 32 or 42 dependent questions. Every request shares one Dataflow and
its registered functions. The setting `multiRequest` is decided before the
first request and kept for the session:

| `multiRequest` | earlier requests in the context | multi-request features |
|---|---|---|
| `off` (default) | their calls and observations, as one transcript | none: single-request prompt and receipts are unchanged |
| `transcript` | their calls and observations, as one transcript | yes |
| `catalog` | each earlier request's text, then one catalog entry | yes |

The features are prompt section 5 (working across requests), function
signatures in edit receipts, and notes on constant columns. `catalog` needs the
delta context with the native message layout; other combinations are refused.

## Why a catalog and not versions

An audit of the 24 Lite gold programs (777 cells) and of four NFL agent
traces found:

- **Versions are not needed.** Of 213 Rollback and Counterfactual turns in the
  gold, 150 (70%) build the alternative under a new name from state that still
  exists. Agents re-set a table from an earlier question once in 430 `set`
  statements. Rollbacks are compositional: 62 of the 89 that name an earlier
  state keep current parts too, so restoring a whole table's earlier version
  would revert what the question keeps.
- **Long-span reads are.** 82% of revisit turns read a named table from at
  least 10 questions back, and 52% from at least 20. A transcript keeps that
  table's columns hundreds of messages away; a catalog lists them in one entry.
- **Rule reuse is the gap.** 16% of the gold's Update, Rollback and
  Counterfactual turns call an earlier rule function with new settings, for
  example Netflix `country_credit('primary')`, then
  `('lead', lead_weight=0.6)`, then `0.8`. Agents called an earlier
  question's function 0 times and wrote 2.6 to 3.05 new functions per question.

## The catalog entry

An entry is what a request left in the Dataflow, read from two saved
snapshots: the state it inherited and the state it left. A finished request's
entry therefore never changes, and the context only grows at its end. In a
three-request Luna session, request 3's first call read 6,360 of its 7,521
input tokens from the cache: everything through request 2's text.

Request 2 of that Netflix session, as request 3 saw it (code shortened):

````text
## Task 2 (answered)
functions:
- `shared_market_opportunity(raw)` — Clean titles, assign equal fractional credit to each listed production country, and rank markets using the first-pass opportunity score.
```python
def shared_market_opportunity(raw):
    """Clean titles, assign equal fractional credit to ..."""
    ...
```
operators:
- **shared_market_top** (shared_market_opportunity, created)
  - definition: `set shared_market_top: shared_market_opportunity(raw_titles)`
  - inputs: `raw_titles` (task 1)
  - result: 5 rows × 7 columns
  - columns: market str, rank int64, score float64, scale_percentile float64, balance_percentile float64, expansion_percentile float64, title_credits float64
shown: `shared_market_top`
answer: {"markets":[{"market":"UK","score":0.7200, ...}],"entered":[],"fell_out":[]}
````

- **Functions**: one API line per public function the request registered or
  changed (signature and the docstring's first line), then the source of every
  binding it changed, in definition order. An operator block omits a
  signature listed in an earlier entry.
- **Operators**: the canonical blocks of `show operator`, in first-edit order,
  each with every column. A later step in a chain states its columns relative
  to its first input (`same as units; plus score float64`). An input the
  request did not touch names the earliest task that left it
  (`raw_titles (task 1)`).
- **State of an update**: `updated: min_orders 5 → 10` when only settings
  changed, `updated: restored task 1's version` when an earlier definition
  returns, and `updated: the definitions its function uses changed`.
- **Notes**: `empty table`, `limited table; its input has 8 rows`, `one-row aggregate`.
- `deleted:`, `shown:` (results it displayed), and `answer:`. A request that
  failed or was stopped is `incomplete`, with `answer: No completed answer.`;
  its last step carries `endReason`.

Entries carry no records: the model uses `show result` on an earlier table to
read its values.

## Receipts and checks

With several requests, an edit receipt names what a later call can vary:

```text
## edits applied
functions:
- eligible_units(orders, *, min_orders=5) registered
- tidy(table) updated (no settings)
```

An executed Python step that adds a column which is 0, or null, in every row of
a working table (at least 10 rows, profiled in full) gets a note:

```text
note: column "player_move" is 0 in all 86 rows.
```

On 2026-10-09 an NFL session ranked "largest gaps" that were all 0, and nearly
every later score inherited them. Constant labels, broadcast thresholds, small
answer tables, filters, built-ins and partial profiles get no note. The first
version took any single value and flagged 157 columns in the 2026-10-11 Luna
campaign, two thirds of them in tables of five rows or fewer; under the current
rule about 3 of those remain.

## Prompt

Section 5 says how to work across requests: write each rule as a small
function with its choices as keyword settings. To change a rule from now on,
set its operator again; to compare, give the variant a new ID. Keep earlier
tables. It shows one example in general terms (`eligible_units`, `unit_scores`). The full
catalog-mode prompt is generated as
[native-mode/SYSTEM_PROMPT_CATALOG.txt](../native-mode/SYSTEM_PROMPT_CATALOG.txt).

## Compact entries and recent requests

Two catalog settings, decided before the first request like `multiRequest`:

- `catalogSource: "docstring"` turns a documented public function into its
  signature and whole docstring (one paragraph, at most 300 characters), and a
  private helper into its signature. Source stays only for an undocumented
  function and for imports and constants; `show function <name>` reads any
  source. In the 2026-10-11 runs, 58 to 95% of the agent's functions had a
  docstring, with a median of 100 characters against 1.2k to 2.0k of source.
  Today's entries are 0.80 to 0.93× the size of the transcript they replace,
  and 38 to 43% of that is source.
- `catalogRecent: K` keeps the most recent K to 2K−1 requests as their full
  transcript; older ones become entries K at a time. With K = 5, requests 1–5
  become entries at request 11 and 6–10 at request 16. A window that moved by
  one request each time would change the context at every request, and the
  cache would be lost for every recent request after the change. Re-pricing
  the NFL transcript runs' own calls that way gives +24% (K = 5) and +51%
  (K = 10) against the transcript. Converting K at a time gives −2%, and −15%
  with docstring entries; output is held fixed in all of these estimates.

## Code

- `agent-service/src/agent/request-catalog.ts`: requests on the visible path
  and their entries, cached per snapshot storage.
- `agent-service/src/agent/util/context-utils.ts` (`catalogContext`): request
  1 under its heading, later requests as plain turns, then the current
  request's own transcript.
- `agent-service/src/agent/native/turn-receipt.ts`, `tools/dataflow-action-runtime.ts`:
  signatures in receipts.
- `agent-service/src/agent/native/checks.ts` (`constantColumnLines`): constant-column notes.
- `agent-service/src/agent/prompts/native-multi-request.md`: section 5.
- `benchmark/longds/`: the LongDS session runner, judge, behavior and report.

Tests: `request-catalog.test.ts` (a scripted three-request session: entry
text, byte-identical prefixes across requests, restores, changed functions,
failed requests, transcript mode, the setting guard), `checks.test.ts`,
`turn-receipt.test.ts`, `evidence-settings.test.ts`, and
`benchmark/longds/test_longds.py`.

## Results: GPT-5.6 Luna, 2026-10-11

Two LongDS Lite sessions, NFL task 1 (42 requests) and Netflix task 4 (32),
three repetitions of each arm, judged by deepseek-v4-pro. Run root
`/var/tmp/longds-catalog-luna-20261011` (commits f1a1b0e9c and 0d862fd2b, with
the first constant-column rule). Agent cost $3.66, judge $0.65.

| session | `off` | `transcript` | `catalog` |
|---|---|---|---|
| NFL (of 42) | 5, 9, 15 | 17, 19, 15 | 19, 14, 22 |
| Netflix (of 32) | 13, 12, 12 | 14, 12, 7 | 12, 3, 14 |
| both (of 222) | 66 (29.7%) | 84 (37.8%) | 84 (37.8%) |
| cost per session, NFL / Netflix | $0.244 / $0.158 | $0.242 / $0.138 | $0.274 / $0.165 |
| input per call, NFL / Netflix | 63.3k / 41.5k | 61.7k / 37.4k | 50.5k / 30.4k |
| cached input share | 97.7–98.5% | 97.4–98.5% | 95.0–95.7% |
| output per request, NFL / Netflix | 1,528 / 1,971 | 1,452 / 1,820 | 2,326 / 2,319 |

- **Accuracy: the catalog ties the transcript.** Both beat the single-request
  agent by 18 answers, all on NFL. No mechanism was found for that NFL gap: no arm
  overwrites earlier operators or reuses rules. With per-session spreads of 2 to 6
  answers it is suggestive, not established. Netflix collapses from question 14
  in every arm (questions 14 to 31 are almost all 0 of 3).
- **Where the catalog differs:** late NFL Rollbacks and Counterfactuals that reach back
  20 or more questions (q26, q27, q29, q33: 2 of 3 each against 0 of 3 for
  the transcript), which is what an entry per request is for. The transcript is better in
  mid-session (q11: 3 of 3 against 1 of 3).
- **Cost: the catalog is not cheaper on Luna.** It cuts input per call by 20 to 27%,
  but stable's transcript is already lean and almost all of it is cached at a
  tenth of the price. The catalog arm writes more: 5.0k to 5.4k characters of
  Python per request against 3.0k to 4.5k, and about twice the reasoning tokens.
  At request 42 the NFL entries hold about 360k characters, 38 to 43% of them code.
- **Rule reuse: none.** In 18 runs no operator was set again with new settings;
  an earlier request's function was called 2.3 times per session on average in
  the NFL transcript arm, and less often elsewhere. New functions per request
  stayed at 1.2 to 2.2, mostly answer-shaped (`maturity_review_answer`,
  `task29_raw_shortcut`), and at most 29% of them took settings. Prompt section 5
  and the signatures in receipts did not change this, as prompt teaching did
  not in two earlier attempts.

### Six more sessions, 2026-10-11

Two repetitions of each arm on six more Lite sessions, with the current
constant-column rule (which fired 0 times in these 36 runs); run root
`/var/tmp/longds-catalog-luna-lite-20261011`. Agent cost $5.09, judge $3.89.
Mean correct answers over the repetitions, all eight sessions; smolagents is the
2026-10-08 single run that received the same request text:

| session (questions) | `off` | `transcript` | `catalog` | smolagents |
|---|---:|---:|---:|---:|
| NFL t1 (42) | 9.7 | 17.0 | 18.3 | 23 |
| Netflix t4 (32) | 12.3 | 11.0 | 9.7 | – |
| Netflix t2 (34) | 3.0 | 5.5 | 3.5 | 9 |
| Marmara t1 (36) | 13.5 | 15.5 | 10.5 | 13 |
| Water potability t1 (34) | 21.0 | 19.0 | 21.0 | – |
| NYC restaurants t2 (33) | 14.0 | 10.0 | 15.5 | – |
| PASSNYC t1 (30) | 18.5 | 17.0 | 13.0 | – |
| Kaggle survey 2022 t2 (30) | 13.0 | 23.5 | 21.5 | – |
| **all eight (271)** | **105.0 (38.7%)** | **118.5 (43.7%)** | **113.0 (41.7%)** | |
| cost of one pass of all eight | $1.17 | $1.28 | $1.31 | |

- The arms are within noise of each other. Runs of the same arm differ by up
  to 15 answers on one session (PASSNYC `off` 11 and 26, Kaggle `off` 20 and
  6), so the 13.5-answer lead of `transcript` over `off` is about one standard
  error, and `catalog` against `transcript` (−5.5) is none.
- The catalog is cheaper than the transcript on four of the six new sessions,
  but costs the most over all eight; `off` is cheapest.
- On the three sessions smolagents also ran, it scores 45 of 112 at $0.93,
  against 38.0 for `transcript`, 32.3 for `catalog` and 26.2 for `off` at
  $0.57 to $0.67. That is one smolagents run; an earlier smolagents run with
  the benchmark's own wording scored 23 on the same three sessions.

### Hybrid, one run each, 2026-10-11 evening

`catalogSource: "docstring"` with `catalogRecent: 5` on the three sessions that
smolagents also ran, one run each; run root
`/var/tmp/longds-catalog-luna-hybrid-20261011`, code 781b6ec92. Agent cost
$0.52, judge $0.63. The other arms are the morning means from the table above.

| session (questions) | `off` | `transcript` | `catalog` | hybrid | smolagents |
|---|---:|---:|---:|---:|---:|
| NFL t1 (42) | 9.7, $0.244 | 17.0, $0.242 | 18.3, $0.274 | 7, $0.233 | 23, $0.372 |
| Netflix t2 (34) | 3.0, $0.147 | 5.5, $0.159 | 3.5, $0.191 | 3, $0.129 | 9, $0.127 |
| Marmara t1 (36) | 13.5, $0.182 | 15.5, $0.183 | 10.5, $0.201 | 20, $0.158 | 13, $0.431 |
| **all three (112)** | 26.2, $0.57 | 38.0, $0.58 | 32.3, $0.67 | **30, $0.52** | 45, $0.93 |

- The hybrid is the cheapest arm: input per call 26k to 35k tokens against
  47k to 62k for the transcript, peak context 39k to 65k against 88k to 113k,
  91% cached against 98%. Its output per request is back near the
  transcript's level, so the catalog's extra code is mostly gone.
- Accuracy is within a single run's noise. Marmara's 20 is the best dataflow
  run on that session. NFL collapsed at question 10 (a different
  "reliable" population, percentile 0.762 against 0.786) before the first
  conversion at request 11, so the window did not cause it.
- This run also has the two stable updates of 2026-10-11 (three sample rows,
  new prompt lines, inline lambdas) that the morning arms lack. A transcript
  run on the same code would separate their effect from the hybrid's.

### Hybrid, three runs on all eight sessions, 2026-10-11 night

The same eight sessions, three runs each of the hybrid (`catalogSource:
"docstring"`, `catalogRecent: 5`), on its own stack; run root
`/var/tmp/longds-catalog-luna-hybrid-20261011`, code 781b6ec92 (the three
earlier runs included). Agent cost $3.50 for 24 runs; judge $2.97.

| session (questions) | `off` | `transcript` | `catalog` | hybrid |
|---|---:|---:|---:|---:|
| NFL t1 (42) | 9.7 | 17.0 | 18.3 | 13.3 (7, 17, 16) |
| Netflix t4 (32) | 12.3 | 11.0 | 9.7 | 12.7 (16, 14, 8) |
| Netflix t2 (34) | 3.0 | 5.5 | 3.5 | 5.7 (3, 10, 4) |
| Marmara t1 (36) | 13.5 | 15.5 | 10.5 | 16.0 (20, 17, 11) |
| Water potability t1 (34) | 21.0 | 19.0 | 21.0 | 21.0 (24, 22, 17) |
| NYC restaurants t2 (33) | 14.0 | 10.0 | 15.5 | 12.7 (14, 9, 15) |
| PASSNYC t1 (30) | 18.5 | 17.0 | 13.0 | 14.3 (26, 4, 13) |
| Kaggle survey 2022 t2 (30) | 13.0 | 23.5 | 21.5 | 18.7 (17, 19, 20) |
| **all eight (271)** | 105.0 (38.7%) | 118.5 (43.7%) | 113.0 (41.7%) | **114.3 (42.2%)** |
| cost of one pass | $1.17 | $1.28 | $1.31 | **$1.17** |
| input per call | 43.7k | 46.3k | 34.4k | **28.2k** |
| peak input | 80.9k | 86.7k | 72.3k | **46.8k** |
| cached share | 97.9% | 97.9% | 95.2% | 91.9% |
| output per request | 1,454 | 1,544 | 1,928 | 1,421 |

- Accuracy: the hybrid sits between the catalog and the transcript, within
  noise of both. Its three passes total 127, 112 and 104 of 271.
- Cost: as cheap as `off`, 9% below the transcript and 11% below the
  catalog. It sends 39% less input per call than the transcript, and its
  largest context is about half. A lower cached share (each conversion is
  sent once uncached) gives back part of the input saving. Its output per
  request is the lowest of the four arms: the catalog's extra code is gone.
- The hybrid ran on newer code than the other three arms (the two stable
  updates of 2026-10-11), so part of the difference may come from those.

### smolagents on the same eight sessions, three runs each

smolagents' `CodeAgent` (`benchmark/longds/smolagents_session.py`, commit
454c842fe) with the same request text, model, gateway and judge; run root
`/var/tmp/longds-catalog-luna-smolagents-20261011`. Agent cost $3.13 for 24
runs; judge $4.95.

| session (questions) | `off` | `transcript` | `catalog` | hybrid | smolagents |
|---|---:|---:|---:|---:|---:|
| NFL t1 (42) | 9.7 | 17.0 | 18.3 | 13.3 | 17.7 (28, 6, 19) |
| Netflix t4 (32) | 12.3 | 11.0 | 9.7 | 12.7 | 11.3 (6, 13, 15) |
| Netflix t2 (34) | 3.0 | 5.5 | 3.5 | 5.7 | 5.7 (3, 11, 3) |
| Marmara t1 (36) | 13.5 | 15.5 | 10.5 | 16.0 | 11.3 (17, 4, 13) |
| Water potability t1 (34) | 21.0 | 19.0 | 21.0 | 21.0 | 19.7 (24, 18, 17) |
| NYC restaurants t2 (33) | 14.0 | 10.0 | 15.5 | 12.7 | 10.7 (13, 5, 14) |
| PASSNYC t1 (30) | 18.5 | 17.0 | 13.0 | 14.3 | 26.7 (29, 25, 26) |
| Kaggle survey 2022 t2 (30) | 13.0 | 23.5 | 21.5 | 18.7 | 21.0 (23, 22, 18) |
| **all eight (271)** | 105.0 | 118.5 | 113.0 | 114.3 | **124.0 (45.8%)** |
| cost of one pass | $1.17 | $1.28 | $1.31 | $1.17 | **$1.04** |
| calls per request | 2.53 | 2.59 | 2.58 | 2.54 | 1.28 |
| input per call | 43.7k | 46.3k | 34.4k | 28.2k | 51.5k |

- smolagents leads by 9.7 answers over the hybrid and 5.5 over the
  transcript. Its passes total 143, 104 and 125, so the lead is within one
  standard error. PASSNYC alone gives 12.4 answers of it (26.7 against
  14.3); without PASSNYC, smolagents has 97.3 and the hybrid 100.0.
- smolagents is the cheapest: about half the calls per request (most
  requests are one code block that calls `final_answer`), which outweighs
  its larger contexts (51.5k per call, 104k at the peak, never compacted).

