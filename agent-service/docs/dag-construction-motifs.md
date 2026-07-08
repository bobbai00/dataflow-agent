# DAG-construction behavior motifs (gpt-5.2 DELTA, 103 KramaBench tasks)

Deterministic extraction (scripts/dag-construction-extract.py) reconstructs each
step's insert/update/rewire/delete ops + links (links recovered from the
`def process(a,b)` signature: `load()`=source, args=incoming edges; multiple
tool-calls in one step = a parallel batch). Aggregate + a 4-agent motif-mining
workflow (wf_b56dba84) over the 103 construction scripts.

## Deterministic aggregate (103 tasks, 488 agent-steps)
- Op mix: **72% insert, 27% update (code-only), 1% rewire, ~0% delete** (1 delete corpus-wide; scaffold-deletion effectively unused).
- New-op fan-in: **47% source, 39% single-parent chain, 13% join (>=2 parents)**.
- Step batch size: **72% single-op, 28% batch 2-9 ops** (opening loads + sibling cleans).
- Macro shape: **48% pure linear chain, 51% has a join, 11% fan-out**; **59% open with a multi-source batch load**.

## Canonical templates
- **T1 single-source linear chain ~48%** (easy population; ~12% ultra-minimal 2-hop).
- **T2 depth-first late-join diamond ~28%** (hard shape: multi-source → serial per-branch prep → terminal join → agg).
- **T3 homogeneous multi-file concat ~11%** (env/legal: union same-schema files, then process).
- **T4 symmetric-twin lockstep ~7%** (astronomy A/B twins, breadth-first).
- **T5 whole-DAG-in-one-batch ~6%** (env plan-then-emit).

## Build order + updates
- **Open breadth-first, extend depth-first**; **fan in LAST — 0 early joins in 103 tasks** (joins terminal, <=2 steps from answer).
- Updates: instant-fix ~70% (polish source <=1 step after insert) >> late revisit ~15-20% (RE-OPEN a settled op after seeing its result) >> thrash-burst ~8-10% of tasks (dominates step-cost).

## Implication for compaction (the payoff)
The single-frontier-LINEAR model is wrong 4 ways: (a) DAG is a graph — a settled op
is routinely a live LATE-join input or fan-out parent, so fold HISTORY, retain
STATE (the deck already keeps every settled op's node state — correct); (b)
'settled' != final: 15-20% late revisits re-open settled ops (the legal-hard-1
right->wrong mechanism) — fold must be re-open-aware; (c) active run must keep the
thrash loop (mid-error guard right); (d) frontier is a SET for the 28% batched
steps (twin/whole-DAG), so single-frontier tie-break is undefined.
**Cleaner safe win surfaced:** trim genuinely-DEAD context — orphan/dead sources
(~14 tasks; wildfire var_desc 7/21 loaded+cleaned, never wired), superseded reloads
(X_raw after X_reload), settled loader bodies. Always-correct (never a join-input /
re-open candidate) and cache-friendlier than folding live history.
