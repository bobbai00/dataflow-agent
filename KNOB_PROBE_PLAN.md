# Task-Aware Knob Probes: KramaBench Analysis & Paired Partial-Run Training-Data Plan

**What this is:** a task-by-task analysis of all 104 KramaBench workloads and their gold
solution pipelines (`workload/{domain}.json` → `subtasks[]`), a knob taxonomy (implemented
+ proposed), a judgment-based map of *which knobs should matter for which task types*, and
a concrete design for generating training data by **running partial tasks under two knob
values from the same checkpoint** and observing the divergence.

**Companion:** `KNOB_TUNING_PLAN.md` (overall program). This doc details its Phases 1/3
with task-level targeting, replacing blind OFAT sweeps with hypothesis-directed probes.

---

## 1. The key structural gift: subtasks are intermediate ground truth

Every KramaBench task ships a **gold decomposed pipeline**: `subtasks[]`, each with a
`step` description, its own `query`, its own `answer`, and an `answer_type` scored by
`benchmark/metrics.py`. Example (`astronomy-easy-1`): *load bulletin → identify observed
files → regex forecast Ap → regex observed Ap → MAE*, with gold answers at every stage
(`[25,20,12]`, `[10,10,32]`, `15`).

This means a **partial run can be scored without finishing the task**: after k steps we
can check the agent's intermediate operator outputs against the nearest downstream
subtask answers. That is the trick that makes paired knob probes cheap — we don't need
full rollouts to see whether knob A or knob B put the agent on the gold path.

## 2. Corpus anatomy (from the digest of all 104 tasks)

- **Domains:** legal 30, wildfire 21, environment 20, archeology 12, astronomy 12, biomedical 9.
- **Answer types:** numeric_exact 54, string_exact 20, list_exact 12, string_approx 10, numeric_approx 6, list_approx 2.
- **Sources per task:** 1 file → 40 tasks, 2 files → 37, 3+ → 27 (up to 24 files).
- **Gold-pipeline operations (keyword-mined):** aggregate 78, unit/convert/clean 62,
  filter 58, rank/top-k 56, statistics (corr/MAE/regression) 48, join 23, time-series 23,
  multi-file iteration 17, regex/text-parse 11.

The single most striking fact: **cleaning dominates**. 55/104 tasks require non-trivial
loader surgery *before* any analysis — skiprows, multi-level headers, embedded sub-table
blocks, K/M suffixes, commas-in-quotes, footer rows, sentinel values (`'M'`, `>1e30`,
`N/A`), encoding overrides. The benchmark is, first, a *data loading* benchmark.

## 3. Task archetypes (assigned per task; full table in Appendix A)

Tasks carry 1–3 tags. Counts: **MESSY 55 · UNION 39 · JOIN 28 · TSMODEL 16 · CLEAN 15 · TEXT 13 · SPATIAL 6.**

| tag | what the gold pipeline does | what the LLM actually needs to see | canonical tasks |
|---|---|---|---|
| **CLEAN** | load one well-formed table → filter → aggregate/rank | schema + a *few* rows to confirm parse; stats mostly redundant | archeology-easy-3/10/11, wildfire-easy-8/9/13, environment-easy-1 |
| **MESSY** | header/block surgery before the table exists: skiprows, multi-level headers, embedded blocks separated by blank lines, `$1,234`/`5.2M` cleaning, footers, encodings | **raw sample rows, many of them, verbatim** — until the parse converges; column stats on garbage columns are noise | all 30 legal (FTC CSN files), Boston-Harbor env-hard-8..13, archeology xlsx (skip 5 metadata rows), biomedical multi-sheet xlsx |
| **UNION** | iterate a file family (per-year, per-state, per-station), normalize, concatenate | ONE exemplar file's shape + the file list; after concat, aggregate-level stats. Repeating 22 near-identical loader observations is pure waste | environment-easy-2/6 (22 yearly CSVs), legal MSA folders (50 state files), environment-hard-16/19 |
| **JOIN** | merge 2+ tables on keys, where key hygiene is the trap: case, `@`-suffixes, state abbrev vs full name, cross-state MSA hyphens, sample-ID sets | **key-column stats**: distinct counts, top-k values, formats on BOTH sides pre-join; row-count deltas post-join | wildfire-hard-4/5/10/21, environment-hard-7/10, archeology-hard-9, legal-hard-1/2/23, biomedical ID-set joins |
| **TEXT** | regex/positional extraction from non-tabular text (bulletins, TLE, SP3, fixed-width OMNI2) | raw file content with **long line limits**; a "table render" is actively misleading; column stats meaningless | astronomy-easy-1/6, astronomy-hard-8..12, legal-easy-19/20/21 (block files) |
| **TSMODEL** | resample/lag/regression/model-fit over long numeric series, often multi-step code building on prior steps | temporal coverage (min/max dates, gaps), units; sample rows beyond ~3 are useless; **prior operators' code** matters because later steps extend it | astronomy-hard-7/9/10, wildfire-hard-12/18, environment-hard-14 |
| **SPATIAL** | geo joins / coordinate radius queries (gpkg, KDTree) | schema + CRS metadata; geometry cells are enormous — must be truncated aggressively | wildfire-easy-2/3, archeology-easy-6/hard-7/hard-9 |

Judgment note: biomedical looks CLEAN by keywords but is really **workbook navigation +
ID-set joins** — multi-sheet xlsx where a README sheet names the data sheet
(biomedical-hard-7 literally requires reading the README sheet to find the right sheet),
then sample-ID matching across workbooks. Tagged MESSY+JOIN in the appendix.

## 4. Knob taxonomy

### 4.1 Data knobs (what an operator observation shows)

| id | knob | status | mechanism |
|---|---|---|---|
| D1 | `maxResultRows` (sample rows rendered) | ✅ implemented | more rows → parse/anomaly discovery; fewer → cheap |
| D2 | `maxOperatorResultCharLimit` / `CellCharLimit` | ✅ | long lines/cells survive or die (critical for TEXT/MESSY/SPATIAL) |
| D3 | `columnStats` on/off | ✅ | distinct/top-k/min-max per column |
| D4 | stats richness (basic vs old-rich: top_10-always + datetime-detect + type-ordering) | ⚠️ two variants exist (fe91739 vs current) — make it a level | key-value discovery for JOIN; noise for TEXT |
| D5 | `operatorResultSerializationMode` (table/csv/raw) | ✅ partially | **raw-text preview** for TEXT/MESSY files vs parsed-table render |
| D6 | **sample-selection policy**: head vs random vs "interesting rows" (nulls, extremes, distinct exemplars, rows that failed coercion) | 💡 new | head-N hides tail anomalies (footers! sentinel values!) — MESSY tasks fail exactly on what head-N doesn't show |
| D7 | **column projection**: render only columns lexically/semantically related to the task query (+ count of hidden ones) | 💡 new | 30-col tables where 3 matter; directly cuts the widest observations |
| D8 | schema-only vs schema+sample (`schemaInResult`) | ✅ | floor level for settled operators |
| D9 | lineage/cardinality hints: input→output row ratio, join-key overlap % (`dataHints`, `flowLevel` rungs) | ✅ | post-join sanity for JOIN |
| D10 | `valueFormat` hints (separators, K/M, sentinel markers) | ✅ | MESSY parse acceleration |

### 4.2 Flow knobs (history & DAG rendering)

| id | knob | status | mechanism |
|---|---|---|---|
| F1 | **code-in-context level**: full code / signature+summary / errored-only / none — per operator | 💡 new as a *graded, per-operator* knob | TSMODEL builds on prior code; CLEAN doesn't need it; code is the biggest per-operator token block |
| F2 | history depth: `contextMode`, `contextWindowTokens`, `compactionStrategy`, `deckSampleRatio` | ✅ | known: compress > sliding at 3k |
| F3 | **operator-family folding**: collapse N structurally-similar operators (22 per-year loaders) into one exemplar render + "…and 21 more like this (ids, row counts)" | 💡 new | UNION tasks currently pay 22× near-identical observations |
| F4 | **DAG-shape-aware budget allocation**: frontier & pre-join operators get high detail; settled chain interiors decay to schema-only | 💡 new — this IS the per-operator dynamic tuner | the shape (chain vs join vs fan-in) tells you where information is consumed |
| F5 | error verbosity (clipped + user-code line vs full) | ✅ recent work | |
| F6 | `thoughtReplay`/`attemptReflection`/`errorReflection` | ✅ | loop-breaking on MESSY retry cycles |

### 4.3 The archetype × knob hypothesis matrix (the judgment deliverable)

`↑` = raising/enabling should help accuracy (expect `knob_needed` labels);
`↓` = lowering/disabling should be free savings (expect `prefer_cheap`);
`✗` = enabling should hurt or waste (expect `rich_distracts`).

| | D1 rows | D2 char/cell | D3/D4 stats | D5 raw-mode | D6 smart-sample | D7 col-proj | F1 code | F3 folding | F4 shape-budget |
|---|---|---|---|---|---|---|---|---|---|
| **CLEAN** | ↓ (3–5 enough) | ↓ | ✗/↓ | – | – | ↓ helps | ↓ none | – | ↓ everywhere |
| **MESSY** | **↑ at load, ↓ after converge** | ↑ cell | ✗ pre-parse, ↑ post-parse | ↑ | **↑↑** (tails, footers, sentinels) | ✗ (can hide the problem col) | errored-only | – | ↑ on unconverged loaders |
| **UNION** | ↓ per-file (3) | ↓ | ↑ on concat result only | – | – | – | ↓ | **↑↑** | ↑ on the concat node |
| **JOIN** | ↔ (8–20) | ↔ | **↑↑ (distinct/top-k both sides, pre-join)** | – | ↑ key exemplars | ↑ keys+task cols | ↓ | – | ↑ on join inputs |
| **TEXT** | ↑ raw lines | **↑↑ cell/line** | **✗** | **↑↑** | – | ✗ | ↓ | – | – |
| **TSMODEL** | ↓ (3) | ↓ | ↑ min/max/coverage only | – | – | ↑ | **↑ (live chain code)** | – | ↑ on frontier |
| **SPATIAL** | ↓ | **↓↓ geometry cells** | ↑ CRS/bounds | – | – | ↑ drop geometry col | ↓ | – | – |

Two cells matter most, because they are *directional within one task* and thus prove the
dynamic-tuning thesis:
- **MESSY / D1**: rows must go **up** while the loader is unconverged and **down** after —
  the user's motivating intuition, testable on 55 tasks.
- **JOIN / D3-D4**: stats must be **on** at the pre-join step specifically; they can be
  off before and after — per-step, per-operator value.

## 5. The paired partial-run probe design

### 5.1 Unit of data: a **probe**

```
probe = (task, base-trace checkpoint t, knob k, value A vs value B,
         bounded continuation under each, milestone scoring, ΔQ, Δtokens)
```

1. **Seed trace:** run the task once under the center config (current best baseline),
   persisting per-step checkpoints: message history + workflow + per-operator results +
   knob vector. (The agent already snapshots workflow+results per step; message-history
   export/re-seed is the new piece — E4 below.)
2. **Fork:** instantiate two agents from the same checkpoint, identical except knob k
   set to A vs B. Run both.
3. **Bounded horizon — this is the "partial" part.** Stop each branch at the first of:
   - **milestone reached**: an operator output that the nearest unmet gold subtask
     answer can score (match via `benchmark/metrics.py` answer-type scorers);
   - **k = 5 steps**;
   - task completion (allowed for a budget-capped subset to calibrate milestone-vs-final
     agreement).
4. **Score:** `Q = milestone score (0/1 or metric) − λ·branch tokens`; also record
   execution success, error count, steps used.
5. **Twin controls:** for ~15% of probes run **A vs A** (identical settings, both
   branches). This measures the stochastic divergence floor ε; a knob effect is only a
   label when |Q_A − Q_B| exceeds the twin-pair noise quantile. Without this, LLM
   nondeterminism pollutes every label.

### 5.2 Probe placement — where to fork (archetype-directed)

| archetype | checkpoint to fork at | knob pair | expected direction |
|---|---|---|---|
| MESSY | **step after first loader attempt** (converged or not) | D1: rows 5 vs 50; D6 head vs interesting; D5 parsed vs raw; D10 on/off | high/raw/smart wins while unconverged |
| MESSY (late) | first step where loader schema stable & error-free | D1: keep 50 vs drop to 5 | equal accuracy, B cheaper → `prefer_cheap` |
| JOIN | step where ≥2 inputs materialized, join not yet built | D3/D4: stats off vs rich | rich wins (key mismatch caught pre-join) |
| JOIN (post) | step after join executed | D9 lineage hints on/off | hints catch silent 0-row/exploded joins |
| UNION | step after 2nd sibling loader | F3 folding on/off (needs impl); D1 per-file 3 vs 20 | folding equal-accuracy cheaper |
| TEXT | first observation of the text file | D5 table vs raw; D2 cell 200 vs 2000 | raw/long wins |
| TSMODEL | mid-pipeline (≥2 transform ops live) | F1 code full vs none; D1 3 vs 20 | code retention wins; rows indifferent |
| CLEAN | step 2 | D1 20 vs 3; D3 on vs off | indifferent → both are savings labels |
| SPATIAL | first geo load | D2 cell clamp tight vs loose | tight equal-accuracy cheaper |

Plus a **control block**: ~10% of probes are (archetype, knob) pairs the matrix predicts
are *indifferent* (e.g. stats on TEXT, code on CLEAN). If effects show up only where
predicted, the hypothesis map itself is validated — that's a headline figure, and it
guards against the map just being confirmation bias.

### 5.3 Volume & budget

- Baseline full-task cost ≈ $0.043; a bounded 5-step branch ≈ 1/4 of that ≈ **$0.01**.
- Plan: ~80 tasks (skip astronomy-hard-11) × 2 probe points × 2 branches ≈ 320 branches,
  + 15% twins + 10% controls ≈ **~400 branches ≈ $4–6 in LLM spend** per probe wave.
  Even 5 waves (different knob pairs) is < $30 — the cost lives in engineering, not tokens.
- Each wave yields ~160 labeled probes → after a few waves, ~10³ (state, knob, ΔQ)
  records: right-sized for the GBDT tuner in `KNOB_TUNING_PLAN.md` Phase 4.

### 5.4 Training record schema

```jsonc
{
  "task_id": "legal-hard-2", "archetypes": ["MESSY","JOIN","UNION"],
  "checkpoint_step": 4,
  "state_features": { /* context-ml φ: flow/data/temporal + loader_converged,
                         pre_join, n_sibling_loaders, error_active, tokens_spent */ },
  "knob": "maxResultRows", "value_a": 5, "value_b": 50,
  "milestone_subtask": "legal-hard-2-4",
  "q_a": 0.0, "q_b": 1.0, "tokens_a": 8100, "tokens_b": 11400,
  "steps_a": 5, "steps_b": 3,
  "twin_noise_band": 0.18,
  "label": "knob_needed", "confidence": 0.82
}
```

`state_features` must be computable at runtime (no future info) — they are exactly the
tuner's input. The label compiles to: *in states like this, this knob at this level is
worth its tokens (or not)*.

### 5.5 What the dataset teaches, by construction

- MESSY early probes + MESSY late probes on the *same tasks* → the **raise-then-lower
  schedule** for sampling size, learned from data rather than asserted.
- JOIN pre-join probes → *stats are a per-step, per-operator decision*, not a run flag.
- CLEAN/control probes → the savings floor (how lean can observations go, per archetype).
- Twin pairs → honest confidence weights for every label.

## 6. Engineering checklist (delta over KNOB_TUNING_PLAN.md's E-items)

| # | item | needed for |
|---|---|---|
| P1 | Checkpoint export/import: dump message history + workflow + results at step t; boot a new agent from the dump (deterministic re-seed, engine results replayed from snapshot cache, not re-executed) | all probes |
| P2 | Milestone scorer: map an operator output table/value to the nearest unmet subtask answer via `benchmark/metrics.py`; needs answer-type-aware extraction from result tables | partial scoring |
| P3 | Probe runner: place forks per §5.2 rules (loader-converged detector, pre-join detector, sibling-loader counter — all computable from the DAG + results) | targeting |
| P4 | New knobs used by probes: D6 sample-selection policy, F3 family folding, F1 graded code-in-context, D7 column projection (implement in priority order D6 → F3 → F1 → D7; each is a rendering-layer change in `result-formatting.ts` / context assembly, no engine change) | waves 2+ |
| P5 | Twin-noise calibration report (ε per archetype) | label validity |

Wave 1 can run with **zero new knobs** (D1/D2/D3/D5 exist today) — only P1–P3 block it.

## 7. Execution order

1. **P1–P3** (checkpoint fork + milestone scorer + probe placement).
2. **Wave 1 (existing knobs):** MESSY×D1 early/late, JOIN×D3, TEXT×D5/D2, CLEAN×D1/D3
   + twins + controls. ~400 branches. Analyze: effect sizes vs twin noise, per archetype.
3. **Gate:** if MESSY×D1-early and JOIN×D3 show real effects and CLEAN shows clean
   `prefer_cheap`, the dynamic thesis is confirmed → invest in P4 knobs.
4. **Waves 2–3:** D6 smart sampling, F3 folding, F1 code levels — the imaginative knobs,
   now measured with the same machinery.
5. Feed all records into the Phase-4 tuner (`KNOB_TUNING_PLAN.md`): behavior-cloned GBDT
   over `state_features` → per-knob decisions at boundary states.

---

## Appendix A — per-task archetype assignments (all 104)

| task | archetypes | src | answer | gold ops |
|---|---|---|---|---|
| archeology-hard-1 | MESSY | 2 (xlsx×2) | numeric_exact | agg,rank,unit |
| archeology-hard-2 | MESSY | 2 (xlsx×2) | numeric_exact | stat,unit |
| archeology-easy-3 | CLEAN | 1 (csv×1) | numeric_exact | filter,agg,rank,unit |
| archeology-easy-4 | MESSY | 1 (xlsx×1) | numeric_exact | filter,rank,stat,unit |
| archeology-hard-5 | MESSY | 2 (xlsx×2) | numeric_exact | filter,rank |
| archeology-easy-6 | SPATIAL | 1 (csv×1) | string_exact | filter,rank |
| archeology-hard-7 | SPATIAL | 2 (csv×2) | numeric_exact | filter,agg,rank |
| archeology-easy-8 | CLEAN | 1 (csv×1) | numeric_exact | filter,rank |
| archeology-hard-9 | JOIN+SPATIAL | 2 (csv×2) | numeric_exact | join,filter,agg,rank,stat,unit |
| archeology-easy-10 | CLEAN | 1 (csv×1) | string_exact | agg,rank |
| archeology-easy-11 | CLEAN | 1 (csv×1) | numeric_exact | filter,agg,rank |
| archeology-hard-12 | CLEAN | 2 (csv×2) | numeric_exact | filter,agg,rank |
| astronomy-easy-1 | TEXT+UNION+TSMODEL | 4 (txt×4) | numeric_exact | regex,time,stat,multifile |
| astronomy-easy-2 | CLEAN | 2 (csv×2) | numeric_exact | agg,rank,stat |
| astronomy-easy-3 | JOIN+UNION | 2 (csv×2) | numeric_exact | join,filter,agg,multifile,unit |
| astronomy-easy-4 | TSMODEL | 1 (csv×1) | string_approximate | filter,agg,rank,time,stat |
| astronomy-easy-5 | UNION | 1 (tle×1) | numeric_exact | agg |
| astronomy-easy-6 | TEXT+JOIN | 2 (csv×2) | list_approximate | join,regex,agg,time,unit |
| astronomy-hard-7 | JOIN+UNION+TSMODEL | 6 (csv×6) | numeric_exact | join,rank,time,stat |
| astronomy-hard-8 | TEXT+JOIN+TSMODEL | 3 (lst×2,cdf×1) | list_approximate | join,regex,agg,rank,stat,unit |
| astronomy-hard-9 | TEXT+JOIN+TSMODEL | 3 (tle×1,dat×1,txt×1) | numeric_exact | join,filter,agg,time,stat,unit |
| astronomy-hard-10 | TEXT+JOIN+UNION+TSMODEL+SPATIAL | 3 (csv×2,sp3×1) | list_exact | join,regex,filter,agg,time,stat,multifile,unit |
| astronomy-hard-11 | MESSY+TEXT+UNION+TSMODEL | 4 (txt×2,dat×2) | numeric_exact | filter,agg,stat,unit |
| astronomy-hard-12 | TEXT | 2 (sp3×1,npz×1) | numeric_exact | regex,filter,agg,unit |
| biomedical-hard-1 | MESSY+JOIN | 2 (xlsx×2) | numeric_exact | filter,rank,stat |
| biomedical-easy-2 | MESSY | 1 (xlsx×1) | numeric_exact | filter,agg |
| biomedical-hard-3 | MESSY+JOIN | 2 (xlsx×2) | numeric_exact | filter,rank |
| biomedical-hard-4 | MESSY+JOIN | 2 (xlsx×2) | list_exact | filter |
| biomedical-hard-5 | MESSY+JOIN | 2 (xlsx×2) | numeric_exact | filter,stat,unit |
| biomedical-easy-6 | MESSY | 1 (xlsx×1) | string_exact | filter,rank |
| biomedical-hard-7 | MESSY | 1 (xlsx×1) | numeric_exact | agg |
| biomedical-hard-8 | MESSY+JOIN | 3 (xlsx×2,csv×1) | list_exact | filter |
| biomedical-easy-9 | MESSY | 1 (xlsx×1) | numeric_exact | filter,agg |
| environment-easy-1 | CLEAN | 1 (csv×1) | numeric_exact | filter,agg,stat |
| environment-easy-2 | UNION | 22 (csv×22) | list_exact | filter,agg,time |
| environment-easy-3 | JOIN+UNION | 2 (csv×2) | numeric_exact | join,agg,rank,multifile,unit |
| environment-easy-4 | UNION+TSMODEL | 5 (csv×5) | numeric_exact | filter,agg,stat,unit |
| environment-easy-5 | UNION | 4 (csv×4) | string_exact | filter,agg,rank,time,unit |
| environment-easy-6 | UNION | 21 (csv×21) | numeric_exact | filter,agg,unit |
| environment-hard-7 | JOIN | 2 (csv×2) | numeric_exact | join,filter,agg,stat,unit |
| environment-hard-8 | MESSY+UNION | 9 (txt×1,csv×8) | numeric_exact | filter,agg,stat,multifile |
| environment-hard-9 | MESSY+UNION | 9 (txt×1,csv×8) | list_exact | filter,multifile,unit |
| environment-hard-10 | MESSY+TSMODEL | 3 (csv×3) | numeric_exact | filter,stat,unit |
| environment-hard-11 | MESSY+UNION | 1 (csv×1) | numeric_exact | filter,agg,time,multifile,unit |
| environment-hard-12 | MESSY+UNION | 9 (txt×1,csv×8) | string_approximate | filter,agg,rank,multifile,unit |
| environment-hard-13 | MESSY+UNION | 1 (csv×1) | numeric_exact | filter,agg,multifile,unit |
| environment-hard-14 | UNION+TSMODEL | 7 (csv×7) | string_exact | filter,agg,time,stat |
| environment-hard-15 | UNION | 4 (csv×4) | string_exact | filter,agg,rank,time |
| environment-hard-16 | UNION | 22 (csv×22) | numeric_exact | filter,agg |
| environment-hard-17 | CLEAN | 2 (csv×2) | numeric_exact | filter,agg,rank,time,stat,unit |
| environment-hard-18 | MESSY+UNION | 8 (csv×8) | string_approximate | filter,agg,time,stat |
| environment-hard-19 | UNION | 24 (csv×24) | string_exact | filter,agg,rank,time,stat,multifile,unit |
| environment-hard-20 | UNION | 5 (csv×5) | list_exact | filter,agg,rank,time,unit |
| legal-hard-1 | MESSY+TEXT+JOIN+UNION | 2 (html×1,dir×1) | numeric_exact | join,regex,filter,agg,rank,multifile,unit |
| legal-hard-2 | MESSY+JOIN+UNION | 2 (html×1,dir×1) | string_approximate | join,rank,multifile,unit |
| legal-easy-3 | MESSY | 1 (csv×1) | numeric_approximate | rank,stat,unit |
| legal-easy-4 | MESSY | 1 (csv×1) | numeric_exact | filter,agg,unit |
| legal-easy-5 | MESSY | 1 (csv×1) | numeric_exact | agg,rank,unit |
| legal-hard-6 | MESSY+JOIN | 1 (csv×1) | numeric_exact | join,agg,rank,stat |
| legal-hard-7 | MESSY+TEXT | 1 (csv×1) | string_exact | regex,filter,rank,stat |
| legal-hard-8 | MESSY+JOIN | 2 (csv×2) | string_exact | join,rank,unit |
| legal-easy-9 | MESSY | 1 (csv×1) | numeric_exact | agg,rank,time,unit |
| legal-easy-10 | MESSY | 1 (csv×1) | list_exact | agg,rank,stat |
| legal-easy-11 | MESSY+UNION | 1 (csv×1) | string_exact | agg,rank,stat |
| legal-easy-12 | MESSY | 1 (csv×1) | numeric_exact | agg,rank,stat,unit |
| legal-easy-13 | MESSY | 1 (csv×1) | numeric_exact | rank,stat,unit |
| legal-hard-14 | MESSY+UNION | 2 (csv×2) | list_exact | rank,multifile |
| legal-hard-15 | MESSY+TEXT+UNION | 1 (csv×1) | numeric_exact | regex,filter,agg,unit |
| legal-hard-16 | MESSY+UNION | 1 (csv×1) | string_exact | filter,agg,rank,stat,multifile,unit |
| legal-hard-17 | MESSY | 2 (csv×2) | numeric_exact | agg,stat,unit |
| legal-hard-18 | MESSY | 3 (csv×3) | numeric_exact | agg,stat,unit |
| legal-easy-19 | MESSY+TEXT+UNION | 1 (csv×1) | numeric_exact | regex,agg |
| legal-easy-20 | MESSY+TEXT | 1 (csv×1) | numeric_exact | regex,filter,agg,stat,unit |
| legal-easy-21 | MESSY+UNION | 1 (csv×1) | numeric_exact | agg,unit |
| legal-hard-22 | MESSY | 2 (csv×2) | numeric_exact | agg,stat,unit |
| legal-hard-23 | MESSY+TEXT+JOIN+UNION | 2 (csv×2) | string_approximate | join,regex,agg,rank,multifile |
| legal-hard-24 | MESSY+UNION | 3 (csv×3) | string_exact | agg,rank,multifile,unit |
| legal-easy-25 | MESSY | 1 (csv×1) | string_approximate | rank,stat,unit |
| legal-easy-26 | MESSY | 1 (csv×1) | list_exact | agg,rank,unit |
| legal-easy-27 | MESSY | 1 (csv×1) | numeric_exact | rank,unit |
| legal-hard-28 | MESSY | 2 (csv×2) | string_exact | agg,stat,unit |
| legal-hard-29 | MESSY+UNION | 1 (csv×1) | string_exact | filter,agg,rank,stat,unit |
| legal-hard-30 | MESSY+UNION | 2 (csv×2) | string_exact | unit |
| wildfire-easy-1 | MESSY | 1 (csv×1) | numeric_exact | agg,rank,time,unit |
| wildfire-easy-2 | JOIN+SPATIAL | 2 (gpkg×2) | string_exact | join,filter,agg,rank,stat,unit |
| wildfire-easy-3 | JOIN+SPATIAL | 2 (gpkg×2) | list_exact | join,agg,rank,stat,unit |
| wildfire-hard-4 | JOIN+UNION | 2 (csv×2) | numeric_exact | join,agg,rank,unit |
| wildfire-hard-5 | MESSY+JOIN+UNION | 2 (csv×2) | numeric_exact | join,agg,time |
| wildfire-hard-6 | MESSY+JOIN+TSMODEL | 2 (csv×2) | numeric_approximate | join,agg,time,stat,unit |
| wildfire-hard-7 | MESSY+TSMODEL | 2 (csv×2) | string_approximate | agg,rank,time,stat,unit |
| wildfire-easy-8 | CLEAN | 1 (csv×1) | string_exact | filter,agg,unit |
| wildfire-easy-9 | CLEAN | 1 (csv×1) | numeric_approximate | filter,agg |
| wildfire-hard-10 | JOIN+UNION | 3 (csv×3) | string_exact | join,agg,rank,multifile |
| wildfire-hard-11 | CLEAN | 1 (csv×1) | string_exact | agg,rank |
| wildfire-hard-12 | UNION+TSMODEL | 1 (csv×1) | string_approximate | agg,time,stat,unit |
| wildfire-easy-13 | CLEAN | 1 (csv×1) | string_approximate | agg,rank |
| wildfire-hard-14 | JOIN+TSMODEL | 2 (csv×2) | numeric_approximate | join,agg,time,stat,unit |
| wildfire-easy-15 | TSMODEL | 2 (csv×2) | string_exact | filter,stat |
| wildfire-hard-16 | CLEAN | 2 (csv×2) | list_exact | filter,stat,unit |
| wildfire-hard-17 | CLEAN | 3 (csv×3) | numeric_approximate | filter,agg,unit |
| wildfire-hard-18 | TSMODEL | 2 (csv×2) | string_approximate | agg,stat |
| wildfire-hard-19 | JOIN | 3 (csv×3) | numeric_approximate | join,filter,agg,rank,stat,unit |
| wildfire-hard-20 | CLEAN | 2 (csv×2) | numeric_exact | filter,agg,rank,stat |
| wildfire-hard-21 | JOIN+UNION | 4 (csv×3,json×1) | list_exact | join,filter,agg,rank,time,unit,pivot |
