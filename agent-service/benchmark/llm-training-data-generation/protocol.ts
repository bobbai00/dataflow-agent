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

import type { ReActStep, AgentMode } from "../../src/types/agent";
import type { WorkflowContent } from "../../src/types/workflow";

/**
 * The unit a dataset adapter exposes. Source-specific extras live under
 * `metadata` / `schemaHint` so adapters stay swappable.
 */
export interface Task {
  /** Stable per-source id (e.g. "fetaqa_00000_2275"). */
  id: string;
  source: string;
  question: string;
  goldAnswer: string;
  /** "freeform" = full sentence; "shortform" = single value/list; "structured" = JSON-able. */
  answerType: "freeform" | "shortform" | "structured";
  /**
   * Files the agent may need to load. `localPath` is the absolute filesystem
   * path, `relPath` is the path the file should keep inside the staging
   * dataset (so workflow paths can predictably point at it).
   */
  dataFiles: TaskDataFile[];
  /** Source-specific schema info (FeTaQA: columns, page_title, ...). */
  schemaHint?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface TaskDataFile {
  localPath: string;
  relPath: string;
  kind: "csv" | "tsv" | "json" | "jsonl" | "parquet" | "txt" | "binary";
}

/**
 * Adapter for one upstream dataset (FeTaQA, KramaBench, ...). Adapters control
 * how tasks are loaded, what prompt to send, and how to score the model's
 * answer against the gold.
 */
export interface DatasetAdapter {
  readonly name: string;

  /** Yield Tasks one at a time. `limit`/`offset` let callers paginate. */
  load(opts: AdapterLoadOptions): AsyncIterable<Task>;

  /**
   * Construct the user message the agent will see for this task. Receives
   * the dataset URI prefix (`/{ownerEmail}/{datasetName}/{version}`) so the
   * adapter can splice in a workflow-loadable path.
   */
  buildPrompt(task: Task, ctx: PromptContext): string;

  /**
   * Default agent settings recommended for this source. The driver merges
   * these with command-line / env overrides.
   */
  defaultAgentSettings?: () => AgentSettingsHints;

  /**
   * Score the model's answer against the gold. Adapters can plug in a
   * source-specific metric; default is token-overlap F1 + substring match.
   */
  evaluate?: (task: Task, modelAnswer: string) => TaskScore;
}

export interface AdapterLoadOptions {
  /** The absolute path of the dataset's root folder on disk. */
  rootDir: string;
  limit?: number;
  offset?: number;
}

export interface PromptContext {
  /** "/{ownerEmail}/{datasetName}/{versionName}" — prepend to file relPath. */
  datasetPathPrefix: string;
}

export interface AgentSettingsHints {
  agentMode?: AgentMode;
  maxSteps?: number;
  toolTimeoutSeconds?: number;
  executionTimeoutMinutes?: number;
  allowedOperatorTypes?: string[];
}

export interface TaskScore {
  /** A numeric score in [0,1]. Adapter-defined semantics. */
  score: number;
  /** Whether this score should count as "correct" for aggregate stats. */
  passed: boolean;
  /** Free-form components the adapter wants to surface. */
  details?: Record<string, number | string | boolean>;
}

/* ---------------- Natural prompt + Final Answer parsing ---------------- */

/**
 * Source-agnostic prompt template. Adapters supply the question and the
 * filesystem paths; the template wraps them in a request that any LLM should
 * find natural. The trailing "Final Answer:" instruction is what lets the
 * scorer parse the answer cleanly out of the agent's free-form reply.
 */
export function buildNaturalPrompt(question: string, filePaths: string[]): string {
  const lines: string[] = ["For my files (all relative paths):"];
  for (const p of filePaths) lines.push(` - ${p}`);
  lines.push("", question.trim());
  lines.push("");
  lines.push("Your last line must be: **Final Answer: <your answer>**");
  return lines.join("\n");
}

/**
 * Pull the model's actual answer out of the free-form trailing text. Looks
 * for the last line containing "Final Answer:" (case-insensitive, optionally
 * wrapped in **bold**). Falls back to the raw text if the marker is missing.
 */
export function parseFinalAnswer(content: string): string {
  if (!content) return "";
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/(?:\*\*\s*)?final answer:\s*(.+?)(?:\s*\*\*)?\s*$/i);
    if (m) return m[1].trim();
  }
  return content.trim();
}

/* ---------------- Trace record (what we persist per task) ---------------- */

export interface TraceRecord {
  task: Task;
  prompt: string;
  agentInfo: {
    agentId: string;
    modelType: string;
    agentMode: AgentMode | "unknown";
  };
  finalState: string;
  finalAnswer: string;
  reactSteps: ReActStep[];
  /** Map of stepId → workflow content as it stood at that step. */
  snapshots: Record<string, WorkflowContent>;
  /** Last workflow snapshot — convenient pointer to the "answer workflow". */
  finalWorkflow: WorkflowContent | null;
  timings: { startedAt: string; finishedAt: string; durationMs: number };
  /** Set when this trace did not run cleanly. Pipeline still saves the partial. */
  errors: string[];
  score?: TaskScore;
}

/* ---------------- Default scoring (used when adapter doesn't override) ---------------- */

const STOPWORDS = new Set([
  "a", "an", "the", "is", "was", "were", "are", "be", "been", "being",
  "of", "in", "on", "at", "to", "for", "with", "and", "or", "but", "as",
  "by", "from", "that", "this", "these", "those", "it", "its", "his", "her",
  "their", "they", "he", "she", "we", "you", "i", "me", "us", "them", "do",
  "does", "did", "has", "have", "had", "will", "would", "should", "can", "could",
  "what", "which", "who", "when", "where", "why", "how",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Default text-similarity score. Token-overlap F1 + a substring "contains"
 * boolean. Treats `passed` as F1 ≥ 0.5 OR the gold is fully contained in
 * the model answer.
 */
export function defaultScore(goldAnswer: string, modelAnswer: string): TaskScore {
  if (!modelAnswer || !modelAnswer.trim()) {
    return { score: 0, passed: false, details: { f1: 0, precision: 0, recall: 0, substringMatch: false } };
  }
  const goldTokens = tokenize(goldAnswer);
  const modelTokens = tokenize(modelAnswer);

  if (goldTokens.length === 0 || modelTokens.length === 0) {
    return { score: 0, passed: false, details: { f1: 0, precision: 0, recall: 0, substringMatch: false } };
  }

  const goldSet = new Set(goldTokens);
  const modelSet = new Set(modelTokens);
  let overlap = 0;
  for (const t of modelSet) if (goldSet.has(t)) overlap += 1;

  const precision = overlap / modelSet.size;
  const recall = overlap / goldSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const goldNorm = goldAnswer.trim().toLowerCase();
  const modelNorm = modelAnswer.trim().toLowerCase();
  const substringMatch = goldNorm.length > 0 && modelNorm.includes(goldNorm);

  const passed = substringMatch || f1 >= 0.5;
  return {
    score: substringMatch ? 1 : f1,
    passed,
    details: {
      f1: Number(f1.toFixed(4)),
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      substringMatch,
    },
  };
}

/* ---------------- Aggregated run summary ---------------- */

export interface RunSummary {
  source: string;
  total: number;
  errored: number;
  scored: number;
  passed: number;
  meanScore: number;
  medianScore: number;
  passRate: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  modelType: string;
  agentMode: string;
  thresholds: { passF1: number };
  /** One row per task — small enough to inline but big enough to drive plots. */
  perTask: Array<{
    id: string;
    score: number;
    passed: boolean;
    errored: boolean;
    durationMs: number;
    answerLength: number;
    stepCount: number;
  }>;
}

export function aggregateSummary(input: {
  source: string;
  modelType: string;
  agentMode: string;
  startedAt: string;
  finishedAt: string;
  records: TraceRecord[];
}): RunSummary {
  const total = input.records.length;
  const errored = input.records.filter(r => r.errors.length > 0).length;
  const scored = input.records.filter(r => r.score).length;
  const passed = input.records.filter(r => r.score?.passed).length;

  const scores = input.records.map(r => r.score?.score ?? 0).sort((a, b) => a - b);
  const meanScore = scored === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
  const medianScore = scored === 0 ? 0 : scores[Math.floor(scores.length / 2)];

  const perTask = input.records.map(r => ({
    id: r.task.id,
    score: r.score?.score ?? 0,
    passed: r.score?.passed ?? false,
    errored: r.errors.length > 0,
    durationMs: r.timings.durationMs,
    answerLength: r.finalAnswer.length,
    stepCount: r.reactSteps.length,
  }));

  return {
    source: input.source,
    total,
    errored,
    scored,
    passed,
    passRate: total === 0 ? 0 : passed / total,
    meanScore: Number(meanScore.toFixed(4)),
    medianScore: Number(medianScore.toFixed(4)),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime(),
    modelType: input.modelType,
    agentMode: input.agentMode,
    thresholds: { passF1: 0.5 },
    perTask,
  };
}
