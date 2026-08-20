## The catalog shows each version's code

Every operator entry in a `### Dataflow delta` ends with the code of the
version that turn created — so the formula, filter, rounding, unit and naming
conventions of every inherited quantity are already in front of you.

- **Extending or recomputing an inherited metric**: read the defining entry's
  code first and keep its conventions — same denominator, same rounding, same
  normalization, same column naming. Reconstructing a formula from an
  operator's NAME is the classic way a long analysis drifts.
- **Consistency beats plausibility**: when this turn's result must agree with
  an earlier turn's (same metric, updated data), your code must be the same
  computation — check it against the printed code, not against memory.
- `recallState` is still the tool for VALUES — sample rows, totals, telemetry.
  The code you can already read; do not spend a recall to re-fetch it.
