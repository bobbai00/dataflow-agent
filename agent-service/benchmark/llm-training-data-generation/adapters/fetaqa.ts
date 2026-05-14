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

import { AgentMode } from "../../../src/types/agent";
import {
  buildNaturalPrompt,
  defaultScore,
  type AdapterLoadOptions,
  type AgentSettingsHints,
  type DatasetAdapter,
  type PromptContext,
  type Task,
  type TaskScore,
} from "../protocol";

interface FetaqaManifestRow {
  id: string;
  source: string;
  question: string;
  data_path: string;
  data_kind: string;
  answer: string;
  answer_type: string;
  split?: string;
  texera_ops?: string[];
  schema_hint?: {
    columns?: string[];
    page_title?: string;
    section_title?: string;
    highlighted_cells?: unknown[];
  };
}

export class FetaqaAdapter implements DatasetAdapter {
  readonly name = "fetaqa";

  async *load(opts: AdapterLoadOptions): AsyncIterable<Task> {
    const manifestPath = path.join(opts.rootDir, "manifest.jsonl");
    const raw = await fs.readFile(manifestPath, "utf-8");
    const lines = raw.split(/\r?\n/);

    let yielded = 0;
    let skipped = 0;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (skipped < offset) {
        skipped += 1;
        continue;
      }
      if (yielded >= limit) break;

      let row: FetaqaManifestRow;
      try {
        row = JSON.parse(trimmed) as FetaqaManifestRow;
      } catch {
        continue; // skip malformed lines
      }

      const localPath = path.join(opts.rootDir, row.data_path);
      const relPath = path.basename(row.data_path); // store as flat filename inside the dataset
      const task: Task = {
        id: row.id,
        source: this.name,
        question: row.question,
        goldAnswer: row.answer,
        answerType: (row.answer_type as Task["answerType"]) ?? "freeform",
        dataFiles: [
          {
            localPath,
            relPath,
            kind: (row.data_kind as Task["dataFiles"][number]["kind"]) ?? "csv",
          },
        ],
        schemaHint: row.schema_hint as Record<string, unknown> | undefined,
        metadata: {
          split: row.split,
          texera_ops: row.texera_ops,
        },
      };
      yield task;
      yielded += 1;
    }
  }

  buildPrompt(task: Task, _ctx: PromptContext): string {
    // Show a natural-looking relative path in the prompt —
    // "fetaqa/data/<task.id>/<file>" — rather than the absolute localPath.
    // The "fetaqa/" prefix mirrors the on-disk layout under DATA_ROOT.
    const filePaths = task.dataFiles.map(f => `${this.name}/data/${task.id}/${path.basename(f.localPath)}`);
    return buildNaturalPrompt(task.question, filePaths);
  }

  defaultAgentSettings(): AgentSettingsHints {
    return {
      agentMode: AgentMode.CODE,
      maxSteps: 30,
      toolTimeoutSeconds: 120,
      executionTimeoutMinutes: 5,
    };
  }

  evaluate(task: Task, modelAnswer: string): TaskScore {
    return defaultScore(task.goldAnswer, modelAnswer);
  }
}
