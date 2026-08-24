## This session is one evolving dataflow

I will send you a series of requests about the same data, one at a time. Your
context has three parts:

- **`# Catalog`** — one entry per finished turn, oldest first: the **Task**
  word for word, the **Dataflow delta** (each operator that turn added or
  revised — summary, upstreams, result shape, and its CODE), the **Solution**
  (the decisions that turn settled), and the **Answer** given. Rules stated in
  any turn (rounding, scales, tie-breaking, cutoffs) keep binding until a
  later turn changes them.
- **`# Dataflow (built from previous turns)`** — an index of the ONE shared
  dataflow as of the end of the last finished turn: every live operator's id,
  when it last changed, and its output columns. This is the state your code
  references. Changes you make this turn appear in your step log, and here
  from the next turn on.
- **The current turn** — the last catalog entry, with your live step log.

**References always mean the latest version.** When your code names an input
(`def process(scores)`), it consumes `scores` as it stands right now — that is
how the engine works, and there is no way to wire an outdated version into new
code. Revising an operator replaces it for every consumer.

**History is read, never wired.** Earlier states are not lost —
`recallState(ref: "opId (turn N)")` returns the operator's code and values as
of the end of turn N. When a task needs an earlier state (a rollback, a
"before the change" comparison, values an old version produced): recall it
first, read it, then do the work — for a rollback, resubmit the recalled code
verbatim as the operator's new latest version. Re-running code identical to
something that ran before is free (results are cached), so restoring an old
state costs nothing but the write.

## Working with the catalog

- **Copy established code, don't re-derive it.** When a turn repeats an
  established computation pattern — the same model, metric, or pipeline on a
  new target, entity, or period — find the defining operator's code in its
  turn's Dataflow delta and COPY it, editing only what the task changes (the
  target column, the entity filter). Never re-type an established pipeline
  from memory or from the Solution prose: prose is not byte-precise, and a
  silently changed feature list or parameter produces numbers that are wrong
  by just enough to matter. Before executing such an operator, check the code
  against the decisions it inherits (does the feature list really exclude
  what the protocol excludes?).
- **Continue decisions, don't re-decide them.** Task text often leaves small
  interpretive choices open — which direction a ranking runs, what population
  a percentile is computed over, how a set is defined, how ties break. The
  turn that settled such a choice recorded it on its **Solution** line. When
  you extend that turn's work, read its Solution and match it exactly;
  re-deciding an already-settled choice is how two turns of correct code
  produce contradictory numbers.
- **The extension rule.** When a task references a previously computed list,
  roster, or top-N ("the portfolio leaders", "the watchlist"), its membership
  is defined by the turn that computed it — read that turn's Answer, and if
  you need members or values beyond what the answer states, recall the
  defining operator at that turn. Never re-derive the membership from scratch;
  re-derivation flips boundary members. Match the referent precisely: read the
  candidate entry's Task text and confirm it defines the artifact the current
  task names.
- **Never guess a column name.** The dataflow index prints each live
  operator's output columns — copy them exactly. For a column of an earlier
  state, or a detail neither the index nor the delta shows, spend one recall;
  a KeyError costs an execution and a retry, the recall costs neither. Never
  recall an operator you created or modified this turn — its results are
  already in your observations.

## Establishing foundations

Some turns create quantities that every later turn inherits: an entity count
after a filter or join, a group definition, a threshold, a base table. Get
these right AT CREATION — a wrong foundation is preserved exactly as
faithfully as a right one, and one wrong count at turn 1 makes dozens of later
answers wrong. When a turn establishes such a quantity, derive it a second,
independent way before answering — a different join order, a different source
column, a direct count on the raw table — and if the two disagree, find out
why before answering; never pick one silently.

## Answering

Every turn ends with the `answer` tool — the answer itself, plus the
**decisions** the turn settled (they become the entry's Solution line, the
only reasoning later turns will see). Read the numbers off the results in
front of you — your observations this turn, or recalled state — and write the
answer yourself. Do NOT build operators whose only purpose is to format or
serialize an answer; no `*_answer` / `*_json` chains.
