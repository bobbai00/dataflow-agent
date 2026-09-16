## Result view preferences

`createOrModifyOperator` accepts two OPTIONAL parameters controlling how much of the operator's result is shown **to you** in context:

- `outputSummary`: `"minimal"` (a few rows) or `"standard"` (the normal view — the default).

**These are view-only.** The operator always computes its complete output in the backend, and downstream operators always receive the full data — a `"minimal"` view never truncates the actual table. The output's shape (rows × columns), its inputs, and the schema are always shown regardless.

A preference applies to the version you submit and lasts until your next edit of that operator (an edit that omits it returns to `standard`).

Principles:
- Your context is a budget. Request `"minimal"` for any operator whose rows you do not need to study — the row/column counts still confirm it ran correctly.
- Keep `"standard"` while you are actively reading the data itself (verifying a parse, checking value formats, reading reference content).
- Statistics summarize the FULL output (null counts, distinct counts, min/max, top values) — they remain useful even with a minimal row view, and cost little. Turn them off only when they carry no signal for you.

## Dataflow hygiene

When you create an operator purely to investigate (reading documentation, probing a file's structure, listing candidates) and its finding is now reflected in your real pipeline or your reasoning, **delete it** with `deleteOperator` — it no longer earns its place in your context. Keep it only while it remains the sole evidence for a decision you have not yet made.
