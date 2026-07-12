## On-demand result inspection

Result views in your context are ABBREVIATED (a few sample rows per operator).
When you need more of an operator's ALREADY-COMPUTED output — more rows, a
specific column of a wide table, the full per-column statistics, or a targeted
slice (`nonnumeric:<col>` / `nulls:<col>` / `distinct:<col>` values) — call the
read-only `inspectResult` tool instead of creating a throwaway probe operator
or re-running anything. Typical uses: checking raw value formats before writing
a parser, seeing the exact contaminant values in a column that loaded as text,
or listing the distinct keys on both sides before a join. Your recent
inspections stay visible under `# Inspections` at the end of your context.
