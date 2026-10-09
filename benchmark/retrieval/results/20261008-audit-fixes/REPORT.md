# Registered-Python audit fixes — 2026-10-08

Two targeted live Luna tasks completed correctly with no failed tools/actions, no evidence-exposure violations, and stable request prefixes. This is a regression check, not an estimate of benchmark-wide accuracy.

| Task | Official score | Model calls | Agent seconds | Estimated USD |
|---|---:|---:|---:|---:|
| legal-easy-3 | 1 | 3 | 15.77 | 0.0016992 |
| biomedical-hard-3 | 1 | 4 | 28.43 | 0.00427646 |

Both responses follow the required bold final-answer line. Legal computes the ratio in an executed result operator. Biomedical batches preview execution and source inspection, then parsed scans and schema inspection, followed by computation and retrieval. Both final numeric answers appear in current retrieved results. Costs use frozen token rates, exclude scoring/infrastructure, and are not invoices; cache input was 47,913 of 64,102 reported input tokens.

Implemented: exact paginated schema inspection; compact retained worksheet/header inspection; registered semantic filter predicates with kept/rejected/null counts and bounded rejected-value frequencies; same-call flow references keyed by producing versions, preserving opaque scope; explicit gateway deadlines and best-effort HTTP cancellation; batching/final-calculation prompt guidance; offline formatting and observed numeric support diagnostics, separate from official scores.

Timing now includes operator-body and rejection-frequency work, profile accumulation and summary construction, plus agent-side request-to-headers, body decoding, result preparation and snapshot storage. These are measured scopes, not a disjoint end-to-end engine breakdown; distributed transfer and engine persistence remain unmeasured separately. Provider cancellation and missing usage remain unknown after transport failures.

The proposed all-cached dispatch shortcut is deliberately deferred after inspection: the cache-list endpoint proves only database metadata, not artifact existence or current external-file/glob fingerprints. Skipping the engine based on that endpoint could return stale results or hide an evicted artifact. Existing engine caching remains active. A safe shortcut needs an engine-side validation endpoint before dispatch can be removed.

Validation: full agent suite 1,514 passed; focused post-integration tests 96 passed; gateway 18 Scala tests (including stalled response body and deadline races); Amber profile 38 tests; benchmark helper suite 49 passed and two Linux-only isolation tests skipped on macOS. Post-review regressions passed (84 native/filter/telemetry and 42 offline audit checks). The final deterministic engine probe passed all four evidence combinations, including exact 179-column recovery, three-sheet discovery with an empty sheet, measured rejection frequencies, cached versions, and independent result visibility. [Engine probe summary](engine-probe-summary.json).

Raw preserved artifacts: `benchmark/retrieval/runs/20261008-audit-fixes-validation/`. [Exact metrics and diagnostics](validation.json).
