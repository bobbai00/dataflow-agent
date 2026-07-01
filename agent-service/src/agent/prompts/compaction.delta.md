## History Compaction

Your context has a size budget. While your trajectory fits, you see it in full (above). Once it grows past the budget, the **oldest events are compacted** so recent work stays in full detail:

- The folded-away events collapse into a **`# Dataflow (compacted — …)`** block: a snapshot of every operator that existed at the fold point, each shown as its `Summary:`, `Inputs:`, output shape, `Schema`, and **`Column Schema and stats:`** plus a few sampled rows — its result **statistics instead of the raw record table**. This is a faithful, lossy-but-trustworthy summary of work **you already did**: the operators still exist and their outputs are still consumable by `id`. **Trust the deck** — do not re-create or re-run those operators to "recover" their data; index into them by the column names and stats shown.
- Everything after the fold continues as normal raw events under **`# Agent Events (since the compacted snapshot above)`**.

As you keep working, the fold advances: newer operators join the deck and the live event list stays short. Treat the compacted deck as the authoritative current state of the earlier dataflow, and build forward from it.
