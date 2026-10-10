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

# LongDS gold-prefix protocol and state ledger: checkpoint

Checkpoint date: 2026-10-02 (America/Los_Angeles). Branch
`feat/operator-history-lean`, worktree
`/home/bob/Desktop/dataflow-agent/.claude/worktrees/operator-history-lean`.
Supersedes the pause checkpoint of the same day for the state-history work.

## Decision taken

The 2026-10-02 review of all campaigns concluded that LongDS's natural
protocol hides both benefits dataflow is meant to show: nothing is ever lost
(persistent kernel, unchanged data, each turn restating its own rule), the
script agent pays for its state hygiene in tokens and seconds the leaderboard
does not score, and it recovers from its own wrong state by recomputing from
raw. Our agent reused earlier operators on 93% of turns without reading them,
and every version tool (fork, inspect state, bind, restore) was used on 0–1% of
turns because the model never overwrites a definition. The user approved:

1. a protocol variant that measures state use from correct earlier state
   (gold-prefix continuation), the strong model as primary;
2. one mechanism, system-verified reuse (the state ledger), using the existing
   edit vocabulary (`create`/`update`/`delete` + `rollback operator`), no fork;
3. a first pilot before any wider campaign.

## Built (uncommitted at this checkpoint)

See [docs/longds-gold-prefix-and-state-ledger.md](../longds-gold-prefix-and-state-ledger.md).

- `benchmark/longds/gold_state.py`, `gold_prefix.py`, `gold_prefix_dsgym.py`,
  `gold_prefix_campaign.py`, `gold_prefix_analysis.py`; copied harness
  `dsgym_agent.py`, `dsgym_executor.py` (+`--extra-ro`), `execution_isolation.py`;
  `numeric_gate.py` gained the `rounded_df` helper.
- `agent-service/benchmark/multiturn/run-gold-prefix.ts`;
  `agent-service/benchmark/e2e/cleanup-idle-agents.ts`.
- Agent service: `seedState` + `POST /api/agents/:id/seed-state` (hidden
  synthetic `state` step, `completedTasks` offset); `stateLedger` setting;
  `src/agent/state-ledger.ts` (ledger, provenance cards, execution notes,
  rollback command expansion); runtime/renderer wiring; answer-echo dedupe;
  prompt section "Earlier tasks" (`nativeStateText`); `fork` no longer
  advertised; parser error lists `rollback operator`. Tests:
  `state-ledger.test.ts`, `seed-state.test.ts`, `state-history-prompt.test.ts`
  (rewritten), updates in `dataflow-actions.test.ts`, `native-program.test.ts`;
  regenerated `native-mode/SYSTEM_PROMPT.md`. Full suite: 1,224 pass.

## Result of the pilot

[benchmark/longds/reports/gold-prefix-pilot-20261002.md](../../benchmark/longds/reports/gold-prefix-pilot-20261002.md):
one repeat, Terra, 172 dependent turns of five sessions from reference state.
dsgym 149, baseline 149, ledger 153 of 172 at $0.094 / $0.096 / $0.096 per
turn as reported by the gateways ($0.081 for dsgym under uniform accounting,
see the trace study); Rollback 40 / 44 / 46 of 48. Differences in accuracy
are inside one-repeat noise.

Trace study of the pilot:
[benchmark/longds/reports/gold-prefix-pilot-20261002-trace-study.md](../../benchmark/longds/reports/gold-prefix-pilot-20261002-trace-study.md)
(65 failures classified, 516 turns priced under one rule, ranked levers,
run order).

## State of the machine

- Engine 38086 (private stall-repair stack) running; agent instances 3037 and
  3038 running from this worktree's current source without watch mode (they
  loaded the code before the parser-message edit; restart them before new
  runs). No campaign driver is alive; nothing is queued.
- `/home` was at 100% during the campaign: the engine result store of the
  dormant `task-history-dataflow` stack was deleted (21 GB) and the pilot's
  per-step snapshots were gzipped. At the checkpoint `/home` had ~14 GB free
  and `/` ~6.5 GB. Large remaining consumers that are the user's evidence and
  were not touched: `benchmark/longds/system_scratch` in the main checkout
  (74 GB), the same in `longds-multiturn` (18 GB), `/tmp/longds-annotation-*`
  bundles (~9 GB), `/tmp/texera-retrieval-full-fixed-20261001` (3.5 GB), engine
  result stores of other worktrees (1–3 GB each).
- Pilot artifacts: `/var/tmp/texera-gold-prefix-20261002/pilot1`; gold state
  `/var/tmp/texera-gold-state-20261002`; smoke runs under
  `/var/tmp/texera-gold-prefix-20261002/smoke`.

## Agreed TODO list (2026-10-02, after the trace study)

Consolidated from the trace study
([gold-prefix-pilot-20261002-trace-study.md](../../benchmark/longds/reports/gold-prefix-pilot-20261002-trace-study.md))
and the follow-up discussion. Status 2026-10-02 (evening): items 1–9, 11–13,
15–17 built and tested (see "Mechanism v2" in
[docs/longds-gold-prefix-and-state-ledger.md](../longds-gold-prefix-and-state-ledger.md));
item 10 (requested-field check) was dropped as a mechanism because the
requested fields cannot be read mechanically from the question, and is prompt
guidance instead; item 14 is prompt guidance; item 18 (seed once per session)
not done; the rerun (19) is next.

### A. Mechanism v2: build before any rerun

Cost (each removes calls; together ≈ $0.096 → $0.079 and 3.7 → 2.3 calls per turn):

1. Columns and dtypes per table in the "Tables in force" listing, in the seed
   receipt, and in `inspect operator` for loaded scans (today: `scan` only).
2. Port `answer_from` from the lean branch: the answer references tables
   instead of retyping rows.
3. Engine permissiveness where pandas is permissive: bool `sum`/`mean` as 0/1;
   a repeated output name replaces the column with a receipt note instead of
   `COLUMN_COLLISION`; automatic join suffixes; `pd`/`np` bound in callbacks.
4. Sample budget sized to the table so no projection round follows a
   truncated sample.

Language additions (all in the existing create/update/delete vocabulary):

5. `values(col=[...])`: a table constructor for lists that come from the
   question or domain knowledge, and for seeding the reference's lists. Shows
   in the listing and ledger, rollback-able. Not for copies of a table's output.
6. `semi_join(on=...)` and `anti_join(on=...)`: membership filter against
   another table's key column; one operator, no suffix collisions, lineage kept.
7. Ledger check: when a filter contains typed values equal to a column of a
   table in state, name the table and suggest the semi-join.
8. Prompt rules: a selection that exists in state is used by joining, never
   retyped; a selection derived from data is created as an operator and reused
   by name.

Accuracy, message side (applies to both arms):

9. "Rules in force" block beside the question: ordering, tie, rounding,
   denominator and fallback conventions, extracted once per session and
   updated when a later task changes one.
10. Requested-field check in the answer receipt (fields asked vs present); the
    model may answer again.

Accuracy, dataflow-native:

11. Current-pool note: when a new aggregate or rank runs over a table that has
    a smaller, more recent subset derived from it in state, name those pools.
12. Limited-table note fires only for join/filter/aggregate/map/process
    consumers, not for report shaping.
13. (Later) column-level origin in provenance cards; needs per-column diffs
    between versions in `gold_state.py`.

Natural sessions:

14. Guide `update operator <standing name>` for update/recompute/replace
    requests so a version history exists and `rollback` has a target.

### B. Protocol and measurement

15. Gold-prefix seeding: never drop a collection from "Constants in force";
    seed data-valued collections as tables (`values` once it exists,
    one-column parquet scans before that).
16. Judge hardening: numeric gate first, judge only the residue, two judge
    samples on any flip between arms; re-judge the four inconsistent turns.
17. Uniform accounting in `gold_prefix_campaign.py report` (no cache-write
    surcharge, or the same rule for every arm); the pilot report already
    carries the corrected figure.
18. Seed once per session instead of per turn (engine-side result reuse) to
    bring a repeat from ~6 h to ~2 h of wall time.

### C. Runs, in order

19. Rerun `baseline` and `ledger` on the same 172 turns, one repeat
    (≈$33 solver + $1 judge). Pass: ≤ $0.081 per turn, ≤ 2.5 calls,
    ≥ 149 correct.
20. Two more repeats of all three arms plus a `history`-only arm, then the
    per-label comparison with error bars.
21. Natural-session A/B: five sessions × {dsgym, baseline, ledger} × Terra ×
    three repeats; measure cascade roots, file re-reads per turn, cost per
    correct turn. This is where the lineage theses are tested.
22. Luna arms on both protocols.

### D. Housekeeping

23. Commit the uncommitted work on `feat/operator-history-lean` (protocol
    scripts, state ledger, tests, reports) once the user gives the go.

## Resume

```bash
cd /home/bob/Desktop/dataflow-agent/.claude/worktrees/operator-history-lean
set -a; source /var/tmp/texera-engine-stall-repair-20261002/stack/profile.sh; source .env; set +a
# agent instances (restart to pick up source changes): PORT=3037 / PORT=3038 bun run src/server.ts (in agent-service/)
./.venv/bin/python benchmark/longds/gold_prefix_campaign.py run --root <new root> --models gpt-5.6-terra --arms dsgym,baseline,ledger --turns dependent --reps 1 --concurrency 3
./.venv/bin/python benchmark/longds/gold_prefix_campaign.py judge --root <root>; ... report --root <root>
./.venv/bin/python benchmark/longds/gold_prefix_analysis.py --root <root>
```
Point `TEXERA_AGENT_SERVICE_ENDPOINT` at the instance each dataflow arm should
use; never edit the runner, the service API or `native/python/*.py` while a
driver is launching jobs.
