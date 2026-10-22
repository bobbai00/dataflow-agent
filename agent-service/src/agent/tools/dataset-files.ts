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
 * TEXERA DATASET FILES — make `/owner/dataset/vN/file` readable by an execution.
 *
 * Files uploaded to Texera (including what the agent panel's drag & drop
 * inserts into the chat) are addressed as dataset paths. They live in the
 * dataset store, not on the worker's disk, and a shared computing unit carries
 * no user credential to fetch them with. So before each execution the dataset
 * paths an operator names are resolved — by the file service, with the user's
 * token, which also checks access — to short-lived download links that travel
 * with that execution request only. The worker copies each file once
 * (`native/python/dataset_files.py`); the stored workflow keeps the path the
 * model wrote, and native revisions are unchanged.
 */

import { presignDatasetFile } from "../../api/dataset-api";
import type { LogicalPlan } from "../../api/execution-api";
import { datasetFilesStagingCode, nativeSpecOf, withNativeDatasetFiles } from "../native/codegen";

/** `ownerEmail/datasetName/version/file…`. The file service names every
 * version `v<n>` or `v<n> - <label>`, which keeps local paths such as
 * `data/legal/input/x.csv` from costing a lookup. Globs are not files. */
const DATASET_FILE_PATH = /^\/?[^/\s]+\/[^/]+\/v\d+(?: - [^/]*)?\/[^*?[\]]*[^*?[\]/]$/;

/** The dataset path `value` names, with its leading slash, or undefined. A spec
 * also holds multi-line strings (registered Python source); a path has no line breaks. */
export function datasetFilePath(value: string): string | undefined {
  if (value.includes("\n") || !DATASET_FILE_PATH.test(value)) return undefined;
  return value.startsWith("/") ? value : `/${value}`;
}

/** Operators whose code reads files itself (code mode); native code is recognized by its spec. */
const CODE_OPERATORS = new Set(["DataLoading", "DataProcessing"]);

/** Single- or double-quoted literals on one line (a triple-quoted one-liner yields its body too). */
const STRING_LITERAL = /(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/** Links last 15 minutes; reuse one for 10 so repeated executions send identical code. */
const LINK_REUSE_MS = 10 * 60_000;
/** Remember a path that is not a readable dataset file briefly, so a retry loop does not re-ask. */
const MISS_REUSE_MS = 60_000;
const links = new Map<string, { url?: string; until: number }>();

function strings(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, into);
  return into;
}

async function linkFor(token: string, path: string): Promise<string | undefined> {
  // Access is per user, so links are too.
  const key = `${token}\n${path}`;
  const now = Date.now();
  const known = links.get(key);
  if (known && known.until > now) return known.url;
  let url: string | undefined;
  try {
    url = await presignDatasetFile(token, path);
  } catch {
    url = undefined;
  }
  if (links.size > 1000) for (const [k, v] of links) if (v.until <= now) links.delete(k);
  links.set(key, { url, until: now + (url ? LINK_REUSE_MS : MISS_REUSE_MS) });
  return url;
}

/** Download links for the dataset files among `values`, keyed as written; undefined if none. */
async function datasetLinks(token: string, values: Iterable<string>): Promise<Record<string, string> | undefined> {
  const named = [...values].filter(value => datasetFilePath(value));
  const resolved = await Promise.all(named.map(value => linkFor(token, datasetFilePath(value)!)));
  const files: Record<string, string> = {};
  named.forEach((value, i) => {
    if (resolved[i]) files[value] = resolved[i]!;
  });
  return Object.keys(files).length ? files : undefined;
}

/**
 * The execution request's copy of `operators`, with download links for every
 * Texera dataset file they name: a native operator's spec gains `datasetFiles`;
 * a code-mode operator gets staging lines appended that point its path
 * literals at local copies. Operators naming no dataset file are returned as is.
 */
export async function withDatasetFiles(
  operators: LogicalPlan["operators"],
  token: string
): Promise<LogicalPlan["operators"]> {
  return Promise.all(
    operators.map(async operator => {
      const code = operator.code;
      if (typeof code !== "string" || !CODE_OPERATORS.has(operator.operatorType)) return operator;
      const spec = nativeSpecOf(code);
      if (spec) {
        const files = await datasetLinks(token, strings(spec.properties, new Set()));
        return files ? { ...operator, code: withNativeDatasetFiles(code, files) } : operator;
      }
      const literals = new Set([...code.matchAll(STRING_LITERAL)].map(match => match[2]!));
      const files = await datasetLinks(token, literals);
      return files ? { ...operator, code: code + datasetFilesStagingCode(files) } : operator;
    })
  );
}
