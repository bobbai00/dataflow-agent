/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Aggregate the per-batch trace×solution analyses (Idea 1) into the corpus-wide
 * answer: the failure split (context-fixable vs task-intrinsic — the accuracy
 * ceiling of context tuning) and the cost-trim label distribution (the training
 * signal). Reads every `<batch>.json` under output/trace-analysis/ except SPEC.
 *
 * Usage: bun run benchmark/llm-training-data-generation/scripts/aggregate-trace-analysis.ts
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, "..", "output", "trace-analysis");

interface Label {
  operatorId?: string;
  currentDetail?: string;
  recommendedDetail?: string;
  category?: string;
  evidence?: string;
  confidence?: string;
}
interface StepLabel {
  stepIndex?: number;
  action?: string;
  labels?: Label[];
}
interface TaskAnalysis {
  task: string;
  success?: boolean;
  goldDataDeps?: Record<string, unknown>;
  failure?: null | { category?: string; divergenceStep?: number; what?: string; neededContext?: string; evidence?: string };
  stepLabels?: StepLabel[];
  notes?: string;
}

async function main(): Promise<void> {
  const files = (await fs.readdir(DIR)).filter(f => f.endsWith(".json") && f !== "SPEC.md" && f !== "AGGREGATE.json");
  const all: TaskAnalysis[] = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(await fs.readFile(path.join(DIR, f), "utf-8"));
      if (Array.isArray(arr)) all.push(...arr);
      else all.push(arr);
    } catch (e) {
      console.error(`skip ${f}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`aggregated ${all.length} task analyses from ${files.length} batch file(s)\n`);

  const correct = all.filter(t => t.success);
  const failed = all.filter(t => t.success === false);
  console.log(`=== OUTCOMES: ${correct.length} correct, ${failed.length} failed (of ${all.length}) ===\n`);

  // Failure split — the accuracy-ceiling question.
  const ctxFix = failed.filter(t => t.failure?.category === "context-fixable");
  const intrinsic = failed.filter(t => t.failure?.category && t.failure.category !== "context-fixable");
  const unclassified = failed.filter(t => !t.failure?.category);
  console.log(`=== FAILURE SPLIT (can context tuning ever flip a fail→pass?) ===`);
  console.log(`  context-fixable : ${ctxFix.length}  ${ctxFix.map(t => t.task).join(", ")}`);
  for (const t of ctxFix) console.log(`     - ${t.task}: step ${t.failure?.divergenceStep} — ${t.failure?.neededContext}`);
  console.log(`  task-intrinsic  : ${intrinsic.length}  ${intrinsic.map(t => t.task).join(", ")}`);
  if (unclassified.length) console.log(`  unclassified    : ${unclassified.length}  ${unclassified.map(t => t.task).join(", ")}`);
  console.log();

  // Cost-trim label distribution — the training signal.
  const trims: Label[] = [];
  const acc: Array<{ task: string } & Label> = [];
  let totalLabels = 0;
  for (const t of all) {
    for (const sl of t.stepLabels ?? []) {
      for (const l of sl.labels ?? []) {
        totalLabels++;
        if (l.category === "cost-trim") trims.push(l);
        else if (l.category === "accuracy-critical") acc.push({ task: t.task, ...l });
      }
    }
  }
  console.log(`=== COST-TRIM LABELS: ${trims.length} (of ${totalLabels} total labels) ===`);
  const transition = new Map<string, number>();
  for (const l of trims) {
    const k = `${l.currentDetail ?? "?"} → ${l.recommendedDetail ?? "?"}`;
    transition.set(k, (transition.get(k) ?? 0) + 1);
  }
  console.log(`  most common current→recommended detail transitions:`);
  for (const [k, n] of [...transition.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`    ${String(n).padStart(3)}  ${k}`);
  }
  console.log();

  console.log(`=== ACCURACY-CRITICAL LABELS: ${acc.length} ===`);
  for (const a of acc) console.log(`  - ${a.task} op=${a.operatorId} ${a.currentDetail}→${a.recommendedDetail}: ${a.evidence}`);
  console.log();

  // Per-task one-liners.
  console.log(`=== per-task notes ===`);
  for (const t of all.sort((a, b) => a.task.localeCompare(b.task))) {
    const nTrim = (t.stepLabels ?? []).flatMap(s => s.labels ?? []).filter(l => l.category === "cost-trim").length;
    console.log(`  ${(t.success ? "✓" : "✗")} ${t.task.padEnd(22)} trims=${nTrim} ${t.failure?.category ? `[${t.failure.category}]` : ""} ${t.notes ?? ""}`);
  }

  await fs.writeFile(
    path.join(DIR, "AGGREGATE.json"),
    JSON.stringify(
      {
        counts: { total: all.length, correct: correct.length, failed: failed.length },
        failureSplit: { contextFixable: ctxFix.map(t => t.task), taskIntrinsic: intrinsic.map(t => t.task), unclassified: unclassified.map(t => t.task) },
        costTrimTransitions: Object.fromEntries(transition),
        accuracyCritical: acc,
        totalLabels,
      },
      null,
      2
    )
  );
  console.log(`\nwrote ${path.join(DIR, "AGGREGATE.json")}`);
}

main().catch(e => {
  console.error("fatal:", e);
  process.exit(1);
});
