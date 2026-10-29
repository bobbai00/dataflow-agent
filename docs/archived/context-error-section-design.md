# Design note (RFC): folding errors into the operator sections

Status: **draft / under discussion** — capturing the problem, the current overlap,
and the proposed direction. Not yet decided.

## Problem

The LATEST context has accreted several sections and per-operator annotations that
overlap, especially around *errors* and *repeated edits*. The same error fact can
show up in three places, and three different "reflection" rungs do nearly the same
job. We want to consolidate so that **each fact about a failing operator lives in
exactly one place**, while still **keeping the operator in the dataflow** (no
removal, no "quarantine").

## Current state (what we have, and the flag for each)

LATEST renders, top → bottom:

1. `# User Task` — always.
2. `# Reasoning (your recent steps)` — `thoughtReplay` (+`thoughtReplayK`): last K
   events as thought + compressed actions.
3. `# Current Dataflow` — the snapshot ("kernel"). Per operator:
   - header; `Properties:` (`includeOperatorProperties`); `Schema:` (dataLevel≥1
     `schemaInResult`); `Column stats:` (stats); table-structure (dataLevel≥2
     `tableStructureHint`); `Format hints:`/coercion (dataLevel≥3); `Result:`
     (capped by `maxResultRows`/char limits) — **error shown inline here when failing**;
     `Last edited: step N` (`thoughtReplay`); `Attempt reflection:` (`attemptReflection`).
4. `# Operators needing attention (fix in this order)` — flow section, per
   erroring/anomalous op: `error:` line; `Loader hint:` (flowLevel≥1); lineage error
   pointer/context (flowLevel≥2 `lineageErrorContext`); cardinality alarm (flowLevel≥2
   `lineageStats`); `Graph check ⚠` (flowLevel≥3 `graphAudit`); `Join check ⚠`
   (flowLevel≥3 `joinTelemetry`); `Attempts:` (`errorReflection`).

### The overlaps to fix
1. **Error shown twice** — inline in §3 `Result:` *and* in §4 (`error:` + lineage).
2. **Three near-duplicate reflection rungs** — `thoughtReplay` (`Last edited:`),
   `attemptReflection` (edit count + code), `errorReflection` (count + distinct errors).
   `attemptReflection` and `errorReflection` especially do the same job.
3. **Columns described 2–3×** — `Schema:`, `Column stats:`, table-structure all
   describe the same Result's columns. (Separate cleanup; not error-specific.)
4. **Everything piles on the same op** — a failing op can carry Result+inline error
   → Last edited → Attempt reflection → §4 error + loader hint + lineage + Attempts.

## Design principle

**Single responsibility per section.** Three distinct questions, three homes, no
fact repeated:
- *What is the current state?* → `# Current Dataflow` (the kernel). Keeps the op.
- *What do I fix next, and in what order?* → a routing section (pointers only).
- *Why did it fail / what have I tried / what's the input?* → one error-detail section.

The operator **always stays in the dataflow** (in §3 and as a real node). We are
relocating the error *detail*, not the operator.

## Proposed direction (leading option): fold error detail INTO the operator block

Rather than a separate error section, fold the error story **into the failing
operator's own block** in `# Current Dataflow`. The operator stays fully in the
dataflow; its block additionally carries everything needed to fix it. For an op
that has errored:

- **Input schema** — the upstream columns + types, so the fix targets real columns.
- **Current code** — as today.
- **Error history (compressed), accumulated across attempts:**
  - the **attempt count**;
  - the **error message(s)**, deduped (distinct signatures; note when the same error
    repeats across attempts — that's the "you're stuck" signal);
  - the **code diff of the last attempt vs the previous one** (essential changed
    lines only), which surfaces trivial-variation churn ("you only changed X and got
    the same error") far more cheaply than dumping each attempt's full code.
  - First error: just the current error. Second+ consecutive error on the same op:
    add the count + diff + deduped history.

Sketch of an errored op block:

```
### `phospho_proteomics` (DataProcessing)
Input schema: gene (str), tumor_id (str), abundance (float)
def load(): ...                                   # current code
Result: errored — 4 attempts
  Last change vs attempt 3:
    - sheet_name='B-phospho'
    + sheet_name='B-phospho-proteomics'
  Error (same on attempts 2–4): [ERROR] `phospho_proteomics` is BLOCKED: loader for mmc2.xlsx
  → edits aren't addressing the error; change strategy.
```

This **subsumes** `errorReflection`, `attemptReflection`, `lineageErrorContext`, and
the §3/§4 double-shown error — all of it becomes annotations on the one op block.
The operator is kept and integrated (no removal, no quarantine, no "failed attempts").

### The salience tradeoff (important)
`# Operators needing attention` exists *specifically to pull error signal out of the
DAG so it isn't buried* (its own comment: "consolidated into one end-of-context
section so the actionable signal isn't buried in the DAG dump"). Folding back inline
**reverses that** — a failing op's block now sits in topological position in a
possibly-large DAG and is easy to miss. Recover salience cheaply with a **one-line
pointer index**, not a full section:

```
Operators with errors: `phospho_proteomics`, `merge_x` — fix `phospho_proteomics` first.
```

So the net layout becomes: a one-line "errors here, fix in this order" pointer +
the full detail inline on each op block. Locality *and* findability.

## Open decisions

1. **Does `# Operators needing attention` disappear or shrink?** With detail folded
   inline, the section is no longer needed for *content*. Recommend **shrink to a
   one-line pointer index** (errors here, fix-order) for salience — don't delete it
   outright, or errors get buried in the DAG.
2. **Do soft anomalies fold in too?** (`lineageStats` cardinality, `graphAudit` dead
   loader, `joinTelemetry`.) They're per-op signals like errors, so folding them into
   the op block is consistent and would let the whole §4 flow section retire (replaced
   by the pointer index). Alternative: keep anomalies as a separate "warnings" list.
   Lean: fold them in for one unified per-op annotation model.
3. **Code-diff scope.** Last-attempt-vs-previous only (1 diff) vs a short chain. Lean:
   **just the last diff** + the attempt count + deduped error(s) — cheap and high
   signal. Reconstruct past code from the path (react steps carry each attempt's code);
   extract essential changed lines, not a full unified diff of large blobs.
4. **Error-history dedup.** distinct error signatures + count, not a raw per-attempt
   dump (a raw trajectory reintroduces the super-linear context blow-up the loops cause).
5. **Input schema form.** Compact `col (type)` list co-located with the error vs a
   pointer to the upstream's Result already in §3 (today's `lineageErrorPointer`).
   Co-locating the compact list aids debugging; avoid re-dumping upstream rows.
6. **Persistence gate.** First error: show just the current error. Add count + diff +
   history only on the 2nd+ consecutive error on the same op (transient errors that
   self-correct shouldn't accrete history). Ties to the `errorReflection` threshold
   (currently ≥3 edits).

## What this replaces / flag implications

- Retire/merge `errorReflection` and `attemptReflection` into the one error-detail
  section.
- Fold `lineageErrorContext`/`lineageErrorPointer` into it (the "input schema for a
  failing op" job).
- `thoughtReplay`'s `# Reasoning` section is orthogonal (general reasoning, not
  error-specific) and can stay or be evaluated separately — early signal is it's not
  pulling its weight, so it's a candidate to drop independently.
- Column-description overlap (`Schema:` / `Column stats:` / table-structure) is a
  separate consolidation: pick one canonical column descriptor.

## Caveats from the experiments

- Context-presentation changes are **swamped by gpt-5-mini run-to-run variance** on a
  low-churn domain like legal — measure any reorg on the **loop-prone task subset with
  best-of-N**, comparing only tasks where errors actually occur.
- Presentation is a **secondary lever**. The biggest wins observed were (a) fixing
  over-coarse guards (the loader-budget false-positive that *manufactured* a 46×
  loop on a legitimate multi-sheet Excel read) and (b) a hard loop backstop
  (`maxOperatorEdits`). Keep those regardless of how the sections are arranged.
