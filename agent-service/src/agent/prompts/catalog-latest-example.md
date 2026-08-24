Worked example — solving a new turn from the catalog and the latest dataflow.

You are starting turn 24. Your context is the catalog of 23 finished turns and
the latest dataflow; the parts that matter here (excerpted):

```
## Turn 3
### Task
Define the incident screen: shifts with at least 150 collapsed incidents. How many pass?
### Solution
incident screen = incident_row_count >= 150 on shift_counts, flag column incident_screen; a shift passes when the flag is true
### Answer
371 shifts pass the screen.

## Turn 12
### Task
Tighten the screen to 300 for a sensitivity check, and use the tightened screen going forward.
### Solution
incident screen tightened to >= 300 (supersedes turn 3's 150 threshold going forward)
### Answer
128 shifts pass the tightened screen.

# Dataflow (latest)
- `shift_counts` (since turn 1) Incident counts per shift — 812 rows; cols: shift_id, incident_row_count, ...
- `shift_screen` (since turn 12) Screen flag on shift_counts — 812 rows; cols: shift_id, incident_row_count, incident_screen
- `todays_shifts` (since turn 23) Today's shift roster — 57 rows; cols: shift_id, crew

## Turn 24 (current turn)
### Task
Return to the incident screen as it stood before the tightening and report how many of
today's shifts pass it, and how many pass only the tightened screen.
```

Thought: The dataflow's `shift_screen` is the LATEST version — turn 12's `>= 150`
became `>= 300`, so I cannot read the old screen off the live state. But nothing
was lost: turn 3's Solution line states the old rule exactly (`>= 150`, flag
column `incident_screen`), and if I needed its code or values verbatim I would
recall `shift_screen (turn 3)`. Here the Solution line already pins the rule, so
one new operator can apply both thresholds side by side. The tightened rule is
on the live `shift_screen`; the restored rule I re-derive from the recorded
decision — quoted, not re-decided.

Tool call: `createOrModifyOperator` `screen_comparison` = from `shift_counts`
and `todays_shifts`: join on `shift_id`; count today's shifts with
`incident_row_count >= 150` (the turn-3 screen, per its Solution line), and
shifts with `>= 300` but not `>= 150` (impossible by construction — the check
verifies it).

Observation:
```
- operator screen_comparison updated
  Inputs: shift_counts (812 rows), todays_shifts (57 rows)
  Output Table: 1 rows, 2 cols
  	pass_restored	pass_tightened_only
  0	23	0
```

Thought: `pass_tightened_only = 0` is expected — a strictly stricter screen can
only remove shifts, never add. One operator, zero recalls, done. (Had turn 3's
Solution NOT spelled the rule out — or had the task needed the exact member
rows of the old screen — the first step would have been one
`recallState(ref: "shift_screen (turn 3)")` to read the old code and values,
THEN the write.) This turn re-applied two recorded decisions and settled
nothing new, so `decisions` stays empty.

Tool call: `answer`
```
answer(
  answer: "23 shifts pass the restored screen; 0 pass only the tightened screen.",
  decisions: ""
)
```

And for contrast, what turn 3 itself — the turn that DEFINED the screen —
handed in:
```
answer(
  answer: "371 shifts pass the screen.",
  decisions: "incident screen = incident_row_count >= 150 on shift_counts, flag column incident_screen; a shift passes when the flag is true"
)
```
That one line is why turn 24 could restore the screen exactly instead of
guessing what "at least 150 collapsed incidents" had been taken to mean — and
why turn 12, when it CHANGED the rule, said so explicitly ("supersedes turn
3's 150 threshold") instead of leaving two contradictory decisions standing.
