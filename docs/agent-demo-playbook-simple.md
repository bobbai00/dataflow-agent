# Agent demo playbook — simple edition

> **Superseded.** The current single-domain demo is
> [agent-demo-playbook-boston.md](agent-demo-playbook-boston.md) (Boston FY2026 house
> values: feedback, time travel, one ML model, five turns). This file is kept for the
> Northwind / Titanic scenarios it documents.

Trimmed version of [agent-demo-playbook.md](agent-demo-playbook.md), built to three rules:
**every prompt is at most two sentences**, **six or seven turns per demo**, and demo B exists
to show *why* you need to go back to an earlier version. Both demos were run end to end on
2026-08-31 with `claude-haiku-4.5` in **general mode** (since renamed **code mode**; agent **Bob**, workflows 289 and 291).

| | A — Northwind revenue views | B — Titanic, going back in time |
|---|---|---|
| Turns | 6 (79 s of agent time) | 7 including one checkout (133 s) |
| Shape | 2 scans → join → revenue UDF → **fan-out into 3 chart branches** | scan → chart; features → Split → logistic regression → Scorer |
| Operators | 12 | 10 |
| Shows | typed operators, one Python UDF per derived column, wide DAG, three charts | an ML pipeline, a **destructive** edit, **checkout** to undo it, then a branch |
| Punchline | a small dashboard from five short asks | history is a safety net, not a log |
| Verified run | workflow 289 | workflow 291 |

Scripted for replay in [`agent-service/benchmark/e2e/demo/`](../agent-service/benchmark/e2e/demo/)
(`northwind-simple.json`, `titanic-simple.json`).

---

## 1. Setup

Full provisioning details are in the [main playbook](agent-demo-playbook.md#1-one-time-setup);
the short version:

```bash
bin/local-dev.sh up --skip-build    # expect "14 of 14 services running"
```

- UI <http://localhost:4200>, login **`agent-demo` / `agent-demo-2026`**, computing unit
  **`agent-demo-cu`**.
- Datasets already uploaded: `/agent-demo@texera.dev/northwind/v1/*.csv` and
  `/agent-demo@texera.dev/titanic/v1/titanic.csv`.
- Open a fresh workflow → robot button → **+ Agent** → **Claude Haiku 4.5** → **Create Agent**
  (name defaults to **Bob**; mode is already **General** with parallel tool calls on).
- Demo B only: **Operators** tab → also enable `Split`,
  `SklearnTrainingLogisticRegression`, `SklearnPrediction`, `Scorer`.
- After a network change or reboot, run `bin/local-dev.sh down && bin/local-dev.sh up --skip-build`
  first — the MinIO endpoint is the host LAN IP and it gets baked into every JVM.

The left rail is **Dataflow Snapshots**: one pill per action-bearing step, newest at the bottom,
active snapshot filled blue. Clicking a pill is a checkout, and the next message branches from it.

---

## 2. Demo A — Northwind revenue views (6 turns)

Each turn is one small ask, so the audience sees the DAG grow one operator at a time.

**Turn 1** (18 s)
> Load /agent-demo@texera.dev/northwind/v1/orders.csv and /agent-demo@texera.dev/northwind/v1/order_details.csv, then join them on orderID.

Two `CSVFileScan`s (809 and 2 155 rows) into a `HashJoin` on orderID, 2 082 rows out.

**Turn 2** (17 s)
> Add a revenue column = unitPrice * quantity * (1 - discount).

One `PythonUDFV2` that declares `revenue: double`, which is what lets the native operators
downstream read it.

**Turn 3** (10 s)
> Show revenue by shipCountry as a bar chart.

`Aggregate` (21 countries) → `BarChart`; USA $243.6k, Germany $227.8k, Austria $118.1k.

**Turn 4** (10 s)
> Add a second view: revenue by employeeID as a pie chart.

A second branch off the same UDF — 9 employees, employee 4 highest at $225.8k. The DAG starts
getting wide rather than long.

**Turn 5** (20 s)
> Add a third view: revenue by month of orderDate as a line chart.

A third branch: `PythonUDFV2` for `order_month` → `Aggregate` → `Sort` → `LineChart`, 23 months.

**Turn 6** (4 s)
> Which country and which month earn the most?

No tool calls at all — the agent answers from the results it already has: USA, and April 1998 at
$110.5k.

```
op1 CSVFileScan orders ─┐                                    ┌─► op5 Aggregate(shipCountry) ─► op6  BarChart
                        ├─► op3 HashJoin ─► op4 PythonUDFV2 ──┼─► op7 Aggregate(employeeID) ─► op8  PieChart
op2 CSVFileScan details ┘      (orderID)      (+revenue)      └─► op9 PythonUDFV2(+order_month)
                                                                   └─► op10 Aggregate ─► op11 Sort ─► op12 LineChart
```

---

## 3. Demo B — Titanic, going back in time (7 turns)

The story: a good model, one experiment that makes things worse **and deletes work**, then
checkout as the only way back.

**Turn 1** (15 s)
> Load /agent-demo@texera.dev/titanic/v1/titanic.csv and show survival rate by passenger class as a bar chart.

`CSVFileScan` → `Aggregate` → `BarChart`: class 1 62.6 %, class 2 47.3 %, class 3 24.3 %.

**Turn 2** (17 s)
> Build a numeric feature table: encode Sex as sex_num, then keep only Survived, Pclass, sex_num, Age, SibSp, Parch and Fare. Drop rows with a missing Age.

`PythonUDFV2` → `Filter` → `Projection`, 891 → 714 rows.

**Turn 3** (18 s) — the version worth keeping
> Train a logistic regression on an 80/20 split with seed 1 and score it.

`Split` → `SklearnTrainingLogisticRegression` → `SklearnPrediction` → `Scorer`, **86.2 %**
accuracy. Point at this snapshot pill in the rail — it is the one we come back to.

**Turn 4** (25 s) — the mistake
> Let's simplify the features: keep only Survived, Age and Fare. Retrain and score.

Accuracy collapses to **58.7 %**, and the agent got there by *deleting* five operators — the
class bar chart and the whole scored pipeline are gone from the canvas.

**Turn 5** — the recovery
Click the turn-3 pill. The 7-feature pipeline, the bar chart and the 86.2 % Scorer all come
back; nothing had to be rebuilt or re-prompted.

**Turn 6** (52 s) — branch instead
> Keep the logistic regression, but fill missing Age with 28 instead of dropping those rows.

The `Filter` becomes an imputing `PythonUDFV2`, so all 891 passengers survive into the split;
accuracy **83.4 %**. The tree now forks at turn 3: one child is the failed experiment, one is this.

**Turn 7** (6 s)
> Did keeping those passengers help? Compare with the previous accuracy.

The agent compares 86.2 % against 83.4 % and says no. Click between the two leaf pills to flip
the canvas and the Scorer table between the two answers.

```
op1 CSVFileScan ─┬─► op2 Aggregate(Pclass) ─► op3 BarChart
                 └─► op4 UDF(sex_num) ─► op5 Filter(Age) ─► op6 Projection ─► op7 Split ─┬─► op8 LogisticRegression ─┐
                                            (turn 6: UDF fill 28)                        └──────────────────────────┴─► op9 Prediction ─► op10 Scorer
```

---

## 4. Replaying without the UI

```bash
cd agent-service
bun run benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/northwind-simple.json
bun run benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/titanic-simple.json
# env: PROBE_MODEL (default claude-haiku-4.5), DEMO_CUID (39), DEMO_USER / DEMO_PASSWORD
```

Each run creates its own workflow and agent, prints the DAG plus operator results per turn,
writes `<scenario>.log.json`, and keeps everything so you can open the session in the UI.

---

## 5. Things to know

- **Quote shapes, not decimals.** Accuracy moves between runs (the same demo-B turn 3 scored
  79.7 % and 86.2 % on two runs, because the agent orders `Filter`/`Projection` differently);
  the row counts and the direction of every comparison were stable.
- **Turn 4 of demo B may branch instead of delete.** If the agent adds a parallel chain rather
  than deleting the old one, the checkout beat still lands — say "let's drop this experiment and
  go back" instead of "recover the deleted operators".
- **Agents live in memory.** Any agent-service restart (including an edit under
  `agent-service/src`, which runs `bun --watch`) deletes every agent; the workflow keeps only its
  final DAG, so rebuild live with the prompts above.
- **Short prompts are the point.** The operator know-how lives in the agent's system prompt —
  if a run goes all-Python, add "use native operators" and keep it to one sentence.
- Demo A needs no allowlist change; demo B needs the four sklearn operators, which also switches
  on the ML section of the system prompt.
