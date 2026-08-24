Worked example — solving a new turn from the catalog and the dataflow index.

You are starting turn 24. Your context is the catalog of 23 finished turns and
the dataflow index; the parts that matter here (excerpted):

```
## Turn 3
### Task
Define the incident screen: shifts with at least 150 collapsed incidents. How many pass?
### Dataflow delta
#### `shift_screen` (added)
Summary: Screen flag on shift_counts
Upstream: shift_counts
Result: 812 rows x 4 cols
    def process(shift_counts):
        out = shift_counts.copy()
        out['incident_screen'] = out['incident_row_count'] >= 150
        return out
### Solution
incident screen = incident_row_count >= 150 on shift_counts, flag column incident_screen; a shift passes when the flag is true
### Answer
371 shifts pass the screen.

## Turn 12
### Task
Tighten the screen to 300 for a sensitivity check, and use the tightened screen going forward.
### Dataflow delta
#### `shift_screen` (revised)
    ... out['incident_screen'] = out['incident_row_count'] >= 300 ...
### Solution
incident screen tightened to >= 300 (supersedes turn 3's 150 threshold going forward)
### Answer
128 shifts pass the tightened screen.

# Dataflow (built from previous turns)
- `shift_counts` (since turn 1) Incident counts per shift — 812 rows; cols: shift_id, incident_row_count, ...
- `shift_screen` (since turn 12) Screen flag on shift_counts — 812 rows; cols: shift_id, incident_row_count, incident_screen
- `todays_shifts` (since turn 23) Today's shift roster — 57 rows; cols: shift_id, crew

## Turn 24 (current turn)
### Task
Return to the incident screen as it stood before the tightening and report how many of
today's shifts pass it, and how many pass only the tightened screen.
```

Thought: The live `shift_screen` is the LATEST version — turn 12 replaced the
threshold, so I cannot read the old screen off current state. But nothing was
lost: turn 3's entry prints the exact code (`>= 150`, flag `incident_screen`),
and its Solution states the rule. I copy the turn-3 logic verbatim — quoted
from its printed code, not re-typed from prose — and apply both thresholds
side by side in one new operator. (Had the entry's code aged out or had I
needed its VALUES, the first step would be
`recallState(ref: "shift_screen (turn 3)")` — read, then work.)

Tool call: `createOrModifyOperator` `screen_comparison` = from `shift_counts`
and `todays_shifts`: join on `shift_id`; count today's shifts with
`incident_row_count >= 150` (copied from turn 3's printed code), and shifts
with `>= 300` but not `>= 150` (impossible by construction — the check
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
only remove shifts, never add. One operator, zero recalls, done. This turn
re-applied two recorded rules and settled nothing new, so `decisions` stays
empty.

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
That line, plus the code printed in its entry, is why turn 24 could restore
the screen exactly instead of guessing — and why turn 12, when it CHANGED the
rule, said so explicitly ("supersedes turn 3's 150 threshold") instead of
leaving two contradictory decisions standing. The same habit applies when a
turn repeats a pattern on a new target — a model retrained for a sibling
column, a metric recomputed for another entity: copy the defining turn's
printed code and edit only the target, never rebuild it from the Solution's
prose.
