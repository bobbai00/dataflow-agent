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

import { describe, expect, test } from "bun:test";
import { formatLoaderHint, loaderRemediation } from "./loader-remediation";
import { buildLineageErrorContext, errorContext } from "./error-context";
import { graphAudit } from "./graph-audit";
import type { OperatorDecorateCtx } from "../decorator";
import type { OperatorInfo } from "../../../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../../../types/workflow";
import type { SnapshotData } from "../../../workflow-snapshot-storage";
import type { WorkflowState } from "../../../workflow-state";

/* ---- fixtures ---------------------------------------------------------- */

function op(id: string, type = "DataProcessing"): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: type,
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
  } as unknown as OperatorPredicate;
}

function info(id: string, opts: { error?: string; rows?: Record<string, unknown>[] } = {}): OperatorInfo {
  return {
    operatorID: id,
    state: opts.error ? "Failed" : "Completed",
    inputTuples: 0,
    outputTuples: opts.rows?.length ?? 0,
    totalRowCount: opts.rows?.length ?? 0,
    result: opts.rows,
    error: opts.error,
  } as unknown as OperatorInfo;
}

function snapshot(results: Record<string, OperatorInfo>, links: WorkflowContent["links"] = [], ops: string[] = []): SnapshotData {
  const m = new Map<string, { info: OperatorInfo }>();
  for (const [k, v] of Object.entries(results)) m.set(k, { info: v });
  return {
    workflow: { operators: ops.map(o => op(o)), links } as unknown as WorkflowContent,
    results: m,
  } as unknown as SnapshotData;
}

function link(src: string, tgt: string): WorkflowContent["links"][number] {
  return {
    linkID: `${src}->${tgt}`,
    source: { operatorID: src, portID: "o" },
    target: { operatorID: tgt, portID: "i" },
  } as unknown as WorkflowContent["links"][number];
}

function ctx(over: Partial<OperatorDecorateCtx> & Pick<OperatorDecorateCtx, "op" | "snapshot">): OperatorDecorateCtx {
  return {
    workflowState: {} as WorkflowState,
    allLinks: over.snapshot.workflow.links,
    info: undefined,
    isCurrent: true,
    editCount: 0,
    ...over,
  };
}

/* ---- loader-remediation (flow L2) -------------------------------------- */

describe("loader-remediation decorator", () => {
  test("formatLoaderHint maps each exception class", () => {
    expect(formatLoaderHint("UnicodeDecodeError: 'utf-8' codec can't decode")).toContain("cp1252");
    expect(formatLoaderHint("pandas.errors.ParserError: Error tokenizing data")).toContain("sep=");
    expect(formatLoaderHint("FileNotFoundError: No such file")).toContain("EXACT file path");
    expect(formatLoaderHint("ValueError: could not convert string to float")).toContain("dtype=str");
    expect(formatLoaderHint("some unrelated error")).toBeUndefined();
  });

  test("applies only on a current DataLoading op with a recognized error", () => {
    const s = snapshot({ ld: info("ld", { error: "UnicodeDecodeError: 'utf-8' codec" }) });
    expect(loaderRemediation.applies(ctx({ op: op("ld", "DataLoading"), snapshot: s, info: s.results.get("ld")!.info, isCurrent: true }))).toBe(true);
    // not current
    expect(loaderRemediation.applies(ctx({ op: op("ld", "DataLoading"), snapshot: s, info: s.results.get("ld")!.info, isCurrent: false }))).toBe(false);
    // not DataLoading
    expect(loaderRemediation.applies(ctx({ op: op("ld", "DataProcessing"), snapshot: s, info: s.results.get("ld")!.info, isCurrent: true }))).toBe(false);
    // unrecognized error
    const s2 = snapshot({ ld: info("ld", { error: "weird" }) });
    expect(loaderRemediation.applies(ctx({ op: op("ld", "DataLoading"), snapshot: s2, info: s2.results.get("ld")!.info, isCurrent: true }))).toBe(false);
  });

  test("renders the hint lines", () => {
    const s = snapshot({ ld: info("ld", { error: "FileNotFoundError: No such file" }) });
    const out = loaderRemediation.render(ctx({ op: op("ld", "DataLoading"), snapshot: s, info: s.results.get("ld")!.info, isCurrent: true }));
    expect(out.length).toBeGreaterThan(0);
    expect(out.join(" ")).toContain("EXACT file path");
  });

  test("descriptor placement is flow L2 preemptive in-result", () => {
    expect(loaderRemediation.facet).toBe("flow");
    expect(loaderRemediation.level).toBe(2);
    expect(loaderRemediation.mode).toBe("preemptive");
    expect(loaderRemediation.placement).toBe("in-result");
  });
});

/* ---- error-context (#28, flow L2) -------------------------------------- */

describe("error-context decorator", () => {
  test("builds an Inputs block from successful direct upstreams", () => {
    const s = snapshot(
      {
        up: info("up", { rows: [{ a: 1, b: "x" }, { a: 2, b: "y" }] }),
        proc: info("proc", { error: "KeyError: 'c'" }),
      },
      [link("up", "proc")]
    );
    const block = buildLineageErrorContext("proc", s, s.workflow.links);
    expect(block).toContain("Inputs (the actual data this operator consumes");
    expect(block).toContain("Input `up` (2 cols, 2 rows): a, b");
    expect(block).toContain("a\tb"); // tsv header
  });

  test("skips errored / empty upstreams; empty block ⇒ ''", () => {
    const s = snapshot(
      { up: info("up", { error: "boom" }), proc: info("proc", { error: "KeyError" }) },
      [link("up", "proc")]
    );
    expect(buildLineageErrorContext("proc", s, s.workflow.links)).toBe("");
  });

  test("filters reserved columns (__row_index__, __is_visualization__)", () => {
    const s = snapshot(
      { up: info("up", { rows: [{ __row_index__: 0, real: 9, __is_visualization__: false }] }), proc: info("proc", { error: "e" }) },
      [link("up", "proc")]
    );
    const block = buildLineageErrorContext("proc", s, s.workflow.links);
    expect(block).toContain("(1 cols, 1 rows): real");
    expect(block).not.toContain("__row_index__");
  });

  test("applies only on a current errored non-loader op", () => {
    const s = snapshot({ proc: info("proc", { error: "e" }) });
    expect(errorContext.applies(ctx({ op: op("proc", "DataProcessing"), snapshot: s, info: s.results.get("proc")!.info, isCurrent: true }))).toBe(true);
    expect(errorContext.applies(ctx({ op: op("proc", "DataLoading"), snapshot: s, info: s.results.get("proc")!.info, isCurrent: true }))).toBe(false);
    const ok = snapshot({ proc: info("proc", { rows: [{ a: 1 }] }) });
    expect(errorContext.applies(ctx({ op: op("proc"), snapshot: ok, info: ok.results.get("proc")!.info, isCurrent: true }))).toBe(false);
  });
});

/* ---- graph-audit (flow L3) --------------------------------------------- */

describe("graph-audit decorator", () => {
  function wsWithSinks(map: Record<string, string[]>): WorkflowState {
    return { getDownstreamSinks: (id: string) => map[id] ?? [] } as unknown as WorkflowState;
  }

  test("fires on a dead DataLoading op (feeds nothing) when DAG has other ops", () => {
    const s = snapshot({ ld: info("ld", { rows: [{ a: 1 }] }) }, [], ["ld", "other"]);
    const c = ctx({ op: op("ld", "DataLoading"), snapshot: s, info: s.results.get("ld")!.info, isCurrent: true, workflowState: wsWithSinks({ ld: ["ld"] }) });
    expect(graphAudit.applies(c)).toBe(true);
    expect(graphAudit.render(c).join(" ")).toContain("Graph check");
  });

  test("does NOT fire on the trivial single-op DAG", () => {
    const s = snapshot({ ld: info("ld", { rows: [{ a: 1 }] }) }, [], ["ld"]);
    const c = ctx({ op: op("ld", "DataLoading"), snapshot: s, info: s.results.get("ld")!.info, isCurrent: true, workflowState: wsWithSinks({ ld: [] }) });
    expect(graphAudit.applies(c)).toBe(false);
  });

  test("does NOT fire when the load feeds a real sink", () => {
    const s = snapshot({ ld: info("ld", { rows: [{ a: 1 }] }) }, [link("ld", "out")], ["ld", "out"]);
    const c = ctx({ op: op("ld", "DataLoading"), snapshot: s, info: s.results.get("ld")!.info, isCurrent: true, workflowState: wsWithSinks({ ld: ["out"] }) });
    expect(graphAudit.applies(c)).toBe(false);
  });

  test("placement is post-block, flow L3", () => {
    expect(graphAudit.placement).toBe("post-block");
    expect(graphAudit.level).toBe(3);
  });
});
