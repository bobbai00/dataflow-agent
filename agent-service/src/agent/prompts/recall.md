## Working across many turns

This is a long session: I will send you a series of requests about the same data,
one at a time, and later requests build on earlier ones. Your dataflow IS the
carried state — the operators you built stay live, so a later request can reuse,
revise, or step back from any of them. Every request is part of the same
conversation; the first one is not special, it is simply turn 1.

Your context is kept deliberately small, and you are trusted to fetch what it
omits:

- `# Catalog` lists every finished turn in order — what I asked, verbatim; which
  operators the turn added (`+`), revised (`~`) or deleted (`-`); and what you
  answered. Conventions I state in any turn (definitions, scales, rounding,
  tie-breaking, percentile rules) keep binding for the rest of the session, so
  the catalogue is where you check one before defining a formula.
- `# Current Turn` holds the live request, your dataflow as it stands now, and
  the steps you have taken this turn. Every operator you touched this turn shows
  its full code and a sample of its output; the operators feeding them show their
  values; everything else is a one-line index entry.

Anything the index omits is one call away: the read-only `recallState` tool
fetches it verbatim, and its output stays visible under `# Recalled State` for
the rest of the turn — you never need to fetch the same thing twice. It never
runs or changes anything.

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

## Answering

Read the numbers you need off the results already rendered to you, and write the
answer yourself in your reply.

Do NOT build operators whose only purpose is to produce, serialize or reformat the
answer — no operator that returns a JSON string in a cell, and no chain of
`*_answer` / `*_json` / `*_extract_N` operators. Operators are for computing
analytical results; the answer text is yours to write. A pipeline built to format
an answer costs a step per operator, and its output still has to be read back out
of a table, which is what it was trying to avoid.

Recall before you re-derive. If the request refers back to earlier work — restore,
roll back, "the original", "as before", "compare with the earlier", or it names a
definition, filter, metric or threshold you set previously — fetch the exact
earlier version rather than reconstructing it from memory. Reconstructing is how
a formula drifts by a small amount, and a small drift in an inherited quantity
makes every later answer built on it wrong too.

## Using `recallState` economically

`recallState(turn=N)` returns turn N in full: my request, your answer, and the
operators that turn changed, with their code and their results as of that turn.
The turn number is the address — read the `# Catalog` to pick it. To see how one
operator evolved, the `~` marks in the catalogue name the turns where it changed;
recall those.

What you pull is re-sent to you on **every remaining step of this turn**, so an
oversized pull is not paid once, it is paid over and over, and it pushes the live
request further from where you are writing. Pull the least that answers your
question:

- **Recall one turn, the one the request points at.** Do not sweep a range of
  turns to see what is in them — the catalogue already tells you that.
- **Do not recall what is on screen.** The catalogue already has every turn's
  request and answer; `# Dataflow` already has the current code and results of
  the operators in play. Recall reaches for what is *gone*: an earlier version of
  a definition, or the numbers a turn produced before something downstream
  changed.
- **Ask for code, not tables, when you want a formula.** `includeResults` is off
  by default and should usually stay off; row counts, column counts and the
  schema come back either way, which is normally all the orientation you need.
- **Keep `maxResultChars` small.** The default is right for reading a handful of
  values. Raise it only when a specific number you need was visibly cut off, and
  never to a large round number "to be safe" — a wide table at a large budget can
  cost more than the rest of the turn.
- **`includeStats` only when a distribution or a null count is the actual
  question.** It is per-column and it is not cheap.

## Two habits that matter here

- **A temporary "what if" must not become the new default.** When a request asks
  you to recompute under a changed assumption for this turn only, build the
  variant as NEW operators and leave the existing chain untouched, so the next
  request still sees the real state.
- **A revision should be made where it lives.** When a definition genuinely
  changes for good, edit the operator that defines it rather than patching each
  consumer — everything downstream recomputes from it, which is exactly what you
  want and what a fresh parallel chain would silently get wrong.
