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

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Native (FeTaQA-style) evaluation runner.
 *
 * Delegates the actual scoring to a Python sidecar that uses the published
 * reference libraries (sacrebleu, rouge-score). The TS pipeline owns trace
 * generation; this thin wrapper owns scoring orchestration so users can run
 * `bun run trace-eval` independently of `bun run trace-gen`.
 */

interface Args {
  source: string;
  outputDir: string;
  passThreshold?: number;
}

const log = (...args: unknown[]) => console.log("[trace-eval]", ...args);
const logErr = (...args: unknown[]) => console.error("[trace-eval]", ...args);

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SOURCE_REGISTRY: Record<string, { script: string }> = {
  fetaqa: { script: path.join(__dirname, "scripts", "evaluate_fetaqa.py") },
};

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--output") args.outputDir = argv[++i];
    else if (a === "--pass-threshold") args.passThreshold = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun run benchmark/llm-training-data-generation/evaluate.ts [--source fetaqa] [--output PATH] [--pass-threshold 0.4]"
      );
      process.exit(0);
    }
  }
  return {
    source: args.source ?? "fetaqa",
    outputDir: args.outputDir ?? path.join(__dirname, "output"),
    passThreshold: args.passThreshold,
  };
}

async function resolvePython(): Promise<string> {
  const venvPython = path.join(REPO_ROOT, ".venv", "bin", "python");
  try {
    await fs.access(venvPython);
    return venvPython;
  } catch {
    // Fall back to system uv if the project venv hasn't been synced.
    return "uv";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  log(`source=${args.source} output=${args.outputDir}`);

  const registryEntry = SOURCE_REGISTRY[args.source];
  if (!registryEntry) {
    logErr(`No native evaluator registered for source "${args.source}". Known: ${Object.keys(SOURCE_REGISTRY).join(", ")}`);
    process.exit(1);
  }

  const sourceOutput = path.join(args.outputDir, args.source);
  try {
    await fs.access(sourceOutput);
  } catch {
    logErr(`No output found at ${sourceOutput}. Did you run trace-gen first?`);
    process.exit(1);
  }

  const python = await resolvePython();
  const cmdArgs =
    python === "uv"
      ? ["run", "python", registryEntry.script, "--output-dir", sourceOutput]
      : [registryEntry.script, "--output-dir", sourceOutput];
  if (args.passThreshold !== undefined) cmdArgs.push("--pass-threshold", String(args.passThreshold));

  log(`spawning: ${python} ${cmdArgs.join(" ")}`);
  const proc = Bun.spawn([python, ...cmdArgs], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    logErr(`evaluator exited with code ${exitCode}`);
    process.exit(exitCode);
  }
}

main().catch(err => {
  logErr("fatal:", err);
  process.exit(1);
});
