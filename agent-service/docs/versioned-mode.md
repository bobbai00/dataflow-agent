# Versioned mode — the session as one immutable version DAG

*Setting: `versionedMode: true`. Off by default; every legacy configuration is
byte-identical with it off (pinned by the golden-parity and orthogonality
suites plus a dedicated legacy test in `versioned-refs.test.ts`).*

## The generalization

The original agent solves **one task**: a single ReAct loop over a mutable
dataflow — think, act on operators, observe results, answer. That design is not
replaced. It is the **special case** of this mode: a session with exactly one
turn.

Versioned mode generalizes it to **many tasks over one evolving analytical
state**. Each request is a turn; each turn runs the same ReAct loop it always
did; but the state the turns share is no longer a mutable workspace — it is an
append-only history in which **every version of every operator keeps a
permanent address: `opId (turn N)`**. Nothing is overwritten; revising an
operator creates a new version at the current turn; every earlier version stays
addressable forever.

Three consequences fall out of that one decision:

- **"Current" is derived, not primitive.** The latest version of X is just the
  newest entry in X's lineage. There is no separate mutable "current state" to
  keep consistent with the history — the history is the state.
- **Rollback / counterfactual / composition need no machinery.** Referencing an
  old version *is* rollback. A what-if is a subgraph that happens to reference
  old versions. Nothing is restored because nothing was lost.
- **Wrong-version mistakes become visible.** The classic long-horizon failure —
  building on the pre-update filter, the already-revised threshold, without
  noticing — must now be *written down* in the action, where the catalog
  contradicts it and where it can be scored mechanically.

## The context: one catalog

The whole rendered context is a single `# Catalog`, one entry per turn, oldest
first. Real shape (from a passnyc run):

```markdown
# Catalog (the whole session, one entry per turn)

## Turn 1                                  <- finished: frozen forever
### Task
<the request, word for word>
### Dataflow delta
#### `diversity_analysis_base` (added)
Summary: Join `middle_directory_2018`, `shsat_offers_clean`, ... on DBN
Upstream: middle_directory_2018 (turn 1), shsat_offers_clean (turn 1), ...
Result: 484 rows x 5 cols — Schema: DBN, district, offers, ...
Lineage: 4194 rows in → 484 rows out (11.5% of input rows)
### Answer
{"...": ...}

## Turn 2 ... ## Turn 3 ...                <- same shape

### Latest versions                        <- optional pointer table, see below

## Turn 4 (in progress)                    <- the only part that changes
### Task
<the live request>
### Steps
#### Step 1                                <- numbered locally, from 1
Action: - recallState turn: 1 ...
Observation: - recallState output: ...     <- pull output persists here
#### Step 2
Action: - createOrModifyOperator
    upstreams: ["demographic_2018_clean (turn 1)", ...]
Observation: - operator ... added
  result: Output Table: ...
```

Properties, each held by a test in `versioned-catalog.test.ts`:

- finished entries use word verbs (`added` / `revised` / `deleted`) and one
  `####` block per operator: Summary, Upstream **with version provenance**,
  `Result: N rows x C cols — Schema: ...` (the size a later turn needs to
  scale a recall pull), telemetry lines when enabled;
- there is **no `# Dataflow` section and no `# Recalled State` tail** — state
  renders once, at the turn that created it, and pull outputs persist inline as
  ordinary observations ("every action's observation stays" is the one rule);
- the prompt is therefore **append-only end to end**: finished entries are
  byte-stable forever and only the live entry's step log grows — the
  cache-optimal shape, reached by structure instead of by a render cap;
- steps number locally from 1 (nothing in this mode references global event
  indices — the catalog addresses turns and operator versions).

`### Latest versions` (the heads pointer table) is behind `versionedHeads`,
**default off**: an A/B measured wrong-reference errors at 0.8% per write both
with and without it, so it is kept only as a re-testable flag for much longer
sessions.

## The tools

**`createOrModifyOperator`** gains two required version parameters (only in
this mode; the schema is unchanged otherwise):

- `upstreams: ["scores (turn 3)", "labels (turn 9)"]` — one reference per
  `def process(...)` parameter, in exactly the notation the catalog prints.
  What the model reads is what it writes; there is nothing to translate.
- `from: "scores (turn 1)"` — required on revisions: the version the new code
  derives from.

Validation is against the version store (derived from the same turn grouping
the catalog uses, so a turn number is valid everywhere or nowhere), and every
rejection **lists the valid versions and the way forward** — a bare rejection
produces verbatim retry loops (measured: 35 identical calls, a full step
budget, no answer).

**`recallState(turn, ...)`** is the read-only pull, unchanged in role:

| param | default | meaning |
|---|---|---|
| `turn` | required | which entry to fetch (request, answer, operator delta) |
| `includeCode` | on | each changed operator's code as of that turn |
| `includeOutputTableSample` | 0 | chars of sample rows per operator; 0 = shapes/schemas only; clamped at 4000 |
| `includeOutputTableColumnStats` | off | numeric min/max/mean; string distinct+top; datetime range; null counts |

Telemetry (the `Lineage:` fact and any coercion-dataloss alarm recorded when
that version ran) rides along on recalled results unconditionally — a recalled
version that hides a known defect sends the reader chasing everything except
the cause.

## What is preserved

- **Single-task behavior**: `versionedMode: false` (the default) renders and
  validates exactly as before, byte for byte. The original setup is the
  one-turn special case and remains the production path.
- **ReAct within a turn**: unchanged — think / act / observe, full
  observations, the same per-step execution loop.
- **The render knob set**: `data_level`, `column_stats`,
  `max_operator_result_char_limit`, `row_lineage`, `coercion_facts`, … each
  still controls exactly its own fragment of the observation render,
  independently (pinned by test), in both legacy and versioned modes.
- **All other flag-gated experiments** (`enableRecallTool` on the index arms,
  `enableAnswerGrounding`, `enableResumeTool`, telemetry renders) compose as
  before; none is implied by this mode except that `recallState` is the
  natural companion.

## Status and open items

Measured on LongDS (see `../Kramabench/longds/README.md`, v6–v9): reference
discipline is excellent (~0.8% wrong-version errors per write, self-corrected
via the teaching errors), github ties the best arm at 100%, water-potability
sits inside the control band at lower cost — and passnyc exposes the one open
problem: the mode is 3/3 in the turn-12 cascade trap, most plausibly because
dropping the state dump also dropped **sample values** of upstream tables at
the moment join-building decisions are made. The two known levers, in order:

1. an input-values channel for the in-progress turn (surface sample rows of
   referenced upstreams before the first write against them);
2. verification at state creation (dual derivation of foundational
   quantities) — the only mechanism aimed at the cascade root itself.
