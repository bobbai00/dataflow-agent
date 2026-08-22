**Working with the catalog.** The catalog is not a transcript — it is an immutable version store, and it makes you three guarantees:

1. **Nothing is ever lost.** Every version of every operator stays addressable as `(operatorId, turn N)` forever. Revising an operator creates a NEW version; the old one remains wireable state, not history.
2. **Every entry is a complete record.** A finished turn's entry holds the task word for word, each operator version it added or revised (code, upstream provenance, result shape, column stats), and the answer given. Whatever an earlier turn established — a threshold, a flag column, a roster, a convention — is written there exactly; you never have to remember or guess it.
3. **Wiring recomputes deterministically.** Feed any version — current or superseded — into a new operator and downstream results follow from that exact state.

The method that follows: **read entries instead of re-deriving, wire versions instead of rebuilding, and `recallState` a version whenever the exact values matter.** One caution: a version pin records when an operator was last REBUILT, not what is currently in effect — if a turn declared a change "for everything that follows", that covers operators nobody physically rebuilt, so check the task texts for the latest declarative change before trusting a pin.

Worked example — solving a new turn from the catalog.

You are starting turn 24. Your context is the catalog of 23 finished turns; the ones that matter here (excerpted):
```
## Turn 3
### Task
Define the incident screen: shifts with at least 150 collapsed incidents. How many pass?
### Dataflow delta
#### shift_screen (added)
- Upstream: shift_counts (turn 1)
- Result: 812 rows x 4 cols — Schema: shift_id, incident_row_count, incident_screen, ...
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

Thought: "The screen as it stood before the tightening" is not something to rebuild — guarantee 1 says it still exists: `shift_screen (turn 3)` at 150, superseded but addressable, next to the head `shift_screen (turn 12)` at 300. Both endpoints of the comparison are already in the catalog. Re-implementing either from memory is how answers drift (a remembered "150" becomes "300", a "top tenth" becomes `head(10)`); instead, confirm the old version's exact convention, then wire both. Start by recalling the turn-3 version — the entry shows its code, but the recall also gives its materialized values.

Tool call: `recallState` for `shift_screen (turn 3)`.

Observation:
```
- recallState shift_screen (turn 3)
  Result: 812 rows x 4 cols
  	shift_id	incident_row_count	incident_screen	...
  0	S-0001	212	True	...
  1	S-0002	87	False	...
  Column stats: "incident_screen" (bool): true=371, false=441
```

Thought: Confirmed — threshold 150, flag column `incident_screen`, 371 passing, matching the turn-3 answer. Now one operator that wires BOTH versions plus today's shifts; the code only joins and counts — neither threshold is restated anywhere, so nothing can drift.

Tool call: `createOrModifyOperator` `screen_comparison` = from `shift_screen (turn 3)`, `shift_screen (turn 12)`, and `todays_shifts`: join on `shift_id`; count shifts passing the turn-3 flag, and shifts passing the turn-12 flag but not the turn-3 one.

Observation:
```
- operator screen_comparison updated
  Inputs: shift_screen@t3 (812 rows), shift_screen@t12 (812 rows), todays_shifts (57 rows)
  Output Table: 1 rows, 2 cols
  	pass_restored	pass_tightened_only
  0	23	0
```

Thought: `pass_tightened_only = 0` is expected — a strictly stricter screen can only remove shifts, never add. Both numbers came off wired versions of the real conventions: one recall, one operator, done.

Final answer: 23 shifts pass the restored screen; 0 pass only the tightened screen.
