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
  ~ KIND, either express or implied. See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# Gold-prefix pilot: trace study (2026-10-02)

Companion to [gold-prefix-pilot-20261002.md](gold-prefix-pilot-20261002.md).
Every failed turn of the three arms was read against the reference solution
(65 failures: baseline 23, ledger 19, dsgym 23), every call of the 516 turns
was priced from the wire records, and the state gestures of the labelled turns
were classified. Paths are relative to
`/var/tmp/texera-gold-prefix-20261002/pilot1/runs/gpt-5.6-terra-<arm>-r1/<session>/tNN/`.

## Essence

1. **One correction to the pilot report: under one accounting rule the script
   arm is cheaper, not at parity.** Our gateway reports no cache writes, so all
   of our fresh input is billed at $2/M; the script arm's gateway reports its
   fresh input as cache writes, which the campaign billed at $2.5/M. Priced the
   same way, dsgym is $0.081 per turn against our $0.096 (+18%). The gap is
   calls: 3.7 per turn against 2.35, with 86k cached tokens re-read per turn
   against 32k.
2. **On correct state the substrate does not decide accuracy.** Of 65
   failures, 10 are state selection; 23 are definition misreads, 5 sequencing,
   9 precision or tie order, 8 completeness or format, 6 judge or gold
   artefacts, 4 script-only (3 answers typed without code, 1 index
   misalignment). Twelve turns fail in all three arms, and those are shared
   misreads of rules stated once in a 600-word task-1 context.
3. **The ledger changed nothing it was built to change.** `rollback operator`,
   `inspect target=state` and fork were used 0 times in 172 turns. All 420
   provenance lines read `scan [loaded] · scan(<file>)`: name and shape only,
   because the protocol seeds every table as a parquet scan. Of its 13 wins
   over the baseline none is attributable to a card or note; 2 are judge
   artefacts, 2 are answer-format differences. Its +4 is inside judge noise
   (4 identical answers were scored differently across arms). No arm ever
   picked a stale version on a Rollback turn (0 of 48 in each arm), and the
   dataflow arms never modified a loaded table (every `update`/`delete` hit a
   same-turn operator): there was no version to retrieve and none was made.
   One protocol gap did cost turns: lists and sets from earlier tasks
   (`existing_brand_pool`, `q37_cols`) are not in our state while the kernel
   has them; the reference reads such variables in 34 turns.
4. **The extra calls are mechanical and removable.** The first one or two calls
   of every dataflow turn discover schemas the listing omits (the state
   listing gives `name rows×cols [task k]`; `inspect graph` returns 28 `scan`
   entries with no columns; the model then asks `sample_stats` for five
   tables); the last two are always `retrieve view=full` followed by an
   answer call that copies the table (134–142 of 172 turns); 33–38 calls per
   arm repair engine strictness that pandas does not have. Removing them puts
   the turn at about $0.079 and 2.3 calls, the script's level.
5. **What the pilot cannot show.** The gold prefix hands both arms correct,
   named state, so neither benefit of lineage (retrieving a version the
   script lost, reusing state the script recomputes) has room to appear. The
   script agent read a file in 8 of 232 code blocks here against 42 of 95
   Terra turns in natural sessions. Both theses have to be tested where the
   state is the agent's own: the natural-session A/B.

## 1. Accuracy phenomena

### 1.1 Where the 65 failures come from

| category | baseline (23) | ledger (19) | dsgym (23) | fails in all three |
|---|---:|---:|---:|---:|
| A. state selection: wrong table, pool or version | 6 | 2 | 2 | 2 (KG t13, NFL t08) |
| B. definition misread (rule, filter, metric) | 8 | 7 | 8 | 4 (NYC t16, t22, t26; KV t25) |
| C. sequencing (filter before rank, early screen) | 2 | 2 | 1 | 1 (NFL t41) |
| D. precision and tie order | 2 | 4 | 3 | 2 (NF t13, NFL t12) |
| E. completeness or format (missing field, extra row) | 2 | 3 | 3 | 1 (KV t16) |
| F. engine error as primary cause | 0 | 0 | – | – |
| G. script hazards (no code, index misalignment) | – | – | 4 | – |
| H. judge or gold artefact | 3 | 1 | 2 | 2 (NYC t31, KV t30) |

No failed turn hit the step budget (3–10 steps each). Engine errors were
repaired every time they occurred (category F is empty), at the cost of calls
(section 2).

Concrete cases, one per category:

- **A.** NFL t08 (baseline, dsgym): leaders ranked over all 86 `players`
  although the state holds `reliable_refined` (42 players); NYC t23 (ledger):
  classified all 169 units although the prefix lists the constant
  `net_review_keys` (4 units) and the tables `net_revenue_metrics` 4×13 and
  `current_customer_review` 4×8. NYC t22 (baseline): took the "global share"
  from `is_frequency_value`, the task-5 view, instead of `is_spend_value`,
  the task-13 view in force, both columns of the same table.
- **B.** KG t04 (baseline): funnel stage 2 as `Q5 == "No"` only, missing the
  employment condition on `Q23` (12,036 vs 9,198). NYC t16 (all three):
  found the two safe families but returned `[]`; the context says "keep …
  pressure visible even if no family crosses".
- **C.** NF t07 (baseline): percentile-ranked entropy over all 107 countries
  and then joined to the 15 candidates; the rule says rank within the 15.
- **D.** NF t13 (all three): every `rank_loss` is 0 and all arms broke ties
  alphabetically; the task-1 context says "uncertainty … checks use the
  matching penalty after rank loss". NFL t12 (all three): two players tie at
  7/86; float noise (0.0813953…) orders them; the reference does
  `.round(12)` before sorting. That convention appears in 4 of the 118
  reference `task.py` files and first becomes visible in the NFL prefix at
  t13, so at t12 no arm could have known it; at t29 it was visible and the
  ledger and dsgym still missed it.
- **E.** KV t16 (ledger): the table had the gold values (water 47.8,
  sanitation 6.9) and the answer transposed them; KV t30 (baseline, dsgym):
  missing `pressure_score` and `vulnerability_score`.
- **G.** NF t04, KV t06, KV t16 (dsgym): answers written without running
  code; NF t29 (dsgym): `ordered_rank` left a non-default index and the
  next assignment misaligned (reproduced offline: Spain 73.05, Hong Kong
  dropped).
- **H.** NF t25: identical points, label `trend_stability` (the context's
  own wording) rejected for the baseline, `trend_volatility` accepted for
  the others; KV t29 and NYC t17/t24: identical answers across arms, one
  failed; KG t12: 7.03125 reported as 7.0313, gold's banker's rounding gives
  7.0312.

### 1.2 Why the ledger did not move the number

- **Nothing to roll back to.** The protocol loads only the tables in force
  after task t-1; superseded versions are not in state, and the turn text
  restates the rule it needs. The model never issued a `rollback operator`,
  `inspect target=state` or fork in 172 turns, in either dataflow arm.
- **Cards without content.** Every seeded table is a `scan`, so the
  provenance card can only say `[loaded]` and a shape. The one case where a
  card could have helped (NYC t22, two views of one column family) needed
  column-level origin, which nothing records.
- **Notes fire on the wrong things.** 443 notes: 302 join counts, 103
  limited-table, 27 filter-of-parent, 11 empty-input. Among the ledger's 19
  failures, 2 notes were directly on point and ignored (NYC t16: `input
  residual_service_pressure has 0 rows`; NYC t29: `right input … is a filter
  of voucher_net_metrics (2 of 4 rows)`); 3 were indirectly relevant; 14
  absent or unrelated.
- **Its wins are not the mechanism's.** In each substantive win the deciding
  choice is already in the first edit, before any receipt (NF t07 joined the
  15 markets first; NYC t05 put `advance_keys` on the left; NFL t08 drew
  from `reliable_refined`). The system-prompt sentence "tables created in
  earlier tasks are the state to build on" may have helped KG t09/t13, but
  that is the prompt, not the receipts.

### 1.3 The shared ceiling

Both agents read the same 35–40 KB message and fail on the same clauses.
Rules that decide a turn sit in one sentence of a task-1 paragraph (tie
orders, fallback clauses, denominators) and are not repeated at the turn
that needs them. Three of the twelve all-arm failures are tie or fallback
clauses; three are the same wrong filter. This ceiling (about 87–90% on
these 172 turns) is a reading problem and moves only with the message, not
with the substrate.

### 1.4 State gestures on the labelled turns

The anchor tables of each turn (the reference's reads whose last change is in
one of the turn's dependency tasks) were compared with what each arm read.
B = baseline, S = dsgym, L = ledger; `x (y)` = instances (judged right).

| label | arm | same table | superset | different table | re-derived upstream | anchor skipped / no table |
|---|---|---:|---:|---:|---:|---:|
| Rollback 48 | B | 27 (25) | 3 (3) | 12 (10) | 3 (3) | 3 (3) / 0 |
| | S | 26 (22) | 3 (3) | 7 (5) | 3 (3) | 5 (5) / 4 (2) |
| | L | 26 (25) | 5 (5) | 11 (10) | 3 (3) | 2 (2) / 1 (1) |
| Counterfactual 50 | B | 29 (27) | 5 (4) | 9 (7) | 3 (3) | 3 (3) / 1 (1) |
| | S | 29 (26) | 5 (4) | 6 (4) | 2 (2) | 5 (5) / 3 (3) |
| | L | 30 (26) | 7 (6) | 7 (7) | 2 (2) | 3 (3) / 1 (1) |
| Update 55 | B | 35 (30) | 5 (4) | 8 (7) | 4 (4) | 3 (1) / 0 |
| | S | 34 (32) | 4 (2) | 6 (6) | 4 (3) | 3 (2) / 4 (2) |
| | L | 36 (33) | 5 (1) | 6 (6) | 3 (3) | 5 (3) / 0 |

- **Nobody picked a stale version.** On the 48 Rollback turns, "used the
  current version instead of the earlier one" is 0 in every arm; the earlier
  table was read by name (B 30, S 29, L 31) or through another table carrying
  the same state (B 12, S 7, L 11). Most "different table" cases are
  equivalent substitutes (a later table with the same columns, a stored
  earlier result). The 14 Rollback failures (B 4, S 8, L 2) are: wrong
  component on the right state 3, other errors on the right state 9, no code
  2 (dsgym).
- **The dataflow arms never touch loaded state.** Every `update operator`
  (B 34, L 32) and `delete operator` (B 15, L 2) in 172 turns targeted an
  operator created in the same turn; no edge was created into a seeded
  operator; counterfactuals were new branches in 50 of 50. The script
  mutated kernel state in 6 of 50 counterfactual turns (temporary columns on
  `players`, one rebound constant), 5 of them right. The reference itself
  advances a standing table in 29 of 55 Update turns and writes standing
  tables in 12 of 50 counterfactual turns; the script wrote the same name in
  12 of the 29, the dataflow arms in 0. In a natural session our updated
  results therefore exist only under new names, which is why a version
  history never forms and `rollback` never has a target.
- **Lists and sets from earlier tasks are missing in the dataflow arms.**
  `existing_brand_pool`, `q37_cols`, `complete_countries`,
  `qualified_markets` are neither loaded as operators nor shown under
  "Constants in force" (the constants filter drops long values). The kernel
  has them because it re-executed the earlier code. The reference reads such
  variables in 34 turns (accuracy B 28, S 29, L 29); the gap directly caused
  NYC t14 (B and L rebuilt the review pool from the task-9 table with their
  own filter instead of the task-11 list) and KG t27 (B typed the Q37 column
  list by hand and left out `Q37_13`: 1,823 vs 1,878).
- **State errors among the 41 failures on the 33 disagreeing turns: 13.**
  Version or recompute errors B 5, S 3, L 1 (NYC t14 B/L, NYC t15 S, KG
  t09/t13/t17/t27 B, KG t13 S, NF t29 S); standing pool not kept B 1, S 2,
  L 1. The ledger arm has the fewest, which is consistent with its "build on
  earlier state" prompt sentence and is one repeat of evidence.
- **Fresh source reads (8 turns, identical in both dataflow arms, 6 right):**
  6 introduce a file the reference also reads; NFL t19 needed raw tracking
  data the reference gets through a helper; NFL t18 was avoidable (`play5`
  already carried the needed columns).
- **Code volume.** The script writes about 30% less code per turn (Update:
  2,315 vs 3,557/3,686 characters; reference 2,840). Wrong turns are longer
  in every arm (B 3,836 vs 2,653; L 4,205 vs 2,624; S 2,469 vs 1,915).

## 2. Cost phenomena

### 2.1 Uniform accounting

Per turn, from the 516 wire records (`fresh = prompt − cached`; $2/M fresh,
$0.2/M cached, $12/M output):

| arm | calls | fresh in | cached in | output | $/turn, uniform | $/turn as reported |
|---|---:|---:|---:|---:|---:|---:|
| dsgym | 2.35 | 25,930 | 32,463 | 1,882 | **0.0809** | 0.0939 |
| baseline | 3.73 | 28,924 | 86,080 | 1,730 | 0.0958 | 0.0958 |
| ledger | 3.67 | 29,139 | 88,869 | 1,696 | 0.0964 | 0.0964 |

The reported dsgym figure adds $0.5/M on 25.9k "cache write" tokens per turn;
our gateway returns `cache_write_tokens: null`, so the same tokens on our side
were billed as fresh at $2. Fresh input and output are the same across arms;
the difference is 1.4 extra calls, each re-reading a 23k–24k cached prefix.

### 2.2 Where the extra calls go (netflix t05, ledger, 7 steps)

1. `inspect graph` + `inspect operator market_full_scores` + `inspect
   operator full_assignment`: 3.7 KB back, 28 `scan` entries, no columns.
2. `retrieve sample_stats` on five loaded tables: 22.7 KB back, to learn
   column names that the prefix's reference code already spelled out.
3. First edit (22 operators) + execute.
4. Repair (a genre branch filtered before the period join).
5. `create operator fractional_top_report: project(...)` + execute +
   `retrieve view=full` to read five rows.
6. Answer call that copies those rows into JSON.

Across the arms: the first call is a look in 128 (baseline) and 117 (ledger)
of 172 turns; `inspect` actions number 205 in the baseline (operator 164,
graph 41) and 194 in the ledger arm (operator 176, graph 18), none with
`target=state`, and on loaded tables each returns a schema-less `scan` entry;
the columns requested were already named in the prefix in 118 of 124
baseline turns checked; every turn ends with `retrieve` then `answer`
(172/172), and the answer copies a ≤50-row table in 134–142 turns.

### 2.3 Repairs forced by the engine

| error | baseline | ledger | cause |
|---|---:|---:|---|
| `AGGREGATE_TYPE` | 8 | 7 | `sum`/`mean` of a bool column (pandas treats it as 0/1) |
| `COLUMN_COLLISION` (output name reused) | 5 | 5 | a second `rank`/`score` column with the same name |
| `COLUMN_COLLISION` (join suffixes) | 4 | 3 | both sides carry the same non-key column |
| `MISSING_COLUMN` | 5 | 4 | guessed column name on a loaded table (no schema) |
| `CALLBACK_RUNTIME` NameError `pd` | 2 | 1 | `pd`/`np` not in the callback scope |
| repair calls | 33 | 38 | 0.2 per turn |

`process` operators are 9% of operators but 24–25% of edit characters; they
are where the `pd` errors and most of the repairs land.

### 2.4 Savings available without changing the model

| lever | $/turn | calls/turn |
|---|---:|---:|
| columns and dtypes in the state listing and seed receipt; `inspect operator` on a loaded table returns its schema | −0.011 | −1.0 |
| answer composed from a table reference instead of copied (the `answer_from` mechanism of the lean branch) | −0.013 | −1.0 |
| bool aggregates, output-name overwrite, join suffixes, `pd`/`np` in scope | −0.004 | −0.2 |
| sample budget sized to the table so no projection round follows a truncated sample | −0.002 | −0.1 |
| **after** | **≈0.079** | **≈2.3** |

The fixed per-call overhead (4.1k–5.2k tokens of system prompt and operator
index against 0.8k for the script) is cached and costs about $0.001 per
call at Terra's cached rate; the number of calls is the lever, not the
prefix length. Seeding (146 s per turn on average, 290–350 s for Kiva's
9 M rows) is harness time, not model cost, and is what makes a repeat take
six hours.

## 3. Levers, ranked

Cost first, because the fixes are mechanical and each removes a call:

1. **Schema in the listing.** Columns with dtypes per table in "Tables in
   force", in the seed receipt and in `inspect operator` for loaded scans.
2. **Composed answers.** Port `answer_from` so the final table is referenced,
   not retrieved and retyped.
3. **Engine permissiveness where pandas is permissive.** Bool `sum`/`mean`
   as 0/1; replacing an existing output column instead of
   `COLUMN_COLLISION`; automatic `_left`/`_right` suffixes; `pd` and `np`
   bound inside callbacks.

Accuracy second; these change the message, so they apply to both arms:

4. **Conventions in force.** A short block beside the state listing holding
   the session's ordering, tie, rounding, denominator and fallback rules,
   extracted once per session from the task-1 context and updated when a
   later task changes one. Targets categories B and D (NF t05, t13; NYC t16,
   t26; NFL t15, t34).
5. **Current pools.** The one dataflow-native accuracy lever in this data: a
   note when a new aggregate or rank runs over a table that has a more
   recent, smaller subset in state (`players` 86 → `reliable_refined` 42,
   `current_candidate` 33; `orders_brand_cuisine` 169 units →
   `net_review_keys` 4). Lineage gives the subset relation; a kernel has no
   handle on it. Targets category A (8 of our 10 cases).
6. **Requested-field check before answering.** The answer renderer lists the
   fields the question asked for next to the fields present. Targets
   category E (5 of our failures).
7. **Column-level origin in provenance cards** (`is_spend_value` added by
   task 13). Needs per-column diffs between versions in `gold_state.py`;
   one or two turns.
8. **Load list and set constants in full.** Seed them as one-column tables
   (or print them whole under "Constants in force") so `existing_brand_pool`
   and `q37_cols` are state, as they are in the kernel. Protocol-side, an
   hour; NYC t14 and KG t27 are direct losses to it.
9. **Advance in place when the task says so.** The reference overwrites a
   standing table in 29 of 55 Update turns; our arms created new names in
   all of them. Guiding `update operator <standing name>` for "update /
   recompute / replace" requests is what makes a version history exist, and
   it is the precondition for `rollback` to have a target in natural
   sessions. Not a gold-prefix lever; a natural-session one.

Measurement:

10. **Judge hardening.** Numeric gate first (`numeric_gate.py` exists), judge
    only the residue, two judge samples on any flip between arms. Four
    identical answers were scored differently and one rounding convention
    decided a turn; the ledger's +4 is below this floor.

## 4. Next steps, in order

1. Mechanism v2: levers 1–6 and 8, plus the limited-note refinement (fire
   only for join/filter/aggregate/map/process consumers). About one day;
   tests and the regenerated system prompt included.
2. Rerun `baseline` and `ledger` on the same 172 turns, one repeat
   (≈$33 solver, $1 judge). Pass criteria: ≤$0.081 per turn, ≤2.5 calls,
   ≥149 correct. Seed once per session before this run to bring the wall
   time from six hours to about two.
3. Judge hardening on the three existing arms before any further
   comparison; re-report the pilot with the uniform accounting.
4. The natural-session A/B on the five sessions, Terra, three arms, three
   repeats: the only protocol in which the script loses or recomputes state
   and in which a version can be worth rolling back to. Measure cascade
   roots, file re-reads per turn, and cost per correct turn.
5. Luna on both protocols for the model axis.

## 5. What the pilot does and does not establish

Established, one repeat, Terra, 172 dependent turns from correct state:

- Accuracy parity between substrates (149 = 149; ledger 153) with failures
  of the same kinds in all arms; 75% of failures are reading errors.
- Under uniform accounting the dataflow arms cost 18% more per turn, all of
  it in 1.4 extra calls that schema discovery and the answer round-trip
  account for.
- The ledger's receipts were never acted on; its tools were never used.

Not established: any accuracy or cost advantage of lineage. The protocol
removes the conditions under which one could appear.
