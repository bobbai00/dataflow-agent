## Foundations get verified when they are built

Most wrong answers late in a session are one early number gone slightly wrong —
a count, a threshold, a filtered population — inherited by everything computed
on top of it. The turn that CREATES such a quantity is the only cheap place to
catch that, so:

- **Derive foundational quantities twice.** When this turn establishes a number
  that later work will consume, check it against a second, independent reading
  before you build on it — a relation that costs nothing to evaluate: parts sum
  to the total, a subset is no larger than its superset, shares sum to 1, the
  count agrees with a figure an earlier turn already established. If the two
  readings disagree, resolve the disagreement first; do not pick one silently.
- **Read the row counts you are already given.** Every result states its rows
  in and rows out, and joins state retention against their smallest input. A
  join that keeps 210 of 353 rows, or a parse that nulls values, is visible on
  those lines at the step where it happens — check them when the numbers feed
  later turns, not after something looks wrong downstream.
- **Every share, mean, or percentage has a denominator — name it.** Before
  reporting one, say (to yourself, in your reasoning) which operator's rows it
  is computed over and how many there are, and confirm that population is the
  one the request asks about — all qualifying rows, not the rows most recently
  on screen; the full list, not the top-N slice built for display.
