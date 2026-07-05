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

// Offline validation of the KramaBench adapter — no backend required.
//   1. KramabenchAdapter.load() yields all task dirs with resolvable data files.
//   2. scoreKramabench() reproduces the recorded evaluation.json `success`.
// Run: bun run benchmark/llm-training-data-generation/scripts/validate-kramabench-adapter.ts

import { promises as fs } from "node:fs";
import path from "node:path";

import { KramabenchAdapter, scoreKramabench } from "../adapters/kramabench";

const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../../llm-training-set-v1-kramabench"
);

async function main() {
  const adapter = new KramabenchAdapter();

  // 1. load()
  const tasks = [];
  for await (const t of adapter.load({ rootDir: ROOT })) tasks.push(t);
  const withFiles = tasks.filter(t => t.dataFiles.length > 0).length;
  console.log(`load(): ${tasks.length} tasks, ${withFiles} with >=1 resolvable data file`);
  console.log(`  example prompt (first task):\n    ${adapter.buildPrompt(tasks[0], { datasetPathPrefix: "" }).replace(/\n/g, "\n    ")}`);

  // 2. scorer vs recorded success
  let scored = 0, agree = 0;
  const mism: string[] = [];
  const dirs = (await fs.readdir(ROOT, { withFileTypes: true })).filter(e => e.isDirectory());
  for (const e of dirs) {
    const dir = path.join(ROOT, e.name);
    let gt: any, ev: any;
    try {
      gt = JSON.parse(await fs.readFile(path.join(dir, "ground_truth.json"), "utf-8"));
      ev = JSON.parse(await fs.readFile(path.join(dir, "evaluation.json"), "utf-8"));
    } catch {
      continue;
    }
    if (ev.success === null || ev.success === undefined) continue;
    const gold = typeof gt.answer === "string" ? gt.answer : JSON.stringify(gt.answer);
    const modelAns = String(ev.model_output?.answer ?? "");
    const sc = scoreKramabench(gold, modelAns, gt.answer_type);
    scored += 1;
    const ok = sc.passed === Boolean(ev.success);
    if (ok) agree += 1;
    else mism.push(`${e.name} [${gt.answer_type}] gold=${gold} model=${modelAns} mine=${sc.passed} rec=${ev.success}`);
  }
  console.log(`\nscorer agreement with recorded success: ${agree}/${scored} = ${((100 * agree) / scored).toFixed(1)}%`);
  if (mism.length) {
    console.log("mismatches:");
    for (const m of mism) console.log("  " + m);
  }
  if (agree !== scored) process.exit(1);
  console.log("\nOK: KramaBench adapter loads + scores correctly.");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
