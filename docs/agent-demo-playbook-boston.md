# Agent demo playbook — Boston house values

One dataset, six turns, told the way somebody actually works: **look at the data first**, ask for
a chart, push back when the chart lies, refine it, follow the next question — and only at the end
ask for a model. The prompts below are meant to be typed as written: lowercase, half-finished, no
spec language. That scruffiness is part of what is being demonstrated.

| Beat | Turn | What the audience sees |
|---|---|---|
| **Understand the data** | 1 | "whats actually in this file?" → 29 681 homes × 23 columns, described back, no chart |
| Ask for a chart | 2 | Neighborhood prices — `Aggregate` → `Sort` → `BarChart` |
| **Feedback** | 3 | "that's misleading, some barely have any houses" → count + filter + re-sort |
| Follow the question | 4 | "does size drive price?" → scatter of living area vs value |
| **Revision** | 5 | "the mansions are squashing everything" → cap at 4 000 sqft |
| A model, as a coda | 6 | One `DataProcessing` trains a regression and says how good it gets |

ETL and charts carry the demo; the model is the last two minutes, not the point. Three operator
families, one job each, used in that order — **relational** for the ETL, **visualization** for the
charts, **`DataProcessing`** for the model — which is exactly what the general-mode system prompt
tells the agent ([`agent-service/src/agent/prompts.ts`](../agent-service/src/agent/prompts.ts)).

> **Verification status (2026-08-31).** Turns 1–2 verified end to end with `claude-haiku-4.5`
> (29 681 × 23 description; BOSTON $1.94 M at the top of the bar chart). Turn 3 onwards is
> **not yet re-verified**: the last run died when the machine's LAN IP changed mid-run, which
> breaks every Iceberg result write (see §2, last bullet). The five-turn ML-centric predecessor of
> this script was verified four times; the operators used here are the same families. Re-run
> `demo-driver.ts` after a `down`/`up --skip-build` to confirm before presenting.

Replaces the older two-demo playbooks ([full](agent-demo-playbook.md),
[simple](agent-demo-playbook-simple.md)).

---

## 1. The dataset

**City of Boston FY2026 Property Assessment** — the city's own assessed-value roll, revision
dated **2026-05-22**, from <https://data.boston.gov/dataset/property-assessment> (the FY2026 CSV
is the most recent of the yearly files; 184 552 parcels, 76 MB).

Deliberately *not* the 1970s "Boston Housing" toy set from StatLib: that one is 506 rows, half a
century old, and carries the well-known racially-derived `B` column — scikit-learn removed it in
1.2 for exactly that reason.

Loaded into Texera as dataset **`boston-housing`**, version `v1`, file
`boston_single_family_fy2026.csv` — path
`/agent-demo@texera.dev/boston-housing/v1/boston_single_family_fy2026.csv`.

Prepared from the raw city file by: keeping land-use `R1` (single-family dwelling), dropping the
725 homes assessed over $3 M (a tail reaching $30.6 M that otherwise swamps every average),
dropping 35 rows with missing numerics, removing `YR_REMODEL` (blank for 55 % of homes), and
stripping thousands separators so the numeric columns arrive as numbers. Result: **29 681 rows ×
23 columns**, median assessed value **$695 900**.

| Group | Columns |
|---|---|
| Identity / location | `PID`, `CITY`, `ZIP_CODE` |
| Size | `LAND_SF`, `GROSS_AREA`, `LIVING_AREA` |
| Rooms | `BED_RMS`, `FULL_BTH`, `HLF_BTH`, `TT_RMS`, `KITCHENS` |
| Extras / age | `YR_BUILT`, `FIREPLACES`, `NUM_PARKING`, `HEAT_TYPE`, `AC_TYPE`, `OWN_OCC` |
| Condition (graded strings) | `OVERALL_COND`, `INT_COND`, `EXT_COND` |
| Values | `LAND_VALUE`, `BLDG_VALUE`, **`TOTAL_VALUE`** |

Two things worth knowing before you present:

- `CITY` is really the **neighborhood** (Dorchester, Brighton, Jamaica Plain…), and the value
  `BOSTON` means the downtown core — which is why it tops every price ranking.
- `TOTAL_VALUE = LAND_VALUE + BLDG_VALUE`, exactly, for all 29 681 rows. Keep that in your back
  pocket for turn 6.

---

## 2. Setup

```bash
bin/local-dev.sh up --skip-build     # expect "14 of 14 services running"
```

- UI <http://localhost:4200>, login **`agent-demo` / `agent-demo-2026`**, computing unit
  **`agent-demo-cu`**.
- Open a new workflow → robot button (bottom-right) → **+ Agent** → **Claude Haiku 4.5** →
  **Create Agent** (name defaults to **Bob**; mode is already **General**, parallel tool calls on).
- **No operator setup needed.** The default allowlist is exactly what this demo uses: basic
  relational operators (`CSVFileScan`, `Filter`, `Projection`, `HashJoin`, `Aggregate`, `Sort`,
  `Limit`, `Union`, `Distinct`, `Intersect`, `Difference`, `TypeCasting`, `KeywordSearch`), the
  common charts (`BarChart`, `LineChart`, `PieChart`, `Histogram`, `Scatterplot`, `HeatMap`,
  `BoxViolinPlot`, `WordCloud`) and `DataProcessing` for custom Python. No sklearn or `Split`
  operators — turn 6's model is trained inside `DataProcessing`.
- **Check the LAN IP before every session.** The MinIO endpoint is the host's LAN IP, baked into
  every JVM and into the Lakekeeper warehouse at startup. If the machine changed networks since
  the stack came up, executions hang ~30 s and fail while everything still reports "running".
  Check and fix:
  ```bash
  ipconfig getifaddr en0                                    # current IP
  curl -s localhost:8181/management/v1/warehouse | grep -o 'http://[0-9.]*:9000'   # baked IP
  bin/local-dev.sh down && bin/local-dev.sh up --skip-build  # if they differ (volumes are kept)
  ```

Left rail = **Dataflow Snapshots**: one pill per action-bearing step, oldest at the top,
timestamps on their own axis, active snapshot filled blue. Clicking a pill checks that version
out and the next message branches from it. (Pill `S1` is the agent's empty bootstrap snapshot, so
turn *n* is pill `S(n+1)`.)

---

## 3. The six turns

### Turn 1 — look before you leap
> whats actually in this file? /agent-demo@texera.dev/boston-housing/v1/boston_single_family_fy2026.csv

One `CSVFileScan`, and the answer is a *description*, not a chart: **29 681 rows × 23 columns**,
every column with its type and sample values. This is the turn most demos skip and every real
analyst starts with — nobody knows what to ask until they have seen the table.

### Turn 2 — the first real ask
> ok cool. which neighborhoods are the expensive ones? bar chart pls

`Aggregate` (average `TOTAL_VALUE` by `CITY`) → `Sort` → `BarChart`. Top of the chart: **BOSTON
$1.94 M**, Charlestown $1.43 M, Jamaica Plain $1.19 M, South Boston $1.02 M. The agent chose the
columns and the aggregation itself out of "expensive" and "neighborhoods" — nobody typed
`TOTAL_VALUE`.

### Turn 3 — feedback: the chart is lying ← *the point of the demo*
> hmm that's a bit misleading, a couple of those barely have any houses in them. drop anything with fewer than 200 homes and sort it high to low

Send it from the chart operator's own panel — the blue chat icon on the operator, which shows its
result rows and a feedback box — so the correction is attached to the thing that is wrong.

The agent adds a **count** to the aggregation, a `Filter` on it, and re-sorts. The thin
neighborhoods (Chestnut Hill has 122 homes, Dedham a handful) drop out and the ranking changes
shape: the same question, honestly answered, from one sentence of pushback in plain English.

### Turn 4 — follow the next question
> does size actually drive the price here? plot living area against value

A `Scatterplot` of `LIVING_AREA` against `TOTAL_VALUE`. The cloud answers immediately: clearly
positive, and very wide — size explains a lot but nowhere near everything, which is what turn 6
puts a number on.

### Turn 5 — revision: make the picture readable
> the mansions are squashing everything, cut it off at 4000 sqft

A `Filter` on `LIVING_AREA` feeding the scatter. The bulk of the market fills the frame and the
relationship becomes legible. Worth pointing out: the neighborhood chart from turns 2–3 is
untouched — the edit landed on one branch, not on the whole workflow.

### Turn 6 — a model, as a coda
> last thing - can you predict a home's value from its features? just tell me how good it gets

A `Projection` (numeric columns) → a `DataProcessing` whose `def process(features)` imports
sklearn, splits (≈ 23 700 train / 5 900 test), fits `LinearRegression`, and returns a one-row
metrics table. No sklearn *operators* are involved: the whole model is Python, which is what the
prompt's third family exists for. The Python step is **last in its branch** — nothing native can
follow it, because its output schema only exists at run time.

**If R² comes back at ~1.0**, the agent kept `LAND_VALUE` and `BLDG_VALUE` as features and is
reading the answer off the table. That is a gift, not a bug — say *"that's too good to be true,
those two add up to the target, drop them and retrain"* and it returns around **R² ≈ 0.5,
MAE ≈ $180 k**: half the variance explained, off by $180 k on a $696 k median. An honest model,
and a third feedback beat for free.

---

## 4. Replaying without the UI

```bash
cd agent-service
bun run benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/boston-housing.json
# env: PROBE_MODEL (default claude-haiku-4.5), DEMO_CUID (39), DEMO_USER / DEMO_PASSWORD
```

Creates its own workflow and agent, sends each turn through `POST /api/agents/:id/message`,
prints the DAG and every operator's results per turn, and writes `boston-housing.log.json`. The
workflow and agent are kept so the session can be opened in the UI afterwards.

---

## 5. Things to know

- **Turn 3 is the pitch.** Two minutes only? Do turns 2 and 3: a chart, a sentence of pushback in
  plain English, a corrected chart — no rebuilding, no re-prompting.
- **The agent may rebuild rather than edit.** On turn 3 it sometimes adds a fresh
  aggregate → filter → sort → chart chain and deletes the old chart instead of editing the
  existing operators in place. The result is the same and the old version is one click away in the
  snapshot rail; just don't promise "it edits in place" before you see it.
- **Derived columns cannot be charted under this allowlist.** "Price per square foot by
  neighborhood" needs arithmetic on a column, which only `DataProcessing` can do — and nothing
  native (charts included) may sit downstream of it. If someone asks live, either keep it
  relational or accept the Python step's table as the answer. Enabling `PythonUDFV2` in the
  **Operators** tab lifts the limit, since it declares its output columns.
- **`Aggregate` has no median** — only sum / count / average / min / max / concat. Ask for
  averages; the $3 M cap in the dataset already keeps them honest.
- **Time travel is still available**, even though the script no longer scripts it: any pill in the
  rail restores that version of the canvas and the next message branches from it. Good improvised
  ending — jump back to the turn-2 chart and take a question from the room.
- **Agents live in memory.** Any agent-service restart (including an edit under
  `agent-service/src`, which runs under `bun --watch`) deletes every agent; the workflow keeps
  only its final DAG.
- **Refreshing the data**: re-run the extract against a newer fiscal-year CSV from
  <https://data.boston.gov/dataset/property-assessment> (`LU == "R1"`, cap the value tail, drop
  `YR_REMODEL`, strip thousands separators), then upload it as a new version of the
  `boston-housing` dataset.
