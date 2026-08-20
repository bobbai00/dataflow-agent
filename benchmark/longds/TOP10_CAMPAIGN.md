# Top-10 LongDS campaign — session vs versioned, 3 rounds + iteration

**2026-08-19/20 · gpt-5.6-luna (medium reasoning) · 10 longest LongDS tasks ·
judge: deepseek-v4-pro via OpenRouter (the paper's own judge)**

Goal (user): run the 10 longest tasks in both layouts 3×, collect
accuracy+cost correctly, deep-dive flips in both directions with direct trace
evidence on retrieval, and iterate to a versioned config **cheaper and better
than session**.

## 1. What ran

| round | session arm | versioned arm | packaging |
|---|---|---|---|
| r1 | Top10Session | Top10V32 (v3.2-fix) | legacy render (anchor) |
| r2 | +cacheAlignedContext | +cacheAlignedContext | frozen render + appends |
| r3 | *(skipped by user decision)* | +upstreamValueEcho +answerShapeRule ("fix pack") | cache-aligned |
| sub5 ×3 reps | SessionR3 (3rd session rep, subset) | **v33** = cacheAligned + answerShapeRule + **catalogDetail: "code"** | cache-aligned |

Sub5 subset = the 5 signal tasks (largest ses↔v32 diffs over r1–r2): kaggle
t3, nfl t1, acea2, acea3, wids1. The other five top-10 tasks (cdp, LA, cpe×2,
wids2) score at the floor in every arm (0–20) and carry no iteration signal.

## 2. Full top-10, per round (judged turn-share %, one run each)

| task | ses-r1 | v32-r1 | ses-r2 | v32-r2 | v32-r3fx |
|---|---|---|---|---|---|
| kaggle-survey t3 | 8.1 | 75.7 | 89.2 | 81.1 | 54.1 |
| acea2 | 50.0 | 55.3 | 81.1 | 65.8 | 50.0 |
| acea3 | 100.0 | 75.7 | 97.3 | 94.6 | 78.4 |
| cdp | 0.0 | 0.0 | 2.6 | 2.6 | 2.6 |
| wids1 | 60.0 | 35.0 | 42.5 | 48.7 | 42.5 |
| wids2 | 50.0 | 54.8 | 38.2 | 22.2 | 33.3 |
| cpe t1 | 19.4 | 5.6 | 2.8 | 19.4 | 19.4 |
| cpe t2 | 22.9 | 22.2 | 15.2 | 8.3 | 8.6 |
| LA city | 2.8 | 2.9 | 2.8 | 2.9 | 2.8 |
| nfl | 7.1 | 31.0 | 42.9 | 9.5 | 4.9 |
| **mean** | **32.0** | **35.8** | **41.5** | **35.5** | **29.7** |

- **cacheAlignedContext** (r2): cost mechanism, works — 85–99% cached/step,
  the luna deployment only cache-hits on whole-request extension (probed:
  append-only message array → hit; any intra-message change → 0).
- **Fix pack** (r3): net **negative** (29.7 vs r2's 35.5). answerShapeRule
  verified on its target (acea2 t1 flipped 0→1, flat verbatim keys);
  upstreamValueEcho fired correctly but bought nothing measurable — losses
  traced to ordinary cascade draws (e.g. kaggle t14 base-population choice
  with echo inactive). **Echo retired; shape rule kept.**

## 3. Randomness (the reps were bought to measure it)

Per-task rep spread (max−min) on the subset: session 2.7–81.1 pts (kaggle:
8.1 → 89.2 across reps!), v33 7.9–37.8. Single runs are lottery tickets;
per-task medians of ±10–20 pts are normal. This is cascade structure: 93–94%
of wrong turns inherit from an already-wrong upstream, median first error at
turn 2–3, so one early derivation draw decides dozens of turns.

## 4. Sub5 endpoint — 3 reps per arm

Per-task rep-means (3r except v32=2r):

| task | session | v32 | v33 |
|---|---|---|---|
| kaggle t3 | 57.7 | 78.4 | 51.4 |
| nfl | 22.4 | 20.2 | 17.7 |
| acea2 | 71.8 | 60.5 | **76.1** |
| acea3 | 98.2 | 85.1 | 91.9 |
| wids1 | 51.3 | 41.9 | 50.6 |
| **arm mean** | **60.2** | 57.2 | 57.5 |

Pooled turn-level (the tight comparison): **session 59.2% ± 4.0 (n=579),
v33 56.6% ± 4.0 (n=576), v32 56.1% ± 4.9 (n=387)** — all 95% CIs overlap.

Cost per task-run: **session $1.233 · v32 $1.042 · v33 $0.618**.

**Verdict: v33 reaches session-level accuracy (indistinguishable within CI)
at 50% of session's cost** — plus the versioned layout's structural
properties (exact version addressing, immutable history, recall). "Cheaper"
is decisively met; "better" on accuracy is parity-within-noise, not a win —
the honest reading at this sample size.

## 5. Flip evidence, both directions (trace-grounded)

**Versioned wins because of retrieval** (r2, full-10): cpe t4/t5 — the task
demands revising an earlier state; v32 pulled
`uof_common_results_revised (turn 4)` with `recallState`, applied the delta
against the exact recorded version and scored; session reconstructed the
state from its inline history and drifted. Direct: the recall call and the
correct delta are in the same turn's trace.

**Session wins because code was visible** (r2): the dominant versioned loss
class is **convention re-derivation** — rebuilding an inherited metric's
formula/denominator/normalization from the operator's *name*:
- nfl t3: 9 blind cross-turn writes, wrong denominator → 14 dependent turns
  lost;
- acea2 t6: feature-prep re-derived, RF test_rmse 0.5352 vs session's 0.3883;
- kaggle t18: population drift (Africa 10 vs 11 countries).
Session avoids all of these by reading prior turns' code inline.

**The v33 mechanism closes exactly that class** (`catalogDetail: "code"` —
each version's code rendered once, byte-stable, in its creating entry):
acea2 t6 across v33 reps = **0.3888 / 0.3883 / 0.3883, 3/3 correct, with
zero recalls in r1/r2** — the model read the convention off the printed
catalog code. v32-r2 (no code, also zero recalls) drifted to 0.5352. Causal
chain: same task, same layout, one knob, reproduced 3×.

## 6. Catalog detail knob (shipped)

`catalogDetail: ids | brief | schema (default) | code` on the versioned
catalog + `catalog-code.md` prompt fragment (read the printed code, keep its
conventions; recall is for values). Cache-aligned packaging keeps the extra
bytes mostly cached-priced — v33's cost is *below* plain v32-r1 despite the
bigger catalog.

## 7. Improvement plan

1. **Foundation turns are the remaining gap.** nfl-class cascades hit every
   arm (session included). The first-error turns are population/denominator
   choices at state creation. Prompt-only discipline (foundationVerify,
   r3 fix pack) did not measurably help; next candidate is a *mechanism*:
   auto-render the join/filter retention facts (rows in → rows out per
   upstream) in the delta entry itself, so a wrong foundation is visible the
   turn it is created.
2. **Rule pinning for late turns.** kaggle-class losses are binding
   conventions stated once at turn 2–3 and violated at turn 25+. Candidate:
   a `# Standing rules` line in the (already frozen) render, listing
   verbatim-quoted constraint sentences from earlier tasks — append-only,
   cache-friendly, no magic numbers.
3. **Decide on ≥3 reps.** The sub5 harness makes a full 3-rep arm ≈ $9.30 +
   ~6 h wall — always run 3 reps before believing any lever.
4. **Retired**: upstreamValueEcho (superseded by code-in-catalog, which
   attacks the same blindness pre-hoc, not post-hoc).

## 8. Ledger

Campaign spend: session 15 runs $18.50 · v32 10 runs $10.42 · v32fx 5 runs
$3.29 · v33 15 runs $9.27 · judge (OpenRouter deepseek) ≈ $4. All arms ran on
the dev/longds-multiturn worktree agent-service (:3005) against the shared
JVM stack; scratch under `benchmark/longds/system_scratch/LongDS_*`.
