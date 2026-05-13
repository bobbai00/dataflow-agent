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
import { ToolCallScheduler, __forTesting } from "./tool-call-scheduler";

const { defaultParseDeps, defaultProducedOpId, defaultIsDelete, computeTopologicalOrder } = __forTesting;

/* ============================================================================
 *  Dependency extraction — recovering edges from each tool's input
 * ========================================================================= */

describe("defaultParseDeps — CODE-mode createOrModifyOperator", () => {
  test("def load() has no upstream deps", () => {
    const deps = defaultParseDeps("createOrModifyOperator", {
      operatorId: "src",
      code: "def load() -> pd.DataFrame:\n    return pd.read_csv('/x.csv')",
    });
    expect(deps).toEqual([]);
  });

  test("def process(a, b) → ['a', 'b']", () => {
    const deps = defaultParseDeps("createOrModifyOperator", {
      operatorId: "joined",
      code: "def process(a, b) -> pd.DataFrame:\n    return a.merge(b)",
    });
    expect(deps).toEqual(["a", "b"]);
  });

  test("strips type annotations and defaults", () => {
    const deps = defaultParseDeps("createOrModifyOperator", {
      operatorId: "x",
      code: "def process(users: pd.DataFrame, orders=None) -> pd.DataFrame:\n    return users",
    });
    expect(deps).toEqual(["users", "orders"]);
  });

  test("returns [] when there's no function header", () => {
    const deps = defaultParseDeps("createOrModifyOperator", {
      operatorId: "x",
      code: "x = 1\n",
    });
    expect(deps).toEqual([]);
  });
});

describe("defaultParseDeps — GENERAL-mode addOperator/modifyOperator", () => {
  test("flattens inputOperatorIds across ports preserving order", () => {
    const deps = defaultParseDeps("addOperator", {
      operatorId: "op3",
      operatorType: "HashJoin",
      inputOperatorIds: { "0": ["op1", "op2"], "1": ["op4"] },
    });
    // Order: keys iterate in insertion order in modern JS engines.
    expect(deps).toEqual(["op1", "op2", "op4"]);
  });

  test("returns [] when inputOperatorIds is absent", () => {
    const deps = defaultParseDeps("addOperator", {
      operatorId: "op1",
      operatorType: "CSVFileScan",
      properties: {},
    });
    expect(deps).toEqual([]);
  });
});

describe("defaultProducedOpId / defaultIsDelete", () => {
  test("createOrModifyOperator produces its operatorId", () => {
    expect(defaultProducedOpId("createOrModifyOperator", { operatorId: "x", code: "" })).toBe("x");
  });
  test("deleteOperator is flagged as a delete", () => {
    expect(defaultIsDelete("deleteOperator")).toBe(true);
    expect(defaultIsDelete("createOrModifyOperator")).toBe(false);
  });
});

/* ============================================================================
 *  Topological order — what the scheduler will run, in what order
 * ========================================================================= */

function mkBatch(
  calls: Array<{ toolName: string; input: any }>
): Array<{ toolName: string; input: any; options: any; originalExecute: any; resolve: any; reject: any }> {
  return calls.map(c => ({
    toolName: c.toolName,
    input: c.input,
    options: undefined,
    originalExecute: async () => "ok",
    resolve: () => {},
    reject: () => {},
  }));
}

const opts = {
  parseDeps: defaultParseDeps,
  producedOpId: defaultProducedOpId,
  isDelete: defaultIsDelete,
};

describe("computeTopologicalOrder", () => {
  test("singleton batch returns the only index", () => {
    const batch = mkBatch([{ toolName: "createOrModifyOperator", input: { operatorId: "a", code: "def load():\n  return 1" } }]);
    expect(computeTopologicalOrder(batch, opts)).toEqual([0]);
  });

  test("B-depends-on-A submitted out of order → A first, B second", () => {
    // Emission order: [B-needs-A, A-source]. Topo must flip it to [A, B].
    const batch = mkBatch([
      { toolName: "createOrModifyOperator", input: { operatorId: "b", code: "def process(a):\n  return a" } },
      { toolName: "createOrModifyOperator", input: { operatorId: "a", code: "def load():\n  return 1" } },
    ]);
    expect(computeTopologicalOrder(batch, opts)).toEqual([1, 0]);
  });

  test("multi-hop chain: C depends on B depends on A", () => {
    const batch = mkBatch([
      { toolName: "createOrModifyOperator", input: { operatorId: "c", code: "def process(b):\n  return b" } },
      { toolName: "createOrModifyOperator", input: { operatorId: "a", code: "def load():\n  return 1" } },
      { toolName: "createOrModifyOperator", input: { operatorId: "b", code: "def process(a):\n  return a" } },
    ]);
    const order = computeTopologicalOrder(batch, opts);
    // Verify A before B before C, regardless of relative emission order of unrelated nodes.
    const aPos = order.indexOf(1);
    const bPos = order.indexOf(2);
    const cPos = order.indexOf(0);
    expect(aPos).toBeLessThan(bPos);
    expect(bPos).toBeLessThan(cPos);
  });

  test("independent siblings preserve emission order", () => {
    // Two unrelated sources — no edges, ready set ties broken by emission idx.
    const batch = mkBatch([
      { toolName: "createOrModifyOperator", input: { operatorId: "src1", code: "def load():\n  return 1" } },
      { toolName: "createOrModifyOperator", input: { operatorId: "src2", code: "def load():\n  return 2" } },
    ]);
    expect(computeTopologicalOrder(batch, opts)).toEqual([0, 1]);
  });

  test("same opId appears twice → emission-order chain (add then modify)", () => {
    const batch = mkBatch([
      // add A
      { toolName: "createOrModifyOperator", input: { operatorId: "a", code: "def load():\n  return 1" } },
      // modify A (still a load operator, same id; the chain guarantees this lands after the add)
      { toolName: "createOrModifyOperator", input: { operatorId: "a", code: "def load():\n  return 2" } },
    ]);
    expect(computeTopologicalOrder(batch, opts)).toEqual([0, 1]);
  });

  test("deletes are forced to run after every non-delete in the batch", () => {
    // Emission: delete(X) first, then create(A) — the fence must push delete last.
    const batch = mkBatch([
      { toolName: "deleteOperator", input: { operatorId: "x" } },
      { toolName: "createOrModifyOperator", input: { operatorId: "a", code: "def load():\n  return 1" } },
    ]);
    const order = computeTopologicalOrder(batch, opts);
    expect(order[order.length - 1]).toBe(0); // delete is last
  });

  test("cycle within batch does not deadlock; cycle nodes appended in emission order", () => {
    // Two pretend "process" calls that reference each other. Real validation would catch
    // it; we just verify the scheduler still emits an order containing both indices.
    const batch = mkBatch([
      { toolName: "createOrModifyOperator", input: { operatorId: "a", code: "def process(b):\n  return b" } },
      { toolName: "createOrModifyOperator", input: { operatorId: "b", code: "def process(a):\n  return a" } },
    ]);
    const order = computeTopologicalOrder(batch, opts);
    expect(order.length).toBe(2);
    expect(new Set(order)).toEqual(new Set([0, 1]));
  });

  test("general-mode addOperator: B with inputOperatorIds=[A] runs after A", () => {
    const batch = mkBatch([
      {
        toolName: "addOperator",
        input: { operatorId: "op2", operatorType: "Filter", inputOperatorIds: { "0": ["op1"] } },
      },
      { toolName: "addOperator", input: { operatorId: "op1", operatorType: "CSVFileScan", properties: {} } },
    ]);
    expect(computeTopologicalOrder(batch, opts)).toEqual([1, 0]);
  });
});

/* ============================================================================
 *  End-to-end: ToolCallScheduler.wrap + submit batches a turn correctly
 * ========================================================================= */

describe("ToolCallScheduler — runtime batching and ordering", () => {
  function mkTool(name: string, execLog: string[]): any {
    return {
      description: `tool ${name}`,
      execute: async (input: any) => {
        execLog.push(`${name}:${input?.operatorId}`);
        return `ran ${input?.operatorId}`;
      },
    };
  }

  test("two concurrent submits run in topological order (out-of-order emission flipped)", async () => {
    const log: string[] = [];
    const scheduler = new ToolCallScheduler();
    const tool = scheduler.wrap("createOrModifyOperator", mkTool("createOrModifyOperator", log));

    // Mimic the SDK firing both executes synchronously, then awaiting Promise.all.
    const pB = (tool.execute as any)(
      { operatorId: "b", code: "def process(a):\n  return a" },
      {}
    );
    const pA = (tool.execute as any)(
      { operatorId: "a", code: "def load():\n  return 1" },
      {}
    );
    const [rB, rA] = await Promise.all([pB, pA]);
    expect(rA).toBe("ran a");
    expect(rB).toBe("ran b");
    expect(log).toEqual(["createOrModifyOperator:a", "createOrModifyOperator:b"]);
  });

  test("batch runs serially even when individual executes have async delays", async () => {
    // If both ran in parallel, the order would interleave by completion time. Scheduler
    // must await each before starting the next.
    const log: string[] = [];
    const scheduler = new ToolCallScheduler();
    const tool = {
      description: "t",
      execute: async (input: any) => {
        log.push(`start:${input.operatorId}`);
        // Different delays to make a parallel-execution interleaving visible.
        await new Promise(r => setTimeout(r, input.operatorId === "a" ? 30 : 5));
        log.push(`end:${input.operatorId}`);
        return "ok";
      },
    };
    const wrapped = scheduler.wrap("createOrModifyOperator", tool);
    const pB = (wrapped.execute as any)(
      { operatorId: "b", code: "def process(a):\n  return a" },
      {}
    );
    const pA = (wrapped.execute as any)(
      { operatorId: "a", code: "def load():\n  return 1" },
      {}
    );
    await Promise.all([pA, pB]);
    // Expected serial-in-topo order: a fully completes, then b.
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  test("a failed sibling does not block the others — both promises settle", async () => {
    const log: string[] = [];
    const scheduler = new ToolCallScheduler();
    const tool = {
      description: "t",
      execute: async (input: any) => {
        log.push(input.operatorId);
        if (input.operatorId === "a") throw new Error("boom");
        return "ok";
      },
    };
    const wrapped = scheduler.wrap("createOrModifyOperator", tool);
    const pA = (wrapped.execute as any)({ operatorId: "a", code: "def load():\n  return 1" }, {});
    const pIndependent = (wrapped.execute as any)({ operatorId: "c", code: "def load():\n  return 3" }, {});

    const results = await Promise.allSettled([pA, pIndependent]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    // A still ran, and so did C.
    expect(log).toContain("a");
    expect(log).toContain("c");
  });

  test("two successive batches (steps) are independent — second batch isn't poisoned by first", async () => {
    const log: string[] = [];
    const scheduler = new ToolCallScheduler();
    const tool = scheduler.wrap("createOrModifyOperator", {
      description: "t",
      execute: async (input: any) => {
        log.push(input.operatorId);
        return "ok";
      },
    });

    // Step 1
    await Promise.all([
      (tool.execute as any)({ operatorId: "a", code: "def load():\n  return 1" }, {}),
      (tool.execute as any)({ operatorId: "b", code: "def process(a):\n  return a" }, {}),
    ]);
    // Step 2 (fresh batch — scheduler state must have reset on flush)
    await Promise.all([
      (tool.execute as any)({ operatorId: "x", code: "def load():\n  return 9" }, {}),
      (tool.execute as any)({ operatorId: "y", code: "def process(x):\n  return x" }, {}),
    ]);
    expect(log).toEqual(["a", "b", "x", "y"]);
  });
});
