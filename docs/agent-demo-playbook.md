# Agent demo playbook

> **Superseded.** The current single-domain demo is
> [agent-demo-playbook-boston.md](agent-demo-playbook-boston.md) (Boston FY2026 house
> values: feedback, time travel, one ML model, five turns). This file is kept for the
> Northwind / Titanic scenarios it documents.

Two ready-to-run demos of the dataflow agent (**Bob**), exercised end-to-end
on 2026-08-29 against the local stack with `claude-haiku-4.5` in **general mode** (since renamed **code mode**) (typed/native operators; Python only for computed columns). Prompts are
short, the way a user would type them — the operator know-how lives in the
agent's system prompt.

| | Short — Northwind revenue views | Long — Titanic survival |
|---|---|---|
| Shape | 2 scans → join → UDF → **fan-out into 3 (then 4) aggregate→chart branches** | scan → 2 aggregates + chart; UDF → Projection → Filter → Histogram; Split → trainer/predictor → Scorer |
| Operators | 10 (12 after the branch turn) | 12 per model version |
| Families shown | relational (join, 3–4 aggregates), Python UDF, bar/pie/line charts | relational, 2 charts, 2 UDFs, sklearn ML (Split / trainer / prediction / Scorer) |
| Versioning | build → add a 4th view → **checkout** the 3-view snapshot → branch: swap the pie chart | features snapshot → LR → **checkout** → RandomForest branch → imputation variant, compare Scorer tables |
| Agent turns | 3 + 1 checkout (≈ 45 s / 11 s / 15 s) | 5 + 1 checkout (≈ 18–40 s each, last one ≈ 85 s) |
| Saved run | workflow 274 | workflow 273 |

Scripted for replay in [`agent-service/benchmark/e2e/demo/`](../agent-service/benchmark/e2e/demo/)
(`demo-driver.ts`, `northwind-wide.json`, `titanic.json`).

---

## 1. One-time setup

### Stack
```bash
bin/local-dev.sh up --skip-build     # 14 services; docker volumes are reused
bin/local-dev.sh status              # expect "14 of 14 services running"
```
UI: <http://localhost:4200>. After a network change or reboot do a full
`bin/local-dev.sh down && bin/local-dev.sh up --skip-build` (the MinIO endpoint
= host LAN IP is baked into the Lakekeeper warehouse and every JVM).

### Demo account and data
- Login **`agent-demo` / `agent-demo-2026`** (admin: `texera` / `texera`).
- Computing unit **`agent-demo-cu`** (auto-selected when a workflow opens).
- Datasets (owner `agent-demo@texera.dev`, version `v1`):

| Dataset | File(s) | Source |
|---|---|---|
| `northwind` | `orders.csv` (809 rows), `order_details.csv` (2 155 rows) + products/categories/customers/employees/shippers | Kaggle Northwind Traders |
| `titanic` | `titanic.csv` (891 × 12) | Kaggle Titanic |
| `telco` | `Telco-Customer-Churn.csv` (7 043 × 21) | Kaggle Telco Customer Churn (spare) |

Dataset paths look like `/agent-demo@texera.dev/northwind/v1/orders.csv`; the
agent loads them with `CSVFileScan`.

### Agent panel
1. Open a workflow (a new empty one is best for a live demo).
2. Robot button (bottom-right) → **+ Agent** → **Claude Haiku 4.5** → name
   (default **Bob**) → **Create Agent**.
3. Defaults are already **Agent Mode = General** and **parallel tool calls on**
   (ⓘ System Information → **Parameters** to change; the same tab has
   **Panel Views** switches for the Next-Step Context preview and the
   User/Debug input toggle — both hidden by default).
4. Titanic only: **Operators** tab → also enable `Split`,
   `SklearnTrainingLogisticRegression`, `SklearnTrainingRandomForest`,
   `SklearnPrediction`, `Scorer` (the default allowlist has no ML operators;
   enabling them also switches on the ML guide in the agent's prompt).

Panel anatomy: left rail = **Dataflow Snapshots** — one pill per
action-bearing step, timestamps on the left axis, the active snapshot filled
blue, the active lineage outlined blue, abandoned branches dimmed. Clicking a
pill is a **checkout**: canvas + chat jump to that version, and the next
message **branches** from it. Hovering a step in the chat labels the operators
it added/modified on the canvas.

---

## 2. Short demo — Northwind revenue views (wide DAG)

### Turn 1 (≈ 45 s, 10 operators)
> Load /agent-demo@texera.dev/northwind/v1/orders.csv and /agent-demo@texera.dev/northwind/v1/order_details.csv, join them on orderID, and add a revenue column = unitPrice * quantity * (1 - discount) plus an order_month column (1-12 from orderDate). Then give me three views of revenue side by side: a bar chart by shipCountry, a pie chart by employeeID, and a line chart by order_month. Use native operators; Python only for the two computed columns.

```
op1 CSVFileScan orders ─────┐                              ┌─► op5 Aggregate(shipCountry)  ─► op8  BarChart
                            ├─► op3 HashJoin ─► op4 PythonUDFV2 ─┼─► op6 Aggregate(employeeID)  ─► op9  PieChart
op2 CSVFileScan order_details┘        (orderID)  (+revenue,     └─► op7 Aggregate(order_month) ─► op10 LineChart
                                                  +order_month)
```
Expected: join 2 082 rows; 21 countries (USA $243.6k, Germany $227.8k,
Austria $118.1k …); 9 employees (emp 4 $225.8k, emp 3 $202.8k, emp 1
$187.3k); 12 months (Jan $155.5k peak). Three Plotly charts in the result
panel. Point at: one native operator per step, fan-out from a single UDF, the
UDF declaring `revenue: double` / `order_month: integer` so native
`Aggregate`s can read them.

### Turn 2 — widen (≈ 11 s)
> Add a fourth view: average freight per shipVia as a bar chart. Keep the other three.

Adds `op11 Aggregate(avg freight by shipVia)` → `op12 BarChart` off the same
UDF. Expected: shipVia 1 $81.34, 2 $109.80, 3 $99.49.

### Turn 3 — checkout
Click the turn-1 snapshot in the tree: the fourth branch disappears from the
canvas, chat shows only turn 1.

### Turn 4 — branch (≈ 15 s)
> Replace the pie chart by employee with a bar chart of order-line count per employee.

Agent adds `Aggregate(count by employeeID)` → replaces `op9` with a
`BarChart` (emp 1 314 lines, emp 4 highest revenue). The tree now forks after
turn 1: one child has four views, the other swapped the pie for a bar. Click
between them to flip the canvas.

---

## 3. Long demo — Titanic survival (ML + three versions)

Prerequisite: ML operators enabled (setup step 4).

### Turn 1 (≈ 18 s)
> Load /agent-demo@texera.dev/titanic/v1/titanic.csv and show me the survival rate by passenger class and by sex, with a bar chart for the class breakdown.

`CSVFileScan` → `Aggregate(Pclass)` → `BarChart`, `Aggregate(Sex)`.
Expected: class 1 62.6 %, class 2 47.3 %, class 3 24.3 %; female 74.2 %, male
18.9 %.

### Turn 2 (≈ 22 s)
> Build a numeric feature table for modeling: encode Sex as sex_num (female=1) with a Python UDF, then keep only Survived, Pclass, sex_num, Age, SibSp, Parch and Fare with a Projection and drop rows with missing Age with a Filter. Also add a histogram of Age colored by Survived.

`PythonUDFV2(+sex_num)` → `Projection` → `Filter(Age not null)` →
`Histogram`. Expected 891 → 714 rows. This is the **features snapshot** all
model versions branch from.

### Turn 3 — version A (≈ 23 s)
> Train a logistic regression to predict Survived using an 80/20 split (seed 1), score it on the held-out 20% and report accuracy, precision, recall and F1.

`Split(80/20)` → port 0 → `SklearnTrainingLogisticRegression` → `model`;
port 1 + model → `SklearnPrediction` → `Scorer`. Expected accuracy ≈ **81.8 %**
(≈ 160 held-out rows; the Scorer table has an `Overall` row plus one row per
class with precision / recall / F1).

### Turn 4 — checkout
Click the features snapshot (end of turn 2). ML operators vanish; chat shows
turns 1–2.

### Turn 5 — version B (≈ 40 s)
> Same pipeline, but with a random forest instead. Does it beat the logistic regression?

Agent builds the RandomForest chain and, to answer the question, a parallel
logistic-regression chain off the same Split — two Scorers side by side.
Expected: RF ≈ **77.7 %** vs LR ≈ **79.7 %** on the identical split → "no, LR
wins". Tree forks at the features snapshot.

### Turn 6 — version C (≈ 85 s)
> Instead of dropping passengers with a missing Age, fill it with 28 in a UDF, rerun the random forest and compare with the previous version.

Agent swaps the Filter for an age-filling UDF, keeps all 891 rows, re-runs
RandomForest. Expected ≈ **78.9 %** vs 77.8 % — imputation edges out dropping
rows (say that the test set is larger now, so it is "more data kept" rather
than an identical split). This turn is the agent's longest (≈ 20 tool calls:
it tries to edit operators in place before rebuilding) — good moment to show
the step cards and the tree growing live.

### Compare across versions
Click the leaf pills for A, B and C; each click swaps canvas + chat, and the
`Scorer` result shows that version's metrics.

---

## 4. Replaying without the UI

```bash
cd agent-service
bun run benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/northwind-wide.json
bun run benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/titanic.json
# env: PROBE_MODEL (default claude-haiku-4.5), DEMO_CUID (39), DEMO_USER / DEMO_PASSWORD
```
Creates a fresh workflow + agent on the `agent-demo` account, sends each turn
through `POST /api/agents/:id/message`, performs `{ "checkout": N }` via
`POST /:id/checkout`, prints DAG + operator results after each turn, writes
`<scenario>.log.json`, and keeps the workflow/agent so the session can be
opened in the UI.

---

## 5. Things to know

- **Agents live in memory.** Any agent-service restart (including edits under
  `agent-service/src`, which runs under `bun --watch`) deletes every agent;
  saved workflows keep the final DAG only. Rebuild live with the prompts above.
- **Python vs native**: native operators cannot read `DataLoading` /
  `DataProcessing` output (schema inferred at run time). The system prompt now
  steers computed columns to `PythonUDFV2` (declared output columns) so
  charts and `Aggregate`s can follow; if a run still goes all-Python, add "use
  native operators" to the prompt as in the Northwind turn 1.
- **Multi-output ports**: `Split` port 0 = training share, port 1 = rest; the
  agent links from a non-default output port with the `"op9:1"` suffix.
- **Model behaviour** (haiku 4.5): 4–10 tool calls per turn, occasional
  `modifyOperator` retries when it passes stale properties; converges on its
  own within a turn.
- Kaggle pages: <https://www.kaggle.com/c/titanic>,
  <https://www.kaggle.com/datasets/blastchar/telco-customer-churn>, Northwind
  Traders CSVs (several Kaggle mirrors; files were pulled from the public
  GitHub mirror of the same data).
