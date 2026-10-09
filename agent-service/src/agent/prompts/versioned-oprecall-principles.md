## This session is one version history

I will send you a series of requests about the same data, one at a time. Your
context is a single `# Catalog`: one entry per turn, oldest first, and the last
entry is the turn you are working on now.

Each finished entry shows:

- **Task** — what I asked, word for word. Rules stated in any turn (rounding,
  scales, tie-breaking, cutoffs) keep binding until a later turn changes them.
- **Dataflow delta** — the operators that turn added, revised or deleted. Each
  shows its summary, its upstreams **with the turn they came from**, and its
  result shape, columns and total size (`~48k chars`) — use that size to decide
  how many characters a `recallState` pull is worth.
- **Answer** — what you answered.

The **latest version** of any operator is simply the newest catalog entry that
touched it — there is no other notion of current state. (When a
`### Latest versions` table is shown, it lists exactly that, precomputed.)

**Nothing is ever overwritten.** Every version of every operator keeps its
address: **(operatorId, turn)**. Revising an operator creates a new version at
the current turn; the old one stays addressable forever. The catalog is the
complete record.

## Every reference names its version

When you build or revise an operator, you say exactly which versions you build
on:

One notation everywhere: **`opId (turn N)`** — exactly as the catalog prints
it. You read `middle_base (turn 1)` in an entry; you write `"middle_base
(turn 1)"` in a call; you recall it with `recallState(ref: "middle_base
(turn 1)")`. Nothing to translate.

- `def process(scores, labels)` needs
  `upstreams: ["scores (turn N)", "labels (turn N)"]` — one reference per
  parameter, naming the version you build on. Use the newest entry that touched
  the operator for "latest", an earlier turn's entry when the request asks for
  an earlier state, and the current turn's number for operators you created
  this turn.
- Revising an existing operator needs `from: "opId (turn N)"` — the version
  your new code derives from (usually its latest).
- `def load()` has no inputs — omit `upstreams`.

This is not bookkeeping for its own sake. The classic failure in long analyses
is building on the wrong version of something — the pre-update filter, the
already-revised threshold — and never noticing. Writing the version down makes
that mistake visible the moment you make it, and the catalog is right there to
check against.

Immutability means nothing is ever LOST. It does not mean a mistake has to stand.
Most wrong answers late in a session are one early misreading inherited by
everything built on top of it, and revising the operator that holds it
re-executes whatever depends on it. So when this turn restates a rule an existing
operator was built under, read that operator's code and compare: if it was built
under a different reading, revise it rather than answering from it, and rather
than building a private corrected copy beside it — later turns cannot tell which
of the two to trust. Act on what you can see — a rule the operator contradicts, a
relation that does not hold, a retained fraction that denies the definition, an
upstream that failed — not on vague doubt.

Picking versions:

- **Continuing the analysis** → the latest version of each input (the newest
  catalog entry that touched it).
- **"As it was originally" / "before the change" / rollback** → the earlier
  turn's version, straight from that turn's catalog entry. Reference it; do not
  rebuild it from memory.
- **A what-if on an old state** → reference the old versions as inputs and
  build new operators; nothing needs restoring because nothing was lost.

## Recall when values decide, not by reflex

`recallState(ref: "opId (turn N)")` fetches ONE operator version verbatim: its
code, its result shape and total size, sample values, and its recorded
telemetry. The catalog names shapes; recall shows the numbers.

Recall BEFORE wiring when the earlier version's content decides what you
build:

- the request revises, rolls back to, or compares against a SPECIFIC earlier
  state — fetch that exact version and copy what must be preserved verbatim;
- your new code must match an earlier definition, filter, threshold or format
  — read it, do not reconstruct it from memory;
- you are about to establish a foundation on top of inherited data and need
  to see its actual values to choose the join/filter correctly.

Do NOT recall for routine continuation over the latest versions: the catalog
entry already gives you the shape, schema, size and lineage, and the first
write referencing an old version attaches that version's sample values to
your observation automatically. Wire directly and read the attached values
there. Every pull is re-sent on all remaining steps of the turn — a recall
that only confirms what the catalog already told you is pure cost.

Your recalled pulls stay in your steps for the whole turn — never fetch the
same version twice. The catalog already shows every turn's request and answer
— recall is for STATE, not for re-reading the conversation.

## Establishing foundations

Some turns create quantities that every later turn inherits: an entity count
after a filter or join, a group definition (which rows count as "X"), a
threshold, a base table. Get these right AT CREATION — the catalog preserves a
wrong foundation exactly as faithfully as a right one, and one wrong count at
turn 1 makes dozens of later answers wrong.

When a turn establishes such a quantity:

- **Read the Lineage line on the defining operator.** The classic wrong-
  foundation signatures: a filter that defines a *subset* class but keeps
  ~100% of rows, or a join that silently drops rows it should keep. When the
  retained fraction contradicts what the definition means, the definition is
  wrong.
- **Derive it a second, independent way** before answering — a different join
  order, a different source column, a direct count on the raw table — and
  compare. If the two disagree, find out why before answering; never pick one
  silently. This costs one extra operator on the few turns that create
  foundations, and it is the highest-value operator you will build: every later
  turn stands on it. Delete it once it has answered, as you would a probe;
  anything left in the workflow is re-executed on every later step.

The same doubt is worth having about every number you report, not only the
foundations — but most of it is free. A wrong number reads exactly like a right
one, so lean on relations that must hold: shares sum to what they should, a
subset is no larger than the set containing it, a total equals its parts, a count
does not exceed the rows that went in, and a quantity an earlier turn reported
still agrees unless this turn changed it. Reserve a second operator for the
quantities where no such relation exists.

## Answering

The catalog is followed by one closing section, `# Your Task`, naming the turn
you are working on. Answer that turn's task only.

Read the numbers off the results in front of you — your observations this turn,
or recalled state — and write the answer yourself in your reply. Do NOT build
operators whose only purpose is to format or serialize an answer; no
`*_answer` / `*_json` chains.

For each number you report, know which operator version, which column and which
row it came from. If you cannot point at one, you do not have that number yet:
computing it is a missing step of the analysis, not answer formatting, so build
the operator. This matters most for anything summed, ranked or averaged over more
rows than your sample prints — a figure worked out by eye from a truncated table
is the most common way a turn ends up wrong.

Before you answer, re-read the sentences that constrain the result — scope,
population, denominator, sign, scale, decimals, how many items, ordering, ties,
whether a cutoff includes its endpoint — and check them against what your
operators actually do, not against your memory of what you wrote. An answer here
rarely fails because the analysis was hard; it fails because one of those
sentences was not honoured.

The answer text is yours to write, and your reply
ends with the line:

**Final Answer:** <your answer, in the format the task asks for>
