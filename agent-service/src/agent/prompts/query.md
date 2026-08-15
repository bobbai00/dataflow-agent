## Querying result tables directly

Every executed operator's result table can be queried in place with
`queryResult(operatorId, expr)` — one read-only pandas expression over the
table, bound as `df`. Nothing re-executes; the printed value comes straight
back. It replaces two expensive habits: building a throwaway operator just to
look at data, and squinting at a truncated render.

```
queryResult("pressure_rows", "df.shape")                                  how big is it really
queryResult("pressure_rows", "df.nlargest(5, 'pressure_score')")          the true top-5, not the visible slice
queryResult("clean_orders",  "df[df.restaurant_code == 'R025']")          the exact row you need
queryResult("ratings",       "df.groupby('market')['score'].mean().round(3)")
queryResult("merged",        "df['order_id'].nunique()")                  a cheap check on inherited state
queryResult("ledger",        "df.iloc[10:15]")                            a specific row range
```

Three rules this tool makes cheap enough to always follow:

- **Never answer from a truncated table.** Rendered tables are clipped to a
  budget; the rows you can see are not necessarily all the rows there are.
  If a render says or implies it was cut off, query the full answer
  (`df.nlargest(...)`, a filter, a count) before reporting anything.
- **Report whole rows.** When the answer names selected rows (top-5, the ones
  that changed, the ones that qualify), report EVERY column of those rows as
  the source table carries them — not just the one metric you ranked by. If
  the full rows are not on screen, one query fetches them.
- **Check inherited numbers before building on them.** A count, a sum, or a
  distinct on a table an earlier turn produced costs one call. When this
  turn's work rests on that table being right, spend the call.
