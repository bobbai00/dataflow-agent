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
 * Aggregate a learned-selector A/B: compare arm output dirs produced by run.ts
 * (each with kramabench/traces/<task>/{meta.json, react-steps.json}).
 * Per task per arm: passed, score, context tokens (Σ usage.inputTokens over
 * steps — the real provider-reported context cost), step count. Prints a paired
 * comparison + aggregate deltas, and (on matched accuracy) the token savings.
 *
 * Usage: bun run .../learned-e2e-report.ts --arm latest=<dir> --arm learned=<dir> [--json out.json]
 */

import { promises as fs } from "fs";
import path from "path";

interface TaskMetrics {
  passed: boolean;
  score: number;
  contextTokens: number;
  steps: number;
}

async function readArm(dir: string): Promise<Map<string, TaskMetrics>> {
  const tracesDir = path.join(dir, "kramabench", "traces");
  const out = new Map<string, TaskMetrics>();
  let entries: string[];
  try {
    entries = (await fs.readdir(tracesDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return out;
  }
  for (const taskId of entries) {
    let meta: any, rs: any;
    try {
      meta = JSON.parse(await fs.readFile(path.join(tracesDir, taskId, "meta.json"), "utf-8"));
      rs = JSON.parse(await fs.readFile(path.join(tracesDir, taskId, "react-steps.json"), "utf-8"));
    } catch {
      continue;
    }
    const steps = rs.steps ?? [];
    let tokens = 0;
    for (const s of steps) tokens += s.usage?.inputTokens ?? 0;
    out.set(taskId, {
      passed: !!meta.score?.passed,
      score: Number(meta.score?.score ?? 0),
      contextTokens: tokens,
      steps: steps.length,
    });
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function pct(a: number, b: number): string {
  if (b === 0) return "n/a";
  return `${(((a - b) / b) * 100).toFixed(1)}%`;
}

async function main() {
  const argv = process.argv.slice(2);
  const arms: Record<string, string> = {};
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arm") {
      const [name, dir] = argv[++i].split("=");
      arms[name] = dir;
    } else if (argv[i] === "--json") jsonOut = argv[++i];
  }
  const armNames = Object.keys(arms);
  if (armNames.length < 2) {
    console.error("need >=2 --arm name=dir");
    process.exit(1);
  }
  const baseline = armNames[0];

  const data: Record<string, Map<string, TaskMetrics>> = {};
  for (const name of armNames) data[name] = await readArm(arms[name]);

  // tasks present in ALL arms (paired comparison)
  const common = [...data[baseline].keys()].filter(t => armNames.every(a => data[a].has(t))).sort();

  console.log(`\n=== learned-selector A/B (${common.length} tasks in all arms) ===\n`);
  const w = 22;
  const head = ["task".padEnd(w), ...armNames.map(a => `${a}(pass/tok/stp)`.padEnd(24))].join("");
  console.log(head);
  for (const t of common) {
    const cells = armNames.map(a => {
      const m = data[a].get(t)!;
      return `${m.passed ? "✓" : "✗"} ${m.contextTokens} ${m.steps}`.padEnd(24);
    });
    console.log(t.padEnd(w) + cells.join(""));
  }

  const agg: Record<string, any> = {};
  console.log(`\n=== aggregate (paired, n=${common.length}) ===`);
  console.log(`${"arm".padEnd(w)}${"passRate".padEnd(12)}${"meanScore".padEnd(12)}${"meanTokens".padEnd(14)}${"meanSteps".padEnd(12)}`);
  for (const a of armNames) {
    const ms = common.map(t => data[a].get(t)!);
    const passRate = mean(ms.map(m => (m.passed ? 1 : 0)));
    const meanScore = mean(ms.map(m => m.score));
    const meanTokens = mean(ms.map(m => m.contextTokens));
    const meanSteps = mean(ms.map(m => m.steps));
    agg[a] = { passRate, meanScore, meanTokens, meanSteps, n: ms.length };
    console.log(
      `${a.padEnd(w)}${passRate.toFixed(3).padEnd(12)}${meanScore.toFixed(3).padEnd(12)}${meanTokens.toFixed(0).padEnd(14)}${meanSteps.toFixed(1).padEnd(12)}`
    );
  }

  console.log(`\n=== deltas vs ${baseline} ===`);
  for (const a of armNames.slice(1)) {
    console.log(
      `${a}: passRate ${(agg[a].passRate - agg[baseline].passRate >= 0 ? "+" : "")}${(agg[a].passRate - agg[baseline].passRate).toFixed(3)}` +
        ` | tokens ${pct(agg[a].meanTokens, agg[baseline].meanTokens)} | steps ${pct(agg[a].meanSteps, agg[baseline].meanSteps)}`
    );
  }

  if (jsonOut) {
    const perTask: Record<string, Record<string, TaskMetrics>> = {};
    for (const a of armNames) perTask[a] = Object.fromEntries(data[a]);
    await fs.writeFile(jsonOut, JSON.stringify({ arms, common, perTask, aggregate: agg }, null, 2), "utf-8");
    console.log(`\nwrote ${jsonOut}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
