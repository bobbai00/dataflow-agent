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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * MISSING-PATH HINT — turn `FileNotFoundError` into the answer.
 *
 * The agent cannot list files: it learns a path exists only by opening it. So a
 * bare `No such file or directory: '<path>'` leaves it guessing, and guessing
 * loops. Measured on LongDS march_madness turn 13: 41 steps, 22 loader writes,
 * 5 distinct wrong paths, the turn lost — with the CORRECT directory string
 * sitting in its context 90 times. It was not missing information; it could not
 * tell which of several plausible folders held the file.
 *
 * That dataset is the honest case for this: 42 basenames appear in more than one
 * directory, and the copies DIFFER (MEvents2017.csv is 176 MB under
 * `2020DataFiles/2020DataFiles/2020-Mens-Data/` and 182 MB under
 * `MPlayByPlay_Stage2/`). Deduplicating the data would silently change what the
 * right answer is, so the fix has to be in the error, not the filesystem.
 *
 * The hint lists real paths that share the missing file's basename. When several
 * match it says so explicitly, because "pick one" is precisely the decision the
 * agent got wrong, and a hint that hid the ambiguity would teach it to guess
 * again with more confidence.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** `No such file or directory: '<path>'`, as Python renders it. */
const MISSING_RE = /No such file or directory: ['"]([^'"]+)['"]/;

/** Suggestions listed before truncating — enough to disambiguate, not a dump. */
export const MAX_SUGGESTIONS = 6;
/** Directories visited while searching. Bounds the cost on a wide tree. */
const MAX_DIRS = 4000;
/** How far above the guessed location to look. A wrong guess is usually a
 *  sibling directory, not a different dataset. */
const CLIMB_LEVELS = 3;
/** How far ABOVE the process cwd to look for the root a relative data path is
 *  written against. The service does not run where the harness does: the agent
 *  writes `data/longds/...`, resolved by the executing worker, while this process
 *  lives in `agent-service/` whose parent holds the `data` symlink. Resolving
 *  against `process.cwd()` alone silently found nothing — the first version of
 *  this file shipped that bug and produced zero hints on 98 real path failures. */
const BASE_SEARCH_LEVELS = 4;

/**
 * The directory a relative path should be resolved against: the nearest ancestor
 * of `from` (itself included) under which the path's FIRST segment exists.
 */
export function resolveBase(relative: string, from: string, levels = BASE_SEARCH_LEVELS): string {
  const first = relative.split("/").filter(Boolean)[0];
  if (!first) return from;
  let dir = from;
  for (let i = 0; i <= levels; i++) {
    if (existsSync(join(dir, first))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}

/**
 * Walk `root` for files named `name`. Bounded: a data lake is not a search
 * index, and an unbounded walk under an unexpected root would stall a turn that
 * is already failing.
 */
function findByBasename(root: string, name: string, cap = MAX_SUGGESTIONS): string[] {
  const out: string[] = [];
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && out.length < cap && visited < MAX_DIRS) {
    const dir = queue.shift()!;
    visited++;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable directory is not worth failing the hint over
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) queue.push(full);
      else if (entry === name && out.length < cap) out.push(full);
    }
  }
  return out;
}

/**
 * The search root for a missing path: the deepest ANCESTOR that exists. A typo
 * in the middle of a long path (`march_madness_analytics-2020` for
 * `march-madness-analytics-2020`) still resolves to a real ancestor, so the
 * search starts as close to the intended location as the path allows.
 */
export function deepestExistingAncestor(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  const absolute = path.startsWith("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = (absolute ? "/" : "") + parts.slice(0, i).join("/");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Append real alternatives to an error mentioning a missing file. Returns the
 * text unchanged when the error is not a missing-path error, when nothing with
 * that basename exists, or when the only match IS the path that failed (which
 * would mean the failure is a permission or race problem, not a wrong path).
 */
export function annotateMissingPath(errorText: string, cwd: string = process.cwd()): string {
  if (!errorText) return errorText;
  const match = MISSING_RE.exec(errorText);
  if (!match) return errorText;

  const missing = match[1];
  const name = basename(missing);
  if (!name || name.includes("*")) return errorText; // a failed glob names no single file

  // Start at the deepest real ancestor, then climb: a sibling directory is
  // exactly where the other copy lives, and searching only the subtree the
  // agent guessed would report one match and hide the choice it got wrong.
  // Bounded by CLIMB_LEVELS and by cwd, so this never walks the whole disk.
  const base = missing.startsWith("/") ? "/" : resolveBase(missing, cwd);
  const abs = missing.startsWith("/") ? missing : join(base, missing);
  let root = deepestExistingAncestor(abs) ?? cwd;
  for (let i = 0; i < CLIMB_LEVELS; i++) {
    const parent = root.slice(0, root.lastIndexOf("/"));
    if (!parent || parent.length < base.length || !existsSync(parent)) break;
    root = parent;
  }
  const found = findByBasename(root, name).filter(p => p !== missing && p !== join(base, missing));
  if (found.length === 0) return errorText;

  // Keep only the CLOSEST matches: those sharing the longest leading run of
  // directories with the path that failed. Climbing to find siblings can reach
  // into a neighbouring task's data — suggesting a file from someone else's task
  // is noise at best, and points the analysis at data it was never given. Ties
  // are kept, because two files equally close IS the ambiguity worth reporting.
  const attempted = join(base, missing).split("/");
  const shared = (candidate: string) => {
    const parts = candidate.split("/");
    let i = 0;
    while (i < parts.length - 1 && i < attempted.length - 1 && parts[i] === attempted[i]) i++;
    return i;
  };
  const best = Math.max(...found.map(shared));
  const closest = found.filter(p => shared(p) === best);

  // Report paths as the agent writes them: relative to the base they resolve
  // against, never as absolute paths from this process's point of view.
  const rel = closest.map(p => (p.startsWith(base + "/") ? p.slice(base.length + 1) : p));
  const lines = [
    errorText.trimEnd(),
    "",
    rel.length === 1
      ? `\`${name}\` does exist, at a different path — use it verbatim:`
      : `\`${name}\` exists at ${rel.length} different paths. These are NOT copies of one file; ` +
        `pick the one this analysis means and use it verbatim:`,
    ...rel.map(p => `  ${p}`),
  ];
  return lines.join("\n");
}
