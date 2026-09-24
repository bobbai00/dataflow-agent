/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Update-by-reassignment and Rollback-by-restore on a real LongDS session
 * (world_university_rankings task 2), driven through the dataflow tool with no
 * model in the loop. The statements reuse the cleaning and distance code the
 * agent itself wrote in trial 8; only the state gestures differ:
 *
 *   task 1 (≈ LongDS turns 1-3)  build a base table `universities` (all 800
 *                                2016 universities) and `correlations` on it
 *   task 2 (≈ turn 5, Update)    REASSIGN `universities` to the outlier-cleaned
 *                                set; `correlations` recomputes on its own
 *   task 3 (≈ turn 7, Rollback)  RESTORE `correlations` as saved at task 1,
 *                                then compare before/after against gold
 *
 *   bun run benchmark/multiturn/restore-demo.ts [out-dir]
 */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";

const out = resolve(process.argv[2] ?? "/tmp/texera-task-history/restore-demo");
mkdirSync(out, { recursive: true });
const DATA = "data/longds/education/world_university_rankings/task2/data/world-university-rankings/timesData.csv";

const session = await nativeTestSession({
  nativeTaskHistory: true,
  nativeTaskContext: true,
  nativeTaskRestore: true,
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  maxOperatorResultCharLimit: 4000,
});
let count = 0;
const run = async (args: any) => {
  const result: any = await session.debug(args);
  await Bun.write(`${out}/${++count}.json`, JSON.stringify(result, null, 2));
  const errors = (result.step?.toolResults?.[0]?.output?.operators ?? []).filter((op: any) => op.status === "error");
  assert.equal(errors.length, 0, `statement errors: ${JSON.stringify(errors).slice(0, 800)}`);
  return result;
};
const rows = (result: any, id: string) => result.snapshot.results[id]?.sampleRecords ?? [];
const total = (result: any, id: string) => result.snapshot.results[id]?.totalRowCount;

// The agent's trial-8 code, unchanged except for layout: numeric fields, the
// THE-formula fill, and pairwise-complete Mahalanobis distances.
const NUMERIC = String.raw`
def clean_scores(row):
    def number(value):
        if value is None or value == "" or value == "-":
            return None
        try:
            return float(value.replace(",", "").replace("%", ""))
        except (ValueError, AttributeError):
            return None
    values = {k: number(row[k]) for k in ["teaching", "research", "citations", "international", "income", "total_score"]}
    parts = [values["teaching"], values["research"], values["citations"], values["international"], values["income"]]
    formula = None if any(v is None for v in parts) else parts[0] * 0.3 + parts[1] * 0.3 + parts[2] * 0.3 + parts[3] * 0.075 + parts[4] * 0.025
    filled = values["total_score"] if values["total_score"] is not None else formula
    return {"university_name": row["university_name"], **values, "total_score_filled": filled}
def build_numeric(raw, filled):
    import numpy as np
    import pandas as pd
    cols = ["teaching", "international", "research", "citations", "income", "total_score_filled", "num_students", "student_staff_ratio", "international_students", "female_male_ratio"]
    def num(x):
        if x is None:
            return np.nan
        s = str(x).strip()
        if s in ("", "-"):
            return np.nan
        try:
            return float(s.replace(",", "").rstrip("%"))
        except Exception:
            return np.nan
    rows = []
    for i, r in raw.iterrows():
        f = filled.iloc[i]
        fm = r.get("female_male_ratio")
        try:
            female = np.nan if fm is None or str(fm).strip() in ("", "-") else float(str(fm).split(":")[0].strip())
        except Exception:
            female = np.nan
        vals = {c: num(f.get(c)) for c in ["teaching", "international", "research", "citations", "income", "total_score_filled"]}
        vals.update({"num_students": num(r.get("num_students")), "student_staff_ratio": num(r.get("student_staff_ratio")),
                     "international_students": num(r.get("international_students")), "female_male_ratio": female,
                     "university_name": r.get("university_name")})
        rows.append(vals)
    out = pd.DataFrame(rows)
    X = out[cols]
    means = X.mean(axis=0, skipna=True)
    inv = np.linalg.pinv(X.cov(min_periods=2).fillna(0).to_numpy(dtype=float))
    d2 = []
    for _, row in X.iterrows():
        if row.isna().any():
            d2.append(np.nan)
        else:
            d = row.to_numpy(dtype=float) - means.to_numpy(dtype=float)
            d2.append(float(d @ inv @ d))
    out["mahalanobis_squared"] = d2
    return out[["university_name"] + cols + ["mahalanobis_squared"]]
def pair_correlations(t):
    import itertools
    import pandas as pd
    cols = ["teaching", "international", "research", "citations", "income", "total_score_filled", "num_students", "student_staff_ratio", "international_students", "female_male_ratio"]
    rows = []
    for a, b in itertools.combinations(cols, 2):
        pair = t[[a, b]].dropna()
        r = float(pair[a].corr(pair[b]))
        rows.append({"var_a": a, "var_b": b, "corr": r, "abs_corr": abs(r), "n": len(pair)})
    return pd.DataFrame(rows).sort_values(["abs_corr", "var_a", "var_b"], ascending=[False, True, True]).reset_index(drop=True)
times_raw = scan("${DATA}", all_text=True)
times_2016_raw = filter(times_raw, lambda row: row["year"] == "2016", doc="Keeps only 2016 records")
times_2016_filled = map(times_2016_raw, clean_scores, doc="Parses the score fields and fills a missing total score with the THE formula")
numeric = process(times_2016_raw, times_2016_filled, fn=build_numeric, doc="The ten numeric ranking variables per university, with squared Mahalanobis distance")`;

try {
  await session.debug("Task 1: build the analysis base and its correlations.");
  const t1 = await run({
    edits:
      NUMERIC +
      `
universities = filter(numeric, lambda row: True, doc="The analysis base: every 2016 university")
correlations = process(universities, fn=pair_correlations, doc="Pairwise-complete Pearson correlations of the ten variables, strongest first")`,
    observe: ["correlations"],
  });
  assert.equal(total(t1, "universities"), 800);
  const before1 = rows(t1, "correlations").slice(0, 5);

  // Update: the base itself changes, and everything built on it follows.
  await session.debug("Task 2 (Update): from now on the analysis uses the outlier-cleaned universities.");
  const t2 = await run({
    edits: `universities = filter(numeric, lambda row: (row["mahalanobis_squared"] is None or row["mahalanobis_squared"] < 25) and row["num_students"] is not None and row["female_male_ratio"] is not None and row["num_students"] < 90000 and row["female_male_ratio"] > 5, doc="The analysis base: universities left after multivariate and univariate outlier removal")`,
    observe: ["correlations"],
  });
  assert.equal(total(t2, "universities"), 721); // gold turn 5: 721 after cleaning
  const receipt2 = t2.step.toolResults[0].output.operators.map((op: any) => `${op.status} ${op.id}`);

  // Rollback: the correlations as they were before the Update, next to the current ones.
  await session.debug("Task 3 (Rollback): compare the strongest pre-cleaning correlations with the cleaned ones.");
  const t3 = await run({
    restore: [{ operator: "correlations", task: 1, as: "correlations_before" }],
    edits: String.raw`
def compare_top5(before, after):
    import pandas as pd
    top = before.head(5)
    merged = top.merge(after[["var_a", "var_b", "corr"]], on=["var_a", "var_b"], suffixes=("_before", "_after"))
    merged["abs_change"] = (merged["corr_after"] - merged["corr_before"]).abs()
    return merged[["var_a", "var_b", "corr_before", "corr_after", "abs_change"]]
correlation_change = process(correlations_before, correlations, fn=compare_top5, doc="The five strongest pre-cleaning pairs with their correlation before and after outlier removal")`,
    observe: ["correlation_change"],
  });
  const receipt3 = t3.step.toolResults[0].output.operators.map((op: any) => `${op.status} ${op.id}: ${op.message}`);
  const change = rows(t3, "correlation_change");
  const gold = (
    (await Bun.file(
      resolve(import.meta.dir, "../../../benchmark/longds/prepared/education__world_university_rankings__task2/gold.json")
    ).json()) as any
  ).turns.find((t: any) => t.turn_id === 7).answer.top5_pairs_correlation_change;
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const agree = gold.every((g: any, i: number) => r4(change[i]?.corr_before) === g.corr_before && r4(change[i]?.corr_after) === g.corr_after);

  console.log("=== task 1: base = 800 universities; strongest correlations");
  for (const r of before1) console.log(`  ${r.var_a} / ${r.var_b}: ${r4(r.corr)}`);
  console.log("=== task 2 (Update by reassignment): receipt");
  console.log("  " + receipt2.join("\n  "));
  console.log(`  universities now ${total(t2, "universities")} rows; correlations recomputed without being mentioned`);
  console.log("=== task 3 (Rollback by restore): receipt");
  console.log("  " + receipt3.join("\n  "));
  const note = /restored from task 1: [^\\\n]*/.exec(t3.serviceContext)?.[0];
  console.log(`  verification: ${note}`);
  console.log("=== correlation change vs gold (turn 7)");
  for (let i = 0; i < gold.length; i++)
    console.log(
      `  ${change[i]?.var_a} / ${change[i]?.var_b}: before ${r4(change[i]?.corr_before)} (gold ${gold[i].corr_before}), after ${r4(change[i]?.corr_after)} (gold ${gold[i].corr_after})`
    );
  console.log(`  matches gold: ${agree}`);
  const entries = t3.serviceContext.slice(t3.serviceContext.indexOf("## Task 1"), t3.serviceContext.indexOf("# Tables now") + 400);
  await Bun.write(`${out}/entries.txt`, entries);
  console.log(`=== entries the model would read at task 3: ${out}/entries.txt`);
} finally {
  await session.close?.();
}
