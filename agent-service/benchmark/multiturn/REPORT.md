# Multi-turn research: what the real runs show

## Conclusion

We found a useful cost improvement, but **did not establish an overall win over a well-structured code agent**. Keeping the native transcript chronological makes batching competitive with ordinary code on this diagnostic. Encouraging the code agent to define reusable functions is still cheaper and achieved higher first-pass answer accuracy. The saved-recipe prototype made dependencies explicit, but it also exposed why **a table pointer is not a sufficiently precise context contract**.

The next Dataflow algorithm should bind **membership, values, definitions, and published baselines separately**, check the consumed column origins, and execute only the affected computation. A separate LLM call just to select context is not justified by these results.

## What was run

- GPT-5.6 Luna through the existing gateway; the original smolagents LongDS wrapper for code; the isolated Dataflow service on **3021**.
- A fixed nine-request session, generated under three data seeds: 27 scored requests per primary arm. They cover persistent cohort/formula changes, temporary original-definition branches, old membership applied to new values, and an unchanged published baseline.
- Same task content and data, 25 steps per request, 2,000-character print/result budget. Python dictionary objects returned through `final_answer` are normalized alongside JSON; a wrapper's stringification is not counted as an analysis error.
- Exact ranked region names and absolute numeric tolerance of `0.0001` percentage points. All requested fields must pass. Gold is evaluator-only; no LLM judge determines success.
- **V1 native batching** was measured. The shared backend rejects the committed V2 structured-result request with HTTP 400. Its services were not changed. V2 UDF replay validation passed locally, but V2 execution/profiles were not qualified.

These are three numeric variants of **one task family**, not 27 independent tasks or a LongDS leaderboard. They establish mechanisms and useful counterexamples, not general superiority.

## Primary first-pass comparison

Totals across seeds 41, 42, and 43; calibration and recovery runs excluded:

| Arm | Correct requests | Model calls | Cached-aware cost | Input tokens | Output tokens |
|---|---:|---:|---:|---:|---:|
| Existing code agent | 27/27 | 39 | $0.033661 | 267,823 | 19,371 |
| Code agent + reusable-function guidance | 27/27 | 39 | **$0.023320** | 240,171 | 12,742 |
| Native batch + chronological history | 26/27 | 60 | $0.026529 | 586,149 | 9,049 |
| Saved recipes + worked guidance + chronological history | 26/27 | 64 | $0.029151 | 641,096 | 10,461 |

Costs use repository Luna accounting ($0.20/M uncached input, $0.02/M cached input, $1.20/M output), not an invoice. Chronological native batching is 21.2% cheaper than the ordinary code arm here, but 13.8% more expensive than the function control and has one answer failure. Recipe reuse does not improve that comparison.

Across calibration, primary comparisons, and recovery: **189 requests, 384 model calls, $0.239107** estimated total. All are retained in the artifact directory.

The native batch failure was **answer rounding**, not a wrong computation: the materialized value was `42.999349200446275`; the final answer reported `43.0` despite the four-decimal requirement. The recipe failure was a **wrong value source**, described below. Reporting these separately matters when deciding what to fix.

### Recovery results

Each failed primary session was rerun twice in full, with unchanged prompts and settings. The primary table keeps first-pass outcomes; no cheapest-success selection replaces them.

| Failed session | First pass | Recovery 1 | Recovery 2 |
|---|---|---|---|
| Seed 41, guided recipes + chronological | 8/9, $0.009259 | 9/9, $0.011261 | 9/9, $0.007957 |
| Seed 43, batch + chronological | 8/9, $0.008553 | 8/9, $0.008447 | 8/9, $0.008483 |

Both batch recoveries again failed request 9 while expressing the answer: one emitted malformed JSON containing `43. -?`, the other reported `43.9993` instead of `42.9993`. The recipe recovery results show substantial trajectory variation; they do not make the original wrong-column failure disappear.

### Calibration and rejected hypotheses

Seed 41, nine requests per run:

| Configuration | Correct | Cost | Observation |
|---|---:|---:|---|
| Native batch, existing top placement | 9/9 | $0.015669 | Current request rewrites the prompt prefix |
| A second top-placement run | 9/9 | $0.015858 | Similar total with a warm start |
| Recipes exposed, no worked example, top placement | 9/9 | $0.015337 | Saved definitions, **zero reuse calls** |
| Existing bottom placement | 9/9 | $0.022571 | Worse measured cache reuse; reject this setting for this path |
| Guided recipes + bottom placement | 9/9 | $0.020862 | Five reuse calls, but no overall cost win |
| Native batch + chronological placement | 9/9 | $0.008889 | Stable historical frames; fewer uncached input tokens |

Do not attribute the unguided arm's outcome to recipe execution: it never used the operation. The first attempted bottom-placement configuration used the wrong nesting level and was ignored; its trace-confirmed top-placement run is the second row, retained with an explicit artifact note.

## Findings from the traces

### 1. Fix history representation before adding a planning phase

The old native layout puts the newest request in the first user message and also retains it later in the transcript. On seed 41, the first call in each later request reused only about 6,041 input tokens, even as the request grew past 12,000 tokens. Changing the question invalidated the history behind it as a cached prefix.

The new `userTaskPlacement: "chronological"` keeps every request at its actual position, exactly once. A regression test checks stable prior frames across a new request. In the three primary native runs, 564,221 of 586,149 input tokens were cached (96.3%). This is an implementation improvement available to other agent designs too, not an exclusive Dataflow property.

Caching is not free: native batching still read **2.44 times** as many input tokens as the function control. Without input-cache discounts, their estimated costs would be $0.128089 versus $0.063325. A compact registry and selected dependency slice are still needed; cache reuse alone does not solve long-session growth.

### 2. Reusable computation is already available to code

The function control defines a report once, with data, cohort, and formula parameters, then invokes it on later requests. It reduced total output tokens from 19,371 to 12,742 while preserving all 27 answers. It also keeps published result copies separate from callable definitions.

Therefore “remember prior work” and “reuse a recipe” are insufficient differentiators. Dataflow must add automatic affected-set computation, validated bindings, materialization management, or protection of immutable results beyond what a small Python function registry provides.

### 3. A dependency edge can point to the wrong values

In seed 41, recipe arm, request 8, Luna correctly identified the old customer membership and the new export. It then joined:

```text
left  = original membership table, INCLUDING old gross/cost columns
right = new export, INCLUDING new gross/cost columns
```

The join retained old `gross` and `cost` names and suffixed the right-side versions. The saved report consumed the unsuffixed old columns. Everything executed successfully, but the answer was West/North instead of East/South.

This is directly relevant to the proposed prior-selection phase. The model had selected both right tables. It had not declared which table supplied **membership** and which supplied **values**, and the system did not validate that distinction.

An appropriate next interface is conceptually:

```text
run_recipe(
  definition = current_margin_definition,
  values = customers@v2,
  membership = initial_customer_ids@v1,
  published_baseline = initial_report@v1,
  scope = temporary
)
```

Compile membership into a distinct key set and a semijoin against the value table. Require the metric columns to originate from the declared value version. Keep the published baseline as a frozen result, not a recipe that silently recomputes. These are computational dependencies; they do not establish real-world causal effects.

### 4. Raw operator IDs are a poor reusable interface

The prototype freezes definitions and expands a selected backward slice, stopping at explicit table bindings. Its live smoke test replays a UDF plus aggregate with a new input, changes the result from 30 to 70, and preserves the original 30.

But the real traces show extra work:

- Seed 42, request 3: Luna twice tried to change an operator inside the new clone in the same call. The prototype rejected the ID collision; it eventually cloned and modified in separate calls. This request used five model calls.
- Seed 41, request 2: it rebound the raw data when the desired change was eligibility, then needed another call to change the cloned filter.
- Long prefixes and internal operator names make later bindings harder to select.

The next recipe interface should expose named formal inputs and explicit parameter overrides. It should allow **fork + override + observe** in one operation. The runtime can retain fine-grained native operators internally without making the model rewrite or name all of them.

### 5. Final answers should be able to reference verified results

Code can compute a JSON object and pass it directly to `final_answer`. Native Dataflow usually takes another model call to read the table and write the answer. The seed-43 rounding failure happened in precisely that extra step; the full correct number was visible in the trace.

A useful next experiment is an explicit answer projection from a completed result: select columns, rows, rounding, and JSON shape mechanically. Validate completeness and failure state before returning it. This could reduce calls and copying errors. It was **not implemented or measured** in this study.

## How native operations and UDFs should fit

Use native operations where their contracts let the system prove something useful: schema/column origins, row preservation, membership filtering, join cardinality, aggregation, and ordering. Use a UDF for domain logic or a compact reusable computation. Requiring the model to spell out every simple internal operation adds schema and history cost without necessarily improving answers.

A UDF should declare named inputs, output schema, and any required determinism/materialization assumptions. Treat undeclared lineage as unknown; do not invent row or column guarantees for opaque code. A recipe should compose native operations and UDFs under the same versioned input contract. The current prototype's positional adapter preserves UDF source, but it does not prove determinism or provenance through arbitrary Python.

## The next benchmark

Keep LongDS for external validity, and add a focused dependency-update suite. The current answer-only diagnostic still permits correct results by remembering numbers or calling Python functions; it does not require maintaining a consistent set of artifacts after revisions.

Measure these properties with matched code controls:

1. **Sparse updates with many consumers:** one corrected source or parameter affects a subset of 1, 4, or 16 published analyses. Check every affected artifact and preservation of the rest.
2. **Mixed version roles:** old membership, current values, an old/new formula, and a frozen baseline. Include overlapping column names and duplicate membership keys.
3. **Temporary forks:** local changes must leave the persistent default and earlier publications unchanged, including after later source revisions.
4. **Long-distance reuse:** vary the gap before reuse (2/8/32 turns), unrelated work, and dependency depth. Keep ordinary sequential-analysis controls.

Record final-answer accuracy separately from artifact invariants, stale-result consumption, binding correctness, recomputed operators/rows, executed UDFs, model calls, cached-aware cost, and full-session cost including setup and recovery. Source/version IDs and result hashes should make these checks deterministic.

Use the same artifact registry/selection hints for a code control; add a code control with reusable functions; ultimately test the same DAG runtime behind both interfaces. Otherwise a win could come from better memory tooling rather than Dataflow itself. Randomize arm order and retain cache-normalized accounting.

Expand across real datasets and distinct task families before claiming statistical generality. Generating many seeds from three tasks gives repeated measurements of those tasks, not broad benchmark coverage. The earlier LongDS metadata audit found many candidate rollback/counterfactual turns, but those labels alone do not establish meaningful mixed-version dependencies.

## Implementation and artifacts

- Research branch: `feat/multiturn-dataflow-research`, from `aa3841145`.
- Source changes are confined to `agent-service/`. Shared JVMs, workers, and the other development worktree were not changed.
- Prototype commit: `48415cd81`; subsequent research changes add chronological requests, controls, and documentation.
- Raw runs, full traces, deterministic evaluations, and accounting: `/tmp/dataflow-multiturn-research-20260915/`.
- `comparison.md` / `comparison.json` there retain calibration, primary, and recovery runs separately. The two failed primary sessions receive two additional complete-session recovery runs; first-pass failures remain in the primary table.
- Unit validation: 1,014 Bun tests and two Python answer-normalization tests passed; TypeScript typecheck passed. The live replay smoke passed on the shared backend. V2 validation passed without claiming V2 deployment compatibility.

See [README.md](README.md) for commands, settings, and prototype limitations.
