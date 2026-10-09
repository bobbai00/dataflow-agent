# Agent-Triggered Context Compaction — Implementation Plan

The design (locked with Bob, 2026-07-05):

1. **Default: context accumulates as trajectory** (DELTA — interleaved events/observations,
   append-only).
2. **`compactContext` is a tool the agent can call** (name TBD; "summarize" collides with the
   renderer function — recommend `compactContext`).
3. **On call, history up to that point is laid out LATEST-style** — a boundary-snapshot deck
   parameterized by the tool-call arguments (within mechanical guardrails).
4. **New events append after the compacted text** (raw delta suffix; the deck is an immutable
   prefix until the next compaction).
5. **When-to-trigger = static rules in the system prompt + tool description** (v1), with the
   existing token-budget auto-compaction retained as a hard backstop.

Relationship to what exists: this is a **re-plumbing of the shipped compress machinery**
(`contextWindowTokens` + `compactionStrategy:"compress"` + deck renderer, validated in
`agent-service/docs/context-window-compaction-experiments.md`), changing the *trigger* from
token-overflow to an agent action and the *fold params* from fixed settings to clamped tool
args. It is the "trigger-policy" dimension of `LEARNED_CONTEXT_SELECTION_ACTION_PLAN.md`
(cross-ref: its Phase-3 replay harness later gives oracle-timing labels; its variant track
is the learned version of this trigger).

**Estimate: ~7–10 engineering days + ~2–3 days compute.**

---

## Design decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Who decides WHEN | Agent (tool call), system backstop at hard budget | Semantic phase boundaries are agent-visible; backstop caps the known under-use risk (6% delete-rate precedent) |
| Who decides WHAT SURVIVES | System: heavy-deck compress + protected suffix + clamps; agent only nudges via semantic params | Lean-deck negative result (full stats are the signal); tuner wide-table incident (LLMs misjudge render knobs) |
| Deck content | Boundary snapshot per-op: schema + full column stats + sampled rows (existing deck), **plus failed-attempt signatures** for ops that thrashed before the boundary | Preserves the anti-thrash signal through the fold |
| Deck freezing | Rendered once at compaction time, cached on the mark; **byte-immutable prefix** afterwards | True append-only semantics → maximal prompt-cache stability (`usage.cachedInputTokens` verifies); re-derivable from the boundary snapshot on import |
| Repeated compactions | Newest mark wins; its deck is derived from the boundary snapshot state (not from nesting old deck text) | State-derived, no deck-of-deck degradation |
| Non-destructive | Fold is render-only; dossier/snapshots keep everything; `inspectResult` pulls folded material back; deck header lists folded ops | Bounded damage from a badly-timed compaction |
| Mode coupling | v1 requires `contextMode: DELTA`; invalid with LATEST (settings validation) | LATEST has no growing trajectory to fold |

## Tool surface (v1) — per-operator orthogonal flags (JSON array)

The LLM-facing shape is a JSON array of per-operator flag objects (Bob's design), each
flag mapping onto the unified `SummarizeParams` per-op surface (`params.ts` — whose
docstring anticipated exactly this: "the future tool `inputSchema` for a model-driven
summarize() call").

```jsonc
// compactContext tool input (zod inputSchema; sketch)
{
  "operators": [
    {
      "operatorId": "loadFires",
      "statsOn": false,            // column.stats — full per-column stats block
      "schemaAnnotationOn": true,  // column.schema — the Schema: line (name + type)
      "cardinalityOn": true,       // shape line: output R×C + input port shapes
      "fullSampleRecords": false,  // true: sample rows up to the result char cap;
                                   // false: deck ratio peek (deckRowCap: ~1/10 of
                                   // rows, clamped [3, cap]; char caps still apply)
      "codeOn": false              // property.includeCode — the operator's CURRENT
                                   // code as a `Code:` block (no version history in v1)
    }
    // unmentioned operators → { schemaAnnotationOn: true, cardinalityOn: true, rest false }
  ],
  "keepLastSteps": 2,              // optional; protected raw suffix, clamp [1, 5]
  "reason": "load/inspect done"    // one line; logged + shown in the deck header
}
```

**Always-rendered invariant (not parameterizable, replaces `omit`):** every operator in
the deck keeps its structural line — id, type, one-line summary, status, and the
consolidated **`Inputs:` upstream-operator-ids line** (`formatOperatorAdjacency`,
already unconditional in `serializeOperatorFull`, which the deck reuses). The DAG
skeleton can never be flagged away — an invisible operator is how duplicate loaders
happen, and upstream ids are the dataflow's structural signal. Enforced by a test:
all-flags-false still renders identity + Inputs.

Flag → params mapping (translate layer, replacing the 4-level `detailToOverride`):
`statsOn → column.stats` · `schemaAnnotationOn → column.schema` · `cardinalityOn →`
shape/port-counts line (small additive render flag in the deck path — today coupled
into `detail`) · `fullSampleRecords → tuple.sampleRows` (0 = char-cap-bounded full
sample vs `deckRowCap` ratio peek) · `codeOn → property.includeCode` (current code
only). Booleans in the tool, no depths or raw knobs exposed. Version-history flags
(`property.codeHistory`, `result.history.lastK`) are **deliberately deferred** — the
params exist in the unified schema when v2 wants them.

Guardrails applied regardless of args: `clampWide` (≥40 result columns → statsOn and
fullSampleRecords forced off; schema line stays — it lists all columns cheaply),
heavy stats stay available (lean-deck negative result says don't globally thin them),
frontier/terminal ops floored at schema+cardinality, protected suffix enforced
mechanically. The `reason` string is free training data for the learned trigger later.

## Static trigger rules (v1 — go into system prompt section + tool description)

Corpus-derived (each maps to a measured pathology):

1. **After finishing load/inspect** — every source you'll use has a healthy consumer and you
   are about to build transforms → compact, keep the frontier. (stale-source re-render, §A.3)
2. **After a stuck operator is fixed** (a multi-edit loop ends in success) → compact; the
   failed attempts fold into signatures. (thrash tail)
3. **When the context meter shows the trajectory over its soft target** (rule needs the meter,
   below) → compact at the next natural boundary.
4. **Do NOT compact while an operator is actively erroring** — recent failed attempts are
   working memory. (lever C.2)
5. **Don't re-compact** unless ≥4 new events since the last compaction.

**Context meter** (prerequisite for rule 3): one line in the trajectory header, e.g.
`# Agent Events (~4.1k tokens; soft target 3k — call compactContext at a natural boundary when over)`.
Without an observable signal, size-based rules are undecidable for the agent — the 6%-delete
precedent came from runs with zero cost feedback, so the meter is the fairest test of
whether prompting can drive housekeeping.

---

## Phase A — Fold-mark plumbing (2–3 days)

- [ ] **Mark representation: derived, not new state.** A compaction mark = any
  `compactContext` tool call in the visible ReAct path (steps already record `toolCalls`).
  `getCompactionMarks(visibleSteps)` → newest mark = active fold boundary. Export/import and
  `checkout` work for free (marks replay from step history); frozen deck text cached in
  memory keyed by mark stepId, re-rendered deterministically from the boundary snapshot when
  missing (import case).
- [ ] **Assembler change** (`summarize.ts` / the DELTA path in `context-utils.ts`): if an
  active mark exists → render `[frozen deck for boundary] + [raw delta suffix after mark]`,
  reusing the existing compress-deck renderer with the mark's translated params instead of
  the rolling-window boundary. No mark → current behavior (unbounded or window-compacted).
- [ ] **Param translation**: per-op flag objects → `operators.overrides` record (the flag →
  params mapping in the Tool-surface section), `translateTunerOutput`-style validation from
  `context/tuner/`, clamps applied. Deck renderer extension: consult per-op overrides
  (today the deck applies one uniform format) + the small additive `cardinalityOn` shape-line
  flag + the two history renderings below.
- [ ] **Failed-attempt signatures in the deck (system-side guardrail, not a tool flag)**: any
  op with ≥2 failed `CodeVersion`s before the boundary keeps one signature line per attempt —
  `attempt: read_csv(sep=';', skiprows=2) → failed: parsed 1 column` (from
  `CodeVersion.statusLine` + a param digest) — the anti-thrash signal must survive the fold
  regardless of what the agent flags. Agent-facing version-history flags are deferred to v2.
- [ ] Tests: unit (mark derivation, translation, clamps); golden — same boundary + default
  params must render **byte-identical to the existing window-compress deck**; existing golden
  parity suite untouched.

Exit: with a hand-inserted mark, rendered context = frozen deck + suffix; import/checkout
reproduces it byte-identically.

## Phase B — The tool (1–2 days)

- [ ] `agent/tools/compact-context-tool.ts` — follows the `inspectResult` pattern: read-only
  w.r.t. the DAG, **not** in `EXECUTE_AFTER_TOOLS` (no workflow execution), parallel-callable.
  Tool result observation is one line (`Compacted 14 events (9 operators → deck). Folded ops
  remain inspectable via inspectResult.`) — the deck itself must NOT appear in the tool result
  (it would double-render).
- [ ] Settings: `enableCompactTool: boolean` (default false) + `softCompactTokens` (meter
  target, default 3000); validation: requires `contextMode: DELTA`; composes with
  `contextWindowTokens` backstop (below). Wire through create/PATCH like `enableInspectTool`.
- [ ] Unit tests: registration gating, observation text, mark visible to the next render.

## Phase C — Prompt, rules, meter (1 day)

- [ ] New conditional system-prompt section `prompts/compaction.agent.md` (pattern:
  `compaction.delta.md`, injected only when the tool is enabled): what the deck is, that it's
  trustworthy, the 5 static rules, that folded data is recoverable via `inspectResult`.
- [ ] Tool description carries the trigger rules in compressed form (models weight tool
  descriptions heavily at call time).
- [ ] Context meter line in the trajectory header (render-time, chars/4 estimate).
- [ ] Prompt-drift check: section renders only in DELTA+tool-enabled configs (the
  compaction-prompt experiment showed describing absent machinery is harmless but wrong).

## Phase D — Backstop composition (0.5–1 day)

- [ ] Precedence: if the raw suffix after the newest agent mark overflows
  `contextWindowTokens`, the existing rolling auto-compaction advances the fold past the
  agent's mark (auto-fold wins; agent mark params are kept for ops they named). Agent
  compaction is *voluntary early* folding; the hard ceiling is never the agent's job.
- [ ] Config for eval arms: backstop at 2× soft target (e.g. soft 3k, hard 6k).
- [ ] Tests: overflow-past-mark behavior; no-tool configs identical to shipped behavior.

## Phase E — Evaluation (1–2 days eng + 2–3 days compute)

**Smoke (first, cheap, decisive):** 10 tasks × haiku + gpt-5.4, tool enabled — count firings,
where they fire (auto-classify each against the rule conditions: post-consumer?
post-thrash-resolve? meter-over?), and param sanity. **This answers the only real unknown —
does the agent call it at all — before spending on the full grid.**

**Main grid** (KramaBench, reuse the A/B script pattern: `results.jsonl` + done-set resume,
watchdog):

| arm | config |
|---|---|
| A | DELTA unbounded (no tool) |
| B | DELTA + auto-compress 3k (shipped winner — the bar) |
| C | DELTA + tool + rules + backstop 6k |
| D | C minus prompt rules (tool only) — isolates rule value |
| E | LATEST (reference) |

60 tasks; ≥3 reps for the B-vs-C pair (McNemar on discordant pairs — the compaction study's
power lesson). Metrics: pass (`scoreKramabench`), steps, input tokens, **$ and
`usage.cachedInputTokens`** (the cache-economics claim is directly measurable per step),
trigger count/timing, repeated-failed-action count.

**Success criteria:** C ≥ B on accuracy with ≥ B's token profile and better cache-read
fraction, and trigger timing correlating with rule conditions. **Honest prediction to test:**
under-use without the meter (D arm), meter-driven firing in C; if the agent fires ≈never even
in C, the result is still publishable (static-rule compliance is the measurement) and the
learned trigger from the companion plan becomes the path.

## Phase F — Docs (0.5 day)

- [ ] `agent-service/docs/agent-triggered-compaction.md` — design, smoke numbers, grid
  results, verdict, same register as existing docs. Feed §4 formulation (factored action
  space: task actions = LLM, context actions = tool + backstop; "compaction is to the
  trajectory what delete is to the DAG").

---

## Risks

| Risk | Mitigation |
|---|---|
| Agent never calls it (delete-rate precedent) | Meter + rules in tool description; backstop makes under-use = shipped behavior; smoke test gates spend |
| Agent params destroy signal | `clampWide` + heavy-deck default + frontier/terminal floors + unmentioned-ops-default-to-shape |
| Deck double-render via tool result | Observation is a one-liner by construction |
| Frozen deck stale vs later state | Deck is a *history* representation by definition; live state is in the suffix's observations; `inspectResult` reads current cache |
| Mark/window interaction bugs | Phase-D precedence tests; golden byte-equality vs shipped compress |
| Timing noise in eval | ≥3 reps on the decisive pair; discordant-pair test; trigger-timing analysis is per-event, not per-run |
