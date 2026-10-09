# Learned Context Selection — Concrete Action Plan (implementation → trained model → e2e result)

Operationalizes `bobflow_context_selection_training_pipeline.md` (the method) and
`ML_TRAINING_PLAN.md` (stage-0 capture gap, LightGBM, ablation falsifier) into one
executable sequence against the code that actually exists. Incorporates the agreed
revisions: thrash-reduction as primary endpoint, mandatory noise-floor calibration,
hierarchical (group→item) interventions, attempt signatures in bundles, TS-side
collection / Python-side training only.

**Total estimate: ~15–20 engineering days + ~4–6 days of compute (parallelizable).
LLM cost order $50–200 at gateway prices. Wall-clock, not dollars, is the binding
constraint.**

---

## What we reuse (discovered by codebase survey, 2026-07-05)

| Need (pipeline doc §) | Already exists | Where |
|---|---|---|
| Endpoint renderers (§3) | `latestPreset()` / `deltaPreset()` over the single `summarize()` renderer, golden-parity tested | `agent-service/src/agent/context/summarize/params.ts`, `summarize.ts` |
| State to bundle-ize (§4) | `Dossier`: per-op `CodeVersion[]` (code, summary, **status + statusLine** = attempt signatures), `ResultVersion[]`, `deleted` | `context/summarize/dossier.ts` |
| Replayable state (§5) | `WorkflowSnapshotStorage` (per-step `WorkflowContent` + `Map<opId, OperatorInfo>` with staleness-aware inheritance `computeStaleResultOps`), `importReActSteps`, `checkout(stepId)` — both HTTP-exposed | `agent/workflow-snapshot-storage.ts`, `texera-agent.ts`, `server.ts` (`POST /:id/import-react-steps`, `POST /:id/checkout`) |
| Raw results (not rendered text) | `OperatorInfo.result: Record<string,any>[]` retained in memory per snapshot | `types/execution.ts`, snapshot storage |
| Per-op features (§9 partial) | `OperatorFeatures` (role, editCount, stepsSinceEdit, isErroring, hasHealthyConsumer, wide, dirtyLoad, categoricalLowCard, numericAsText) | `context/selector/features.ts` |
| Scorer (§13) | `scoreKramabench` answer-type-aware, validated 39/39 vs recorded evaluation.json | `benchmark/llm-training-data-generation/adapters/kramabench.ts` |
| Run lifecycle + resume pattern | `run.ts` (login → dataset → CU → agent → WS turn → artifacts), A/B scripts' append-only `results.jsonl` + done-set resume | `benchmark/llm-training-data-generation/` |
| Rule baseline (§13.1) | `selectorConfig.thrashHistoryThreshold` (thrash-triggered history) | `context/selector/selector.ts` |
| Config injection | `PATCH /:id/settings` already validates `summarizeParams` / `selectorConfig` / `tunerConfig` | `server.ts` |

## What must be built (the actual gaps)

1. **Capture gap (blocking, = ML_TRAINING_PLAN Stage 0):** `TraceRecord.snapshots`
   serialize `workflow` only — per-step `OperatorInfo` result maps are dropped;
   `react_steps.json` observations are rendered text. Export/import must carry results.
2. Bundle extractor + bundle renderer + bundle featurizer (pure functions over Dossier).
3. Replay eval harness (checkpoint → variant context → one step → execute → score).
4. Intervention runner + label assembly.
5. Python training package + TS inference (forest-as-JSON evaluator).
6. `learnedConfig` context-assembler branch + e2e eval script.

Known constraints: no `seed` support in drivers (temperature 0.2 vercel / 0 local) →
noise floor is mandatory. Full 8-service JVM stack + infra + LiteLLM gateway + agent-service
required for anything that executes.

---

## Phase 0 — Environment, data, decision lock (0.5–1 day)

- [ ] Branch: `feat/learned-context-selection` off `main`.
- [ ] Unzip task specs to where the adapter expects them:
  `unzip ../Kramabench/llm-training-set-v1-kramabench.zip -d ./llm-training-set-v1-kramabench`
  (repo-root; `data/` symlink → `../Kramabench/data` already valid).
- [ ] Bring up stack per CLAUDE.md: infra compose → 8 JVM services (sbt bgRun one-liner)
  → LiteLLM gateway (`bin/litellm-config.yaml`, :9096) → `cd agent-service && bun run dev`.
  Smoke: `bun run e2e`.
- [ ] **Verify gateway model list** (`GET $LLM_ENDPOINT/api/models`). Config lists
  `gpt-5.2 / gpt-5-mini / claude-haiku-4.5 / gpt-4o`; gpt-5.2 is reportedly retired
  upstream — add/confirm a `gpt-5.4` route. Lock: **agent model = gpt-5.4** (fallback
  gpt-5.2 if still routed), **smoke model = claude-haiku-4.5**.
- [ ] `pyproject.toml`: add extra `ml = ["lightgbm>=4", "shap"]`; `uv sync --extra ml`.
- [ ] Decision lock (write into `agent-service/docs/learned-context-selection.md` header):
  - **FIXED_SUMMARY preset** = shipped LATEST default + `column.schema: true`, pinned as
    a named constant; hash goes into the render fingerprint. All arms, all phases.
  - **Code stripped from both endpoints; bundles carry attempt signatures**
    (`CodeVersion.statusLine` + a 1-line param digest), not code bodies.
  - **Primary endpoint** = repeated-failed-action rate + steps on the thrash tail at
    matched budget; accuracy non-inferiority secondary.
  - **Splits by domain** (6 KramaBench domains; rotate 4 train / 1 val / 1 test).

Exit: e2e green; model routes confirmed; doc header committed.

## Phase 1 — Full-state trace capture v2 (1–2 days) ← blocking everything

- [ ] `workflow-snapshot-storage.ts`: `exportSnapshotsWithResults()` → per step
  `{workflow, results: Record<opId, OperatorInfo & {sourceStepId}>}` (resolved via the
  existing ancestor walk so importers don't need inheritance logic).
- [ ] `texera-agent.ts` `importReActSteps`: accept `results` in snapshots and write them
  via `setOperatorResult`; keep the current markdown re-parse (`parse-trace-results.ts`)
  as fallback for legacy traces.
- [ ] `server.ts`: `GET /:id/export` → `{steps, snapshots(v2), settings, renderFingerprint}`;
  extend `POST /:id/import-react-steps` body symmetrically.
- [ ] **Render fingerprint** (stale-trace structural fix): `{gitSha, fixedSummaryHash,
  modelType, settingsHash}` stamped into every export + `meta.json`; replay tooling
  refuses cross-fingerprint comparison unless `--force`.
- [ ] `protocol.ts` TraceRecord v2 + `run.ts` writes it.
- [ ] Tests: live 3-op run → export → import into fresh agent → for every step t,
  `checkout(t)` and byte-compare re-rendered context vs recorded `inputMessages[0].content`.

Exit: round-trip byte-equality on 2 real tasks; golden parity suite still green.

## Phase 2 — Bundles + features (2–3 days, parallel with Phase 4a compute)

New module `agent-service/src/agent/context/bundles/`:

- [ ] `extract.ts` — `extractBundles(dossier, path): Bundle[]`, pure. Types:
  `historical_attempt` (from `CodeVersion[]`: eventIndex, summary, **attempt signature**,
  status/statusLine, error digest), `superseded_version`, `deleted_operator` (from
  `deleted` + last versions), `old_result_summary` (from `ResultVersion[<latest]`,
  rendered with FIXED_SUMMARY), `rationale` (ReAct step thoughts, 1–2 sentence cap).
  `requires` edges (error digest ⇒ its edit description). `tokenCost` = chars/4 of
  rendered text (relative cost is all knapsack needs).
- [ ] `render.ts` — deterministic rendering: appended `## Relevant history` section,
  grouped by operator, newest-first, stable order (pipeline doc §12.3).
  `C_learned = summarize(FIXED_LATEST) + renderBundles(selected)`. `summarize()` untouched.
- [ ] `featurize.ts` — extends `features.ts` outputs per bundle: type one-hots; temporal
  (age, normalized age, is_recent_{1,3,5}, before/after last failure, before/after last
  edit-of-op); version/liveness (live/deleted/superseded, num_newer_versions,
  followed_by_update/delete); DAG/lineage from `WorkflowContent` links (depth, fan-in/out,
  ancestors/descendants, ancestor-of-terminal, on-branch-of-last-edit — deleted ops use
  the pre-deletion snapshot); execution (status, error-class one-hot, failure counts,
  repeat count); data-summary scalars from `OperatorInfo` (rows, cols, null rates,
  distinct, hints flags); task-lexical overlaps (column/file name mentions, token overlap).
  **Exclude `tokenCost` from the utility feature vector** (used only at selection).
- [ ] `scripts/dump-bundles.ts` — CLI: trace + step → bundles, features, both endpoint
  contexts. Unit tests on fixtures.

Exit: dump-bundles output reviewed on 3 known-thrashy traces (legal-easy-25 pattern:
failed loader attempts must appear with distinct attempt signatures).

## Phase 3 — Replay eval harness (3–4 days) ← the hard engineering

`benchmark/llm-training-data-generation/scripts/context-replay.ts` + small server support:

- [ ] **Variant injection**: new validated setting `replayVariant: {kind: "latest"|"trajectory"|
  "latest_plus_bundles", bundleIds?: string[]}` — one more branch in `buildContextAssembler`
  precedence (before selector), assembling from the imported dossier with FIXED_SUMMARY.
- [ ] **Resume-without-new-user-text**: `messageSource: "REPLAY_RESUME"` sentinel; the
  assembler drops the sentinel step from `visibleSteps` so the model sees exactly the
  variant context mid-task. **Faithfulness golden test**: replaying step t with variant
  = recorded settings must byte-equal recorded `inputMessages[0].content` (Phase-1 test
  extended through the WS path).
- [ ] **One step only**: `maxSteps: 1`; action executes via the existing
  `runPostStepExecution` path against the CU. Data files staged by copying to
  `kramabench/data/<task.id>/` (A/B-script `stage()` pattern; no dataset service).
- [ ] `score-action.ts` — per eval: `parsedOk`, `execSuccess` (from resulting
  `OperatorInfo.error`), **`repeatsFailedAttempt`** (normalized action signature ∈ prior
  failed `CodeVersion` signatures for that op — near-deterministic, the primary label
  component), `progress` (error resolved / new healthy downstream / terminal answer),
  optional judge-match (weight 0 initially). Q = pipeline-doc cheap-mode weights,
  re-based on `repeatsFailedAttempt`.
- [ ] Cell = `(checkpointId × variant × rep)`; append-only `results.jsonl` + done-set
  resume (selector-search pattern); per-cell watchdog (default 6 min); `--concurrency`
  (default 4, `--sequential` for clean accuracy passes); hard LLM-call budget guard.

Cost per eval ≈ 1 gateway call + 1 workflow execution ≈ 15–60 s.

Exit: faithfulness test green; 20-cell smoke (2 tasks, haiku) completes with populated
scores; measured s/cell logged.

## Phase 4 — Fresh corpus + noise floor + endpoint sweep (2–3 days eng, ~2 days compute)

**4a (start as soon as Phase 1 lands; runs in background):** re-collect the trace corpus
on current code + current model — 60 KramaBench tasks × {LATEST, DELTA} endpoint policies
× v2 capture, via `run.ts`. ~120 runs. This is simultaneously: the checkpoint source
(off-policy mitigation via both collection policies), the gpt-5.4 re-baseline, and the
faithfulness reference.

**4b Checkpoint selection:** from each trace sample ~5 checkpoints, **stratified**:
immediately-after-failure, thrash-streak (op editCount ≥ 3), post-delete, pre-commit,
1 random. Target ≈ 500 checkpoints. Store `checkpoints.jsonl` (traceId, stepId, strata,
fingerprint).

**4c Noise floor (before any interventions):** 12 checkpoints (stratified) × identical
baseline variant × 8 reps → distribution of Q under the null; set `ε = 2σ_null` and rep
count R (default R=3; raise if power calc says so). Report `docs/…#noise-floor`.

**4d Endpoint comparisons:** C_traj vs C_latest at each checkpoint × R. C_latest result
cached per checkpoint (reused by Phase 5). Emit `EndpointComparison` records + case-type
distribution.

**Gate:** if informative cases (either-direction gap > ε) < ~8% of checkpoints, stop and
re-stratify harder toward the thrash tail before spending intervention budget.
Compute: ~500×2×3 = 3,000 evals ≈ 25–50 wall-clock hours at concurrency 4 → run overnight ×2.

## Phase 5 — Interventions → labels (2 days eng, ~2 days compute)

- [ ] `scripts/collect-labels.ts` — on gap checkpoints only:
  - `Q_traj > Q_latest + ε` → **add-back, hierarchical**: operator-grouped bundle sets
    first; item-level within winning groups; greedy forward-selection when no single
    group reproduces the gap.
  - `Q_latest > Q_traj + ε` → removal tests, operator/age-band-grouped first.
  - `both_success` → sampled cost-only weak negatives (weight 0.3).
  - `both_fail` → logged for error analysis, not labeled.
- [ ] `label.ts` — ΔQ = mean over R; 3-way label at ±ε; confidence = |ΔQ|/(σ+c);
  emit `BundleTrainingRecord` JSONL (features inline, context/run paths for audit).
- [ ] Volume target: **≥ 800 intervention records, ≥ 15% non-neutral.** If positives
  are scarce, spend remaining budget on more thrash-tail checkpoints, not more reps.

Compute: ~125 gap-checkpoints × ~6 evals × R=3 ≈ 2,300 evals (C_latest reused) ≈ overnight ×2.

## Phase 6 — Training (Python) (2–3 days)

New package `agent-service/training/ml/` (home per ML_TRAINING_PLAN):

- [ ] `dataset.py` (JSONL → Parquet; join; domain-fold assignment), `train.py`
  (logistic-regression headline + LightGBM with strong regularization; sample weight =
  confidence × class-balance × intervention-type), `calibrate.py` (isotonic on val fold),
  `evaluate.py` (label accuracy, positive-precision/recall, pairwise ranking accuracy,
  bootstrap CIs **clustered by checkpoint**), `ablations.py` (ladder A–F from the
  pipeline doc §11.5; the falsifier: version/liveness + DAG features must beat recency).
- [ ] 6-fold domain CV (train 4 / val 1 / test 1, rotate); report per-fold + pooled.
- [ ] Export: `lightgbm` `dump_model()` JSON (or logistic coefficients) →
  `agent-service/src/agent/context/learned/model.json` + `gbdt.ts` evaluator (~100 lines),
  unit-tested against Python predictions on 50 held rows (tolerance 1e-6).

Exit: ablation table exists; falsifier verdict stated either way; TS/Python prediction
parity test green.

## Phase 7 — Runtime selector + end-to-end eval (3–4 days eng, ~2 days compute)

- [ ] `settings.learnedConfig: {budgetTokens, modelId?}` — assembler branch
  (precedence: tuner > **learned** > selector > legacy): `buildDossier → extractBundles →
  featurize → score (û = P⁺ − P⁻) → greedy û/cost with `requires` closure → render`.
- [ ] `scripts/learned-e2e.ts` — held-out-domain tasks, arms:
  `trajectory / latest / recency-topK / random / rule-thrash (selectorConfig) / learned /
  oracle-addback (labels replayed)`; optional compress-deck at matched budget.
  × 3 reps × bundle-budget sweep {2k, 4k, 8k}. Metrics: pass (scoreKramabench),
  **repeated-failed-action count, steps**, tokens (provider `usage` now in `ReActStep.usage`,
  chars/4 as fallback). results.jsonl + summary with per-arm Pareto.
- [ ] Report: primary = thrash-tail repeated-failure/steps at matched budget; secondary
  = accuracy non-inferiority (McNemar on discordant pairs), token deltas.

Compute: ~12 test-domain tasks × 7 arms × 3 reps ≈ 250 full runs ≈ 2 overnights at
concurrency 4.

## Phase 8 — Writeup (1–2 days)

- [ ] `agent-service/docs/learned-context-selection.md`: design, noise floor, label stats,
  ablation table, e2e results, honest verdict — same register as the existing docs.
- [ ] Feed numbers into paper §4 (`bobflow_context_compaction_section4_summary.md` sibling).
- [ ] Commit all raw label/eval JSONL (the missing-oracle-labels lesson).

---

## Variant track (approved to explore) — learned compaction under a window

The primary mechanism (Phases 0–7) is push-side add-back on the LATEST core, every
step, no overflow trigger. A second deployment/training surface reuses the same
artifacts inside the existing DELTA compaction machinery:

- **Deployment:** a third `compactionStrategy: "select"` — when `contextWindowTokens`
  overflows, score the fold-candidate bundles with the same utility model; keep the
  top-û bundles at full fidelity within the window, deck/drop the rest. Head-to-head
  vs `sliding`/`compress` at the 3k operating point on the same 103-task setup as
  `context-window-compaction-experiments.md`.
- **Training directly on compaction calls:** checkpoint at each window-overflow step
  (a natural, system-triggered checkpoint policy), then run the same Phase-3/5
  intervention machinery under DELTA+window settings — label folded-vs-kept bundles
  by ΔQ. This gives labels on exactly the states where compaction fires.
- **Caveats (why this is a variant, not the primary):** overflow checkpoints are a
  biased state distribution (only long/thrashy tasks overflow — which is also exactly
  where compaction matters); and a utility model trained on LATEST add-backs may
  transfer imperfectly to the DELTA fold decision — treat transfer-vs-retrain as an
  empirical question, not an assumption.
- **Effort:** ~2–3 days on top of Phase 7 (reuses extractor, featurizer, model, and
  the existing compaction hook).

## Critical path & parallelism

```
P0 → P1 → P2 ──→ P3 → P4c → P4d → P5 → P6 → P7 → P8
          └→ P4a (compute, background from end of P1) → P4b
```

## Risk register

| Risk | Mitigation |
|---|---|
| Case-type imbalance (few informative checkpoints) | Stratified sampling + the Phase-4 8% gate before intervention spend |
| ΔQ noise swamps ε (no seed support) | Noise floor first; `repeatsFailedAttempt` is near-deterministic; R from power calc; `--sequential` mode |
| Replay infidelity | Byte-equality golden test through the WS path; fingerprint refusal on mismatch |
| Stack hangs (known: ~40% on past mini runs) | Per-cell watchdog + append-only resume; low default concurrency |
| Model drift (gpt-5.2 retired) | Phase-0 route verification; fingerprint pins model; corpus re-collected on locked model |
| Label volume too small for GBDT | Logistic headline; trees regularized; pairwise records only if volume supports |
| Positives all trivially "recency" | Ablation ladder is the falsifier; report it either way |
