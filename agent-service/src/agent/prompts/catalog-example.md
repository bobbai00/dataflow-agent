**Working with the catalog.** The catalog is not a transcript — it is an immutable version store, and it makes you three guarantees:

1. **Nothing is ever lost.** Every version of every operator stays addressable as `(operatorId, turn N)` forever. Revising an operator creates a NEW version; the old one remains wireable state, not history.
2. **Every entry is a complete record.** A finished turn's entry holds the task word for word, each operator version it added or revised (code, upstream provenance, result shape — plus column stats and sample records on recent turns), and the answer given. Whatever an earlier turn established — a threshold, a flag column, a roster, a convention — is written there exactly; you never have to remember or guess it.
3. **Wiring recomputes deterministically.** Feed any version — current or superseded — into a new operator and downstream results follow from that exact state.

The method that follows: **read entries, quote conventions straight from the printed code, and wire versions.** Three rules that decide most answers:

- **Continue conventions, don't re-decide them.** Task text often leaves small interpretive choices open — which direction a ranking runs, what population a percentile is computed over, how a set is defined, how ties break. The turn that first settles such a choice records it, and its entry carries a `### Conventions` line forever. When you extend that turn's work, read its Conventions and match them exactly; re-deciding an already-settled choice is how two turns of correct code produce contradictory numbers.

- **The extension rule.** When a task references a previously computed list, roster, or top-N ("the portfolio leaders", "the watchlist", "the current high-risk rows"), take its members from the defining version and the answer recorded with it — never re-derive the membership from scratch. Re-derivation flips boundary members; the catalog holds the real extension. **Match the referent precisely**: several turns may hold similar artifacts (an issues top-10 AND a pull-requests top-10) — read the candidate entry's Task text and confirm it defines the artifact the current task names before copying anything from it.
- **The pin caution.** A version pin records when an operator was last REBUILT, not what is currently in effect. If a turn declared a change "for everything that follows", that covers operators nobody physically rebuilt — check the task texts for the latest declarative change before trusting a pin.

`recallState` is the exception, not the routine: entries already show code, stats, and recent sample records, and **a recall that only confirms what an entry already shows is pure cost**. Recall only when you need values beyond what is printed — the full membership of a large set, specific mid-table records, or the values of an OLD entry whose stats and samples have aged out of the render. One hard rule the other way: **never guess a column name.** If you are about to wire or filter a table whose exact columns you cannot read off the entry (old entries show only code — if the code does not spell out the output columns, you do not know them), spend the one recall first; a KeyError costs an execution and a retry, the recall costs neither. And never recall an operator created in the current turn; its results are already in your observations.

Worked example — solving a new turn from the catalog.

You are starting turn 24. Your context is the catalog of 23 finished turns; the ones that matter here (excerpted):
```
## Turn 3
### Task
Define the incident screen: shifts with at least 150 collapsed incidents. How many pass?
### Dataflow delta
#### shift_screen (added)
- Upstream: shift_counts (turn 1)
- Result: 812 rows x 4 cols
- Code:
    def process(shift_counts):
        out = shift_counts.copy()
        out['incident_screen'] = out['incident_row_count'] >= 150
        ...
### Answer
371 shifts pass the screen.

## Turn 12
### Task
Tighten the screen to 300 for a sensitivity check, and use the tightened screen going forward.
### Dataflow delta
#### shift_screen (revised)
- Upstream: shift_counts (turn 1)
- Code:
    ... out['incident_screen'] = out['incident_row_count'] >= 300 ...
### Answer
128 shifts pass the tightened screen.

## Turn 24 (current turn)
### Task
Return to the incident screen as it stood before the tightening and report how many of
today's shifts pass it, and how many pass only the tightened screen.
```

Thought: "The screen as it stood before the tightening" is not something to rebuild — guarantee 1 says it still exists: `shift_screen (turn 3)` at 150, superseded but addressable, next to the head `shift_screen (turn 12)` at 300. Turn 3's entry already shows the convention exactly — code `>= 150`, flag column `incident_screen`, 371 passing recorded in its answer. There is nothing to confirm by recalling; quote it and wire both versions. The code only joins and counts — neither threshold is restated anywhere, so nothing can drift.

Tool call: `createOrModifyOperator` `screen_comparison` = from `shift_screen (turn 3)`, `shift_screen (turn 12)`, and `todays_shifts`: join on `shift_id`; count shifts passing the turn-3 flag, and shifts passing the turn-12 flag but not the turn-3 one.

Observation:
```
- operator screen_comparison updated
  Inputs: shift_screen@t3 (812 rows), shift_screen@t12 (812 rows), todays_shifts (57 rows)
  Output Table: 1 rows, 2 cols
  	pass_restored	pass_tightened_only
  0	23	0
```

Thought: `pass_tightened_only = 0` is expected — a strictly stricter screen can only remove shifts, never add. One operator, zero recalls, done. (Had the task instead needed, say, the exact member rows of a large turn-3 roster whose samples have aged out of the render, THAT would be the moment for one `recallState` of `roster (turn 3)` — pulling values the entry no longer shows.) This turn didn't settle any new interpretation — both thresholds were quoted from their defining entries — so conventions stays empty.

Tool call: `answer`
```
answer(
  answer: "23 shifts pass the restored screen; 0 pass only the tightened screen.",
  conventions: ""
)
```

And for contrast, what turn 3 itself — the turn that DEFINED the screen — would have handed in:
```
answer(
  answer: "371 shifts pass the screen.",
  conventions: "incident screen = incident_row_count >= 150, flag column incident_screen; a shift passes when the flag is true"
)
```
That one line is why turn 24 could restore the screen exactly instead of guessing what "at least 150 collapsed incidents" had been taken to mean.
