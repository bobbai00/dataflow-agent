# Agent demo playbook — Boston house values

One dataset, six turns, one bad chart: **Roslindale comes out as Boston's priciest neighborhood, and
it isn't.** Sixty of its 3 349 assessments carry a misplaced decimal point — houses priced at
$50–123 M — and that is enough to drag the average to the top of the ranking while hiding completely
in any table preview. The human doesn't believe the chart, asks to see the distribution, spots the
junk, and tells the agent to drop it. The answer to the original question changes. That is the demo:
the human's feedback is what makes the analysis *correct*, not a nicety.

| Beat | Turn | The human's move | What comes back |
|---|---|---|---|
| Look first | 1 | "whats in this file?" | 29 178 homes × 23 columns, described, no chart |
| Ask | 2 | "which neighborhoods are pricey? bar chart" | **Roslindale $2 006 818**, Charlestown $1 428 040… |
| **Disbelieve** | 3 | "roslindale #1 makes no sense — show me its distribution" | Histogram: everything under $1.7 M, plus a $103 M home |
| **Correct it** | 4 | "those are junk, drop anything over $10 M and redo the chart" | 60 rows out; **Charlestown is #1**, Roslindale falls to 9th |
| **Audit the fix** | 5 | "how many did that throw away? other neighborhoods too?" | 60 of 29 178, **1.79 % of Roslindale, 0 % everywhere else** |
| Model, on clean data | 6 | "predict value from size and rooms" | R² 0.34, MAE $181 780 |

Each turn reacts to the last answer: the human supplies suspicion, the agent supplies the operators.
Three operator families, one job each — **relational** for the ETL, **visualization** for the charts,
**`DataProcessing`** for the model — which is what the code-mode system prompt tells the agent
([`agent-service/src/agent/prompts.ts`](../agent-service/src/agent/prompts.ts)).

> **Verification status (2026-09-01).** All six turns verified end to end with `claude-haiku-4.5`
> against the live local stack: workflow 379, 13 operators, ~87 s of agent time, every number in this
> document copied from that run.

Replaces the older two-demo playbooks ([full](agent-demo-playbook.md),
[simple](agent-demo-playbook-simple.md)).

---

## 1. The dataset

> ⚠️ **This is a doctored cut, not real assessment data.** Sixty Roslindale rows were deliberately
> corrupted so the demo has a data-quality problem to find. Roslindale's real average single-family
> value in the FY2026 roll is **$721 k** — mid-pack, ninth of sixteen. Never present these numbers
> as facts about Boston, and don't reuse the file for anything but the demo.

**City of Boston FY2026 Property Assessment** — the city's own assessed-value roll, revision dated
**2026-05-22**, from <https://data.boston.gov/dataset/property-assessment> (184 552 parcels, 76 MB).
Deliberately *not* the 1970s "Boston Housing" toy set from StatLib: 506 rows, half a century old,
and carrying the racially-derived `B` column that scikit-learn removed in 1.2.

Loaded as dataset **`boston-housing-demo`**, version `v4`, file
`boston_single_family_fy2026_demo.csv` — path
`/agent-demo@texera.dev/boston-housing-demo/v4/boston_single_family_fy2026_demo.csv`
(**29 178 rows × 23 columns**).

Prepared by [`prepare-boston-demo.py`](../agent-service/benchmark/e2e/demo/prepare-boston-demo.py)
from the raw city file: keeping land-use `R1` (single-family), dropping the 725 homes assessed over
$3 M (a tail reaching $30.6 M that swamps every average), dropping 35 rows with missing numerics,
removing `YR_REMODEL` (blank for 55 % of homes), and stripping thousands separators. Then two edits
**for the demo**:

1. **The 503 rows labelled `CITY = BOSTON` were removed.** In this file `CITY` is really the
   *neighborhood* (Dorchester, Brighton, Jamaica Plain…), and the value `BOSTON` means the downtown
   core — a row that reads as "Boston, in the Boston dataset" and derails the story every time.
   Without it, every value of `CITY` is unambiguously a neighborhood.
2. **Sixty Roslindale rows had `LAND_VALUE` and `BLDG_VALUE` multiplied by 100** (`TOTAL_VALUE`
   recomputed as the sum) — a decimal-shift entry error, the kind that really happens. Those homes
   now sit between **$46 730 000 and $123 230 000**. Nothing physical was touched, so each one is an
   ordinary 1 500-sqft house carrying an impossible price: indefensible to keep, easy to justify
   dropping.

The arithmetic that makes the demo work:

| Roslindale | Value |
|---|---|
| Homes | 3 349 |
| Corrupted rows | 60 (**1.79 %**) |
| **Mean** `TOTAL_VALUE` | **$2 006 933** ← tops the ranking |
| **Median** `TOTAL_VALUE` | **$697 300** ← unmoved, would rank 9th |
| Real mean, once the 60 are gone | $721 089 |

Sixty rows out of 3 349 are invisible in a sample-data preview and fatal to an average. The mean and
the median disagree by 2.9×, and only one of the two is on the chart.

Why Roslindale hosts the corruption: 3 349 homes, so "it's a small sample" is off the table when
turn 5 checks; and a real average of $721 k, so it has no business topping a price chart — the
anomaly is the only reason it does.

| Group | Columns |
|---|---|
| Identity / location | `PID`, `CITY`, `ZIP_CODE` |
| Size | `LAND_SF`, `GROSS_AREA`, `LIVING_AREA` |
| Rooms | `BED_RMS`, `FULL_BTH`, `HLF_BTH`, `TT_RMS`, `KITCHENS` |
| Extras / age | `YR_BUILT`, `FIREPLACES`, `NUM_PARKING`, `HEAT_TYPE`, `AC_TYPE`, `OWN_OCC` |
| Condition (graded strings) | `OVERALL_COND`, `INT_COND`, `EXT_COND` |
| Values | `LAND_VALUE`, `BLDG_VALUE`, **`TOTAL_VALUE`** |

The neighborhood table as the *uncorrupted* data has it (average `TOTAL_VALUE`, homes) — this is
the ranking turn 4 restores:

| | | | |
|---|---|---|---|
| Charlestown $1 428 040 (1 050) | Jamaica Plain $1 186 303 (1 898) | South Boston $1 020 872 (1 333) | Chestnut Hill $931 407 (122) |
| Brighton $913 601 (1 192) | Allston $883 072 (356) | West Roxbury $803 977 (6 551) | Dedham $747 625 (4) |
| Roxbury Crossing $727 819 (157) | **Roslindale $721 089 (3 349)** | East Boston $681 464 (906) | Dorchester $656 680 (5 093) |
| Hyde Park $583 091 (4 703) | Roxbury $560 092 (791) | Mattapan $541 504 (1 672) | Brookline $380 100 (1) |

`TOTAL_VALUE = LAND_VALUE + BLDG_VALUE` for all but 5 rows (the city's own rounding). Keep that in
your back pocket for turn 6 — an agent that keeps those two columns as features is reading the
answer off the table.

---

## 2. Setup

```bash
bin/local-dev.sh up --skip-build     # expect "14 of 14 services running"
```

- UI <http://localhost:4200>, login **`agent-demo` / `agent-demo-2026`**, computing unit
  **`agent-demo-cu`**.
- Open a new workflow → robot button (bottom-right) → **Claude Haiku 4.5** →
  **Create Agent** (name defaults to **Bob**; mode is already **General**, parallel tool calls on).
- **No operator setup needed.** The default allowlist is exactly what this demo uses: basic
  relational operators (`CSVFileScan`, `Filter`, `Projection`, `HashJoin`, `Aggregate`, `Sort`,
  `Limit`, `Union`, `Distinct`, `Intersect`, `Difference`, `TypeCasting`, `KeywordSearch`), the
  common charts (`BarChart`, `LineChart`, `PieChart`, `Histogram`, `Scatterplot`, `HeatMap`,
  `BoxViolinPlot`, `WordCloud`) and `DataProcessing` for custom Python. No sklearn or `Split`
  operators — turn 6's models are trained inside `DataProcessing`.
- **`bin/local-dev.sh status` warns you if the S3 endpoint drifted.** The MinIO endpoint is the
  host's LAN IP, baked into every JVM and into the Lakekeeper warehouse at startup; if the machine
  changed networks since the stack came up, executions hang ~30 s and fail while everything still
  reports "running". `status` prints the baked IP, the current one, and the fix
  (`down` then `up --skip-build`; volumes are kept). Run it before you present.
- You don't have to type the dataset path in turn 1 — **drag the CSV onto the agent panel** and its
  dataset path is uploaded and pasted into the message for you.

Left rail = **Dataflow Snapshots**: one pill per action-bearing step, oldest at the top, timestamps
on their own axis, active snapshot filled blue. Clicking a pill checks that version out and the
next message branches from it. (Pill `S1` is the agent's empty bootstrap snapshot, so turn *n* is
pill `S(n+1)`.)

---

## 3. The six turns

### Turn 1 — look before you leap
> whats in this file? /agent-demo@texera.dev/boston-housing-demo/v4/boston_single_family_fy2026_demo.csv

One `CSVFileScan`, and the answer is a *description*, not a chart: **29 178 rows × 23 columns**, every
column with its type and sample values. The turn most demos skip and every real analyst starts with.
Worth saying out loud: nothing here looks wrong. The corrupted rows are 0.2 % of the file and the
preview shows none of them.

### Turn 2 — the first real ask
> which neighborhoods are the pricey ones? bar chart pls

`Aggregate` (average `TOTAL_VALUE` by `CITY`) → `Sort` → `BarChart`. **Roslindale $2 006 818**, then
Charlestown $1 428 040, Jamaica Plain $1 186 297, South Boston $1 020 872. The agent picked the
columns and the aggregation out of "pricey" and "neighborhoods" — nobody typed `TOTAL_VALUE`. The
chart is clean, confident, and wrong.

### Turn 3 — disbelieve it, and ask to see the shape ← *the point of the demo*
> roslindale being #1 makes no sense to me. show me the distribution of home values in roslindale

Send it from the chart operator's own panel — the blue chat icon on the operator, which shows its
result rows and a feedback box — so the challenge is attached to the thing being challenged.

`Filter` (`CITY = ROSLINDALE`) → `Histogram` of `TOTAL_VALUE`. The shape gives it away instantly:
3 300-odd homes packed under $1.7 M, then nothing, then a handful of bars out past $100 M. The agent
reads its own chart and names the culprit — in the verified run, a **$103 070 000** single-family
home. An average could hide that. A distribution cannot.

### Turn 4 — correct it, and watch the answer change
> yeah those are junk - a single family home isnt worth $100 million. drop anything over 10 million and redo the neighborhood chart

`Filter` (`TOTAL_VALUE < 10000000`) → a fresh `Aggregate` → `Sort` → `BarChart`. **60 properties** of
29 178 leave, and the ranking rearranges: **Charlestown $1 428 044 is now #1**, Jamaica Plain second
— and **Roslindale drops from 1st to 9th at $721 089**. Let that land before moving on: one sentence
of plain-English pushback changed the answer to the question the audience asked two minutes ago.

### Turn 5 — audit the fix
> how many rows did that throw away? and check the other neighborhoods have the same problem or not

The obvious follow-up, and the one that separates a lucky guess from an analysis. The agent
aggregates outlier counts per neighborhood and comes back with a full table: **60 of 29 178 rows, all
60 in Roslindale — 1.79 % of its homes, 0 % of every other neighborhood's**. So the cleanup was
surgical and the corruption is localized, which is exactly what you want to know before you trust the
new chart.

### Turn 6 — a model, on data you now trust
> ok good. now on the clean data, can you predict a home's value from its size and rooms? just tell me how good it gets

A `Projection` → one `DataProcessing` that splits (23 294 train / 5 824 test), fits
`LinearRegression` on `LIVING_AREA` + `BED_RMS`, and returns a one-row metrics table: **R² 0.34, MAE
$181 780**. An honest, unimpressive model — size and rooms explain about a third of price — and the
right note to end on, because it is a number nobody could have trusted before turn 4. No sklearn
*operators* are involved: the model is Python inside the third family, and the Python step is **last
in its branch**, because nothing native can follow an operator whose output schema only exists at
run time.

Optional extra beat, if the room is enjoying itself: *"what if we'd used the median instead?"* —
`Aggregate` has no median, so the honest answer is that this dataflow cannot compute one without
Python. The distribution plus the filter is how you get there with relational operators, which is
precisely what turns 3–4 did.

## 4. Replaying without the UI

```bash
cd agent-service
bun run benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/boston-housing.json
# env: PROBE_MODEL (default claude-haiku-4.5), DEMO_CUID (39), DEMO_USER / DEMO_PASSWORD
```

Creates its own workflow and agent, sends each turn through `POST /api/agents/:id/message`, prints
the DAG and every operator's results per turn, and writes `boston-housing.log.json`. The workflow
and agent are kept so the session can be opened in the UI afterwards.

---

## 5. Things to know

- **Turns 2–3 are the pitch.** Two minutes only? A chart, one sentence of disbelief, an audited
  chart — no rebuilding, no re-prompting.
- **`Scatterplot` has no colour-by-category.** On turn 4 the agent's prose may claim "blue dots"
  and "orange dots"; the chart is one colour. Ask for `hoverName = CITY` if you want per-point
  labels, or run two `Filter` → `Scatterplot` branches side by side.
- **The agent argues with itself sometimes.** Turn 4's answer opened with "yes, it's definitely
  bigger houses" and then, reading its own scatter, concluded the opposite in the next sentence.
  Worth pointing at rather than hiding: the chart is the check on the narration.
- **The agent may rebuild rather than edit.** On a correction it sometimes adds a fresh
  aggregate → filter → sort → chart chain and deletes the old chart instead of editing in place.
  Same result, old version one click away in the snapshot rail — just don't promise "it edits in
  place" before you see it.
- **Derived columns cannot be charted under this allowlist.** "Price per square foot by
  neighborhood" needs arithmetic on a column, which only `DataProcessing` can do — and nothing
  native (charts included) may sit downstream of it. If someone asks live, either keep it
  relational or accept the Python step's table as the answer. Enabling `PythonUDFV2` in the
  **Operators** tab lifts the limit, since it declares its output columns.
- **`Aggregate` has no median** — only sum / count / average / min / max / concat. That is why
  turn 5 asks for a histogram instead of a median, and it is a real limitation to name if the room
  asks how you would separate a rich pocket from a rich neighborhood.
- **Time travel is still available**, even though the script no longer spends a turn on it: any
  pill in the rail restores that version of the canvas and the next message branches from it. Good
  improvised ending — jump back to the turn-2 chart and take a question from the room.
- **Agents live in memory.** Any agent-service restart (including an edit under
  `agent-service/src`, which runs under `bun --watch`) deletes every agent; the workflow keeps only
  its final DAG.
- **Rebuilding the demo cut** is one command — every filter and both demo edits live in
  [`prepare-boston-demo.py`](../agent-service/benchmark/e2e/demo/prepare-boston-demo.py):
  ```bash
  curl -o fy2026.csv <the fiscal-year CSV from data.boston.gov/dataset/property-assessment>
  python3 agent-service/benchmark/e2e/demo/prepare-boston-demo.py fy2026.csv boston_single_family_fy2026_demo.csv
  ```
  It prints the neighborhood table so you can see what the demo will show, then upload the file as
  a new version of `boston-housing-demo`. `TARGET_CITY` and `SCALE` at the top of the script are
  the knobs; if you retarget a different neighborhood, pick one whose house sizes match a cheaper
  neighbor, or turn 4 loses its punch.
