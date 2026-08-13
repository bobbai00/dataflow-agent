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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { annotateMissingPath, deepestExistingAncestor, resolveBase } from "./missing-path-hint";

// Mirrors the shape that caused the loop: one basename, two real directories,
// different contents — the march_madness layout in miniature.
const ROOT = join(tmpdir(), `mph-test-${process.pid}`);
const A = join(ROOT, "data", "comp-2020", "PlayByPlay_Stage2");
const B = join(ROOT, "data", "comp-2020", "DataFiles", "DataFiles", "Mens-Data");

beforeAll(() => {
  mkdirSync(A, { recursive: true });
  mkdirSync(B, { recursive: true });
  writeFileSync(join(A, "Events2017.csv"), "stage2");
  writeFileSync(join(B, "Events2017.csv"), "stage1-different-content");
  writeFileSync(join(A, "Teams.csv"), "only here");
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("annotateMissingPath", () => {
  test("a non-path error is returned untouched", () => {
    const err = "KeyError: 'total_score'";
    expect(annotateMissingPath(err, ROOT)).toBe(err);
  });

  test("one match — names the real path and says to use it verbatim", () => {
    const err = "FileNotFoundError: [Errno 2] No such file or directory: 'data/comp-2020/Wrong/Teams.csv'";
    const out = annotateMissingPath(err, ROOT);
    expect(out).toContain("data/comp-2020/PlayByPlay_Stage2/Teams.csv");
    expect(out).toContain("use it verbatim");
    expect(out.startsWith(err)).toBe(true); // the original error is never lost
  });

  test("a spurious extra subfolder resolves to the ONE closest match", () => {
    // The agent asked for `Mens-Data/Stage1/Events2017.csv`; the file sits one
    // level up in `Mens-Data/`. Another copy exists under PlayByPlay_Stage2, but
    // it is further away, so offering it would only widen the guess.
    const err =
      "FileNotFoundError: [Errno 2] No such file or directory: " +
      "'data/comp-2020/DataFiles/DataFiles/Mens-Data/Stage1/Events2017.csv'";
    const out = annotateMissingPath(err, ROOT);
    expect(out).toContain("Mens-Data/Events2017.csv");
    expect(out).not.toContain("PlayByPlay_Stage2/Events2017.csv");
    expect(out).toContain("does exist, at a different path");
  });

  test("a typo mid-path still finds the file, because the search starts at the deepest real ancestor", () => {
    // `comp_2020` for `comp-2020` — the exact hyphen/underscore slip observed.
    const err = "FileNotFoundError: [Errno 2] No such file or directory: 'data/comp_2020/PlayByPlay_Stage2/Teams.csv'";
    expect(annotateMissingPath(err, ROOT)).toContain("Teams.csv");
  });

  test("a basename that exists nowhere adds nothing — no invented advice", () => {
    const err = "FileNotFoundError: [Errno 2] No such file or directory: 'data/comp-2020/Nope.csv'";
    expect(annotateMissingPath(err, ROOT)).toBe(err);
  });

  test("a failed glob names no single file, so it is left alone", () => {
    const err = "FileNotFoundError: [Errno 2] No such file or directory: 'data/comp-2020/*.csv'";
    expect(annotateMissingPath(err, ROOT)).toBe(err);
  });

  test("deepestExistingAncestor stops at the last real directory", () => {
    expect(deepestExistingAncestor(join(ROOT, "data", "comp-2020", "ghost", "x.csv"))).toBe(
      join(ROOT, "data", "comp-2020")
    );
  });
});

describe("resolving a relative path from a process that runs elsewhere", () => {
  // The bug this suite exists for: the agent writes `data/longds/...`, resolved
  // by the executing worker against the HARNESS root, while agent-service runs
  // one directory deeper. Resolving against process.cwd() found nothing and
  // produced zero hints on 98 real failures. The hint must work when cwd is a
  // subdirectory of the root the path is written against.
  test("finds the file when cwd is a level BELOW the data root", () => {
    const deeper = join(ROOT, "service-lives-here");
    mkdirSync(deeper, { recursive: true });
    const err = "FileNotFoundError: [Errno 2] No such file or directory: 'data/comp-2020/Wrong/Teams.csv'";
    const out = annotateMissingPath(err, deeper);
    expect(out).toContain("data/comp-2020/PlayByPlay_Stage2/Teams.csv");
  });

  test("suggested paths stay relative to the base the agent writes against", () => {
    const deeper = join(ROOT, "service-lives-here");
    mkdirSync(deeper, { recursive: true });
    const err = "FileNotFoundError: [Errno 2] No such file or directory: 'data/comp-2020/Wrong/Teams.csv'";
    const out = annotateMissingPath(err, deeper);
    // Never an absolute path from this process's point of view.
    expect(out).not.toContain(ROOT + "/data");
    expect(out).toContain("  data/comp-2020/");
  });

  test("resolveBase climbs to the ancestor that holds the first segment", () => {
    const deeper = join(ROOT, "a", "b");
    mkdirSync(deeper, { recursive: true });
    expect(resolveBase("data/comp-2020/x.csv", deeper)).toBe(ROOT);
  });
});

describe("suggestions stay inside the analysis that failed", () => {
  test("a file of the same name in a NEIGHBOURING task is not suggested", () => {
    // Real case: districts_info.csv exists under task1, task2 and task3. The turn
    // was working in task3, and the first version of this hint offered all three.
    for (const t of ["task1", "task2", "task3"]) {
      const d = join(ROOT, "bench", t, "data", "learnplatform-covid19-impact-on-digital-learning");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "districts_info.csv"), t);
    }
    const err =
      "FileNotFoundError: [Errno 2] No such file or directory: " +
      "'bench/task3/data/learnplatform-covid19-impact_on_digital-learning/districts_info.csv'";
    const out = annotateMissingPath(err, ROOT);
    expect(out).toContain("bench/task3/data/learnplatform-covid19-impact-on-digital-learning/districts_info.csv");
    expect(out).not.toContain("bench/task1/");
    expect(out).not.toContain("bench/task2/");
    expect(out).toContain("does exist, at a different path"); // singular: one candidate
  });

  test("genuinely equidistant copies are BOTH kept — that ambiguity is the point", () => {
    const err =
      "FileNotFoundError: [Errno 2] No such file or directory: " +
      "'data/comp_2020/PlayByPlay_Stage2/Events2017.csv'";
    const out = annotateMissingPath(err, ROOT);
    expect(out).toContain("exists at 2 different paths");
  });
});
