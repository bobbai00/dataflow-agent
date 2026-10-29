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

import type { OperatorLink, OperatorPredicate } from "../../types/workflow";

/** `files` of a Scan as a list of path patterns. */
function scanFiles(op: OperatorPredicate): string[] {
  const f = op.nativeOp?.properties?.files;
  return Array.isArray(f) ? f.map(String) : typeof f === "string" ? [f] : [];
}

/** True when `path` is `pattern` or matches it as a glob (`*`, `?`, `**`). */
function globCovers(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (!/[*?[]/.test(pattern)) return false;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*") +
      "$"
  );
  return re.test(path);
}

/**
 * PROBE RETIREMENT — a `preview` Scan exists to inspect a file before its real
 * Scan. Once a real Scan covers the same file(s) and nothing reads the preview,
 * its raw lines are spent: an observation of the preview shows no result, the
 * real Scan's carries the data. Returns the spent previews.
 */
export function retiredPreviews(operators: readonly OperatorPredicate[], links: readonly OperatorLink[]): Set<string> {
  const out = new Set<string>();
  const hasConsumer = new Set(links.map(l => l.source.operatorID));
  const realScans = operators.filter(o => o.nativeOp?.type === "Scan" && !o.nativeOp.properties?.preview);
  for (const op of operators) {
    if (op.nativeOp?.type !== "Scan" || !op.nativeOp.properties?.preview || hasConsumer.has(op.operatorID)) continue;
    const files = scanFiles(op);
    if (realScans.some(r => files.length > 0 && files.every(f => scanFiles(r).some(pat => globCovers(pat, f)))))
      out.add(op.operatorID);
  }
  return out;
}
