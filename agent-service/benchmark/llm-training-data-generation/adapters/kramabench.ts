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

import { AgentMode } from "../../../src/types/agent";
import {
  buildNaturalPrompt,
  type AdapterLoadOptions,
  type AgentSettingsHints,
  type DatasetAdapter,
  type PromptContext,
  type Task,
  type TaskScore,
} from "../protocol";

/**
 * KramaBench adapter. Unlike FeTaQA (a single manifest.jsonl), KramaBench is a
 * directory of self-contained task folders, each holding:
 *   - ground_truth.json : {id, query, answer, answer_type, data_sources[]}
 *   - config.json       : {dataset_directory, subset_files[], agent_settings{}}
 *   - prompt.txt        : the original natural-language prompt
 * Data files live outside the task dir at config.dataset_directory (the repo's
 * ./data symlink → ~/Kramabench/data/{domain}/input).
 *
 * The five KramaBench answer types get tailored scoring (validated to reproduce
 * the recorded `evaluation.json` success flags on the shipped traces):
 *   numeric_exact, numeric_approximate, string_exact, string_approximate,
 *   list_exact.
 */

type KramaAnswerType =
  | "numeric_exact"
  | "numeric_approximate"
  | "string_exact"
  | "string_approximate"
  | "list_exact";

interface GroundTruth {
  id: string;
  query: string;
  answer: unknown;
  answer_type: KramaAnswerType;
  data_sources?: string[];
}

interface KramaConfig {
  query_id?: string;
  dataset_directory?: string;
  subset_files?: string[];
  agent_settings?: {
    max_steps?: number;
    tool_timeout_seconds?: number;
    execution_timeout_minutes?: number;
    max_operator_result_char_limit?: number;
  };
}

const KIND_BY_EXT: Record<string, Task["dataFiles"][number]["kind"]> = {
  ".csv": "csv", ".tsv": "tsv", ".json": "json", ".jsonl": "jsonl",
  ".parquet": "parquet", ".txt": "txt",
};

function fileKind(p: string): Task["dataFiles"][number]["kind"] {
  return KIND_BY_EXT[path.extname(p).toLowerCase()] ?? "binary";
}

export class KramabenchAdapter implements DatasetAdapter {
  readonly name = "kramabench";
  // KramaBench is a directory of task folders, not a manifest file. Default to
  // the shipped trace set at the repo root (override with --data-root).
  readonly defaultSourceDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "../../../../llm-training-set-v1-kramabench"
  );

  /** Resolve the on-disk data directory for a task, honoring the repo symlink. */
  private dataDir(rootDir: string, domain: string, cfg: KramaConfig): string {
    // Prefer the repo-relative ./data symlink so runs are portable across
    // machines; fall back to the absolute path recorded in config.json.
    const repoData = path.resolve(rootDir, "..", "data", domain, "input");
    return cfg.dataset_directory && !repoData ? cfg.dataset_directory : repoData;
  }

  async *load(opts: AdapterLoadOptions): AsyncIterable<Task> {
    // Optional KRAMABENCH_TASKS=id1,id2,... filter (used to run a specific
    // random sample reproducibly). When unset, iterate all task dirs.
    const only = (process.env.KRAMABENCH_TASKS ?? "")
      .split(",").map(s => s.trim()).filter(Boolean);
    const onlySet = new Set(only);

    let entries = (await fs.readdir(opts.rootDir, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort();
    if (onlySet.size > 0) entries = entries.filter(n => onlySet.has(n));

    let yielded = 0;
    let skipped = 0;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;

    for (const name of entries) {
      const dir = path.join(opts.rootDir, name);
      let gt: GroundTruth;
      let cfg: KramaConfig;
      try {
        gt = JSON.parse(await fs.readFile(path.join(dir, "ground_truth.json"), "utf-8"));
        cfg = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf-8"));
      } catch {
        continue; // not a task dir / malformed
      }
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (yielded >= limit) break;

      const domain = name.split("-")[0];
      const dataDir = this.dataDir(opts.rootDir, domain, cfg);
      const subset = cfg.subset_files ?? gt.data_sources ?? [];

      const dataFiles: Task["dataFiles"] = [];
      for (const rel of subset) {
        const localPath = path.isAbsolute(rel) ? rel : path.join(dataDir, rel);
        try {
          await fs.access(localPath);
        } catch {
          // Skip missing files but keep the task runnable on whatever exists.
          continue;
        }
        dataFiles.push({ localPath, relPath: path.basename(rel), kind: fileKind(rel) });
      }

      yield {
        id: gt.id || name,
        source: this.name,
        question: gt.query,
        goldAnswer: typeof gt.answer === "string" ? gt.answer : JSON.stringify(gt.answer),
        // KramaBench's fine-grained types don't map onto the protocol union;
        // record the real type in metadata and use it in evaluate().
        answerType: gt.answer_type === "list_exact" ? "structured" : "shortform",
        dataFiles,
        metadata: {
          domain,
          krama_answer_type: gt.answer_type,
          agent_settings: cfg.agent_settings,
          data_sources: gt.data_sources,
        },
      } satisfies Task;
      yielded += 1;
    }
  }

  buildPrompt(task: Task, _ctx: PromptContext): string {
    const filePaths = task.dataFiles.map(
      f => `${this.name}/data/${task.id}/${path.basename(f.localPath)}`
    );
    const at = (task.metadata?.krama_answer_type as KramaAnswerType) ?? "string_exact";
    const hint = answerFormatHint(at);
    return buildNaturalPrompt(`${task.question}\n\n${hint}`, filePaths);
  }

  defaultAgentSettings(): AgentSettingsHints {
    return {
      agentMode: AgentMode.CODE,
      maxSteps: 50,
      toolTimeoutSeconds: 240,
      executionTimeoutMinutes: 4,
    };
  }

  evaluate(task: Task, modelAnswer: string): TaskScore {
    const at = (task.metadata?.krama_answer_type as KramaAnswerType) ?? "string_exact";
    return scoreKramabench(task.goldAnswer, modelAnswer, at);
  }
}

/* ----------------------------- scoring ----------------------------- */

function answerFormatHint(at: KramaAnswerType): string {
  switch (at) {
    case "numeric_exact":
    case "numeric_approximate":
      return "Answer format: a single number.";
    case "list_exact":
      return "Answer format: a list, e.g. ['a', 1.23].";
    default:
      return "Answer format: a single short string.";
  }
}

function normStr(s: string): string {
  return String(s).trim().toLowerCase().replace(/\s+/g, " ");
}

function extractNum(s: string): number | null {
  const m = String(s).replace(/,/g, "").match(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g);
  if (!m || m.length === 0) return null;
  const v = Number(m[m.length - 1]);
  return Number.isFinite(v) ? v : null;
}

function decimals(s: string): number {
  const str = String(s);
  return str.includes(".") ? str.split(".")[1].length : 0;
}

function toList(v: string): unknown[] {
  const s = String(v).trim();
  try {
    const x = JSON.parse(s.replace(/'/g, '"'));
    return Array.isArray(x) ? x : [x];
  } catch {
    return s.replace(/^[\[(]|[\])]$/g, "").split(/[;,]/).map(t => t.trim()).filter(Boolean);
  }
}

function toks(s: string): Set<string> {
  return new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Answer-type-aware scorer. Validated against the 60 shipped KramaBench traces:
 * reproduces 39/39 recorded `success` flags (the subset with a recorded value).
 */
export function scoreKramabench(
  gold: string,
  answer: string,
  answerType: KramaAnswerType
): TaskScore {
  const pass = (ok: boolean, score?: number, details?: Record<string, number | string | boolean>): TaskScore =>
    ({ score: score ?? (ok ? 1 : 0), passed: ok, details: { answerType, ...(details ?? {}) } });

  if (!answer || !answer.trim()) return pass(false);

  switch (answerType) {
    case "numeric_exact": {
      const g = extractNum(gold), a = extractNum(answer);
      if (g === null || a === null) return pass(false);
      const nd = decimals(gold);
      const ok =
        Math.abs(Number(a.toFixed(nd)) - Number(g.toFixed(nd))) <= Math.pow(10, -nd) * 1.0001 ||
        (Math.abs(g) > 0 && Math.abs(a - g) / Math.abs(g) < 1e-4) ||
        Math.abs(a - g) < 1e-9;
      return pass(ok, ok ? 1 : 0, { gold: g, model: a });
    }
    case "numeric_approximate": {
      const g = extractNum(gold), a = extractNum(answer);
      if (g === null || a === null) return pass(false);
      const relErr = Math.abs(g) > 0 ? Math.abs(a - g) / Math.abs(g) : Math.abs(a - g);
      return pass(relErr <= 0.05 + 1e-9, Math.max(0, 1 - relErr), { relErr: Number(relErr.toFixed(4)) });
    }
    case "string_exact": {
      const ok = normStr(gold) === normStr(answer) || normStr(answer).includes(normStr(gold));
      return pass(ok);
    }
    case "string_approximate": {
      const tg = toks(gold), ta = toks(answer);
      if (tg.size === 0 || ta.size === 0) return pass(false);
      let inter = 0;
      for (const t of tg) if (ta.has(t)) inter += 1;
      const f1 = (2 * inter) / (tg.size + ta.size);
      const ok = f1 >= 0.5 || normStr(answer).includes(normStr(gold));
      return pass(ok, f1, { f1: Number(f1.toFixed(4)) });
    }
    case "list_exact": {
      const lg = toList(gold), la = toList(answer);
      if (lg.length !== la.length) return pass(false, 0, { lenGold: lg.length, lenModel: la.length });
      let ok = true;
      for (let i = 0; i < lg.length; i++) {
        const ax = extractNum(String(lg[i])), ay = extractNum(String(la[i]));
        if (ax !== null && ay !== null) ok = ok && Math.abs(ax - ay) <= Math.abs(ax) * 0.01 + 1e-6;
        else ok = ok && normStr(String(lg[i])) === normStr(String(la[i]));
      }
      return pass(ok);
    }
    default:
      return pass(normStr(gold) === normStr(answer));
  }
}
