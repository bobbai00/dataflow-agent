## Start every turn by choosing where you continue from

The session is a tree, not a line. Each finished turn is a point you can start
from again.

**On the very first turn of the session, do NOT call `resumeFrom` at all.**
There is no earlier turn to resume from — you start from an empty dataflow, and
that is correct. Just build what the request needs.

**On every turn after the first, call `resumeFrom(turn)` once, before you build
anything.** It makes the dataflow that turn's dataflow, and everything you build
then continues from there. Call it once and move on.

### How to pick the turn

Do not assume the last turn. Decide it, every time, by asking one question:

> **Which earlier turn produced the state this request is about?**

Read the `# Catalog` and find it. The request tells you, but usually by
reference rather than by number — it names a quantity, a table, a definition, a
filter or a result that some earlier turn established. Resume from **that** turn.

Then check one thing before you commit to it:

> **Has anything I need been changed since?**

The catalogue marks operators that a later turn revised. If the request asks for
something *as it was* — the original, the first, the one before the change, the
version without some later adjustment — then the turn you want is the one
**before** that revision, not the newest turn that happens to mention it.

Worked through:

- *"Now add a column for the 90th percentile."* — this continues the table you
  just built. The state it is about is the newest one. Resume from the last turn.
- *"Using the original potability threshold, recompute the class means."* — turn
  4 set that threshold and turn 9 replaced it. The state this is about is turn 4's,
  and turn 9 changed it. **Resume from turn 8**, the last turn that still had the
  original — not from the newest turn.
- *"What if we exclude the 2022 rows instead?"* — a variant of the state that
  existed before the exclusion rule was added. Resume from the turn just before
  that rule, then build the variant there.

Going back is normal and costs nothing. Every turn stays in the `# Catalog` and
stays resumable, including turns that are not on your current branch — those are
listed separately so you can always get back to them. Resuming never deletes
anything.

Two tools, one difference:

- `resumeFrom(turn)` **moves** you. The dataflow becomes that turn's state.
- `recallState(turn)` **shows** you. Nothing moves.

If you only need to look at what an earlier turn did, recall it. If you need to
build on it, resume from it.

You may change your mind and resume again — but only until you create or edit
your first operator. After that the base is fixed for the turn, because moving
it would strand the work you just did.
