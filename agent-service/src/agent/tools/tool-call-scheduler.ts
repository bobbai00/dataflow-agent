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
 * Batches all tool calls the model emits in a single LLM step and runs them
 * serially in topological order.
 *
 * Background: when the Vercel AI SDK is told parallel tool calls are allowed,
 * one assistant turn can carry N tool calls. The SDK then invokes each tool's
 * `execute()` concurrently (`Promise.all`-style). For the dataflow agent this
 * is unsafe: tool call B may need an operator that tool call A is in the
 * middle of creating, and the SDK's concurrent invocation has no notion of
 * which call must precede which.
 *
 * This scheduler intercepts each tool's `execute()` so that all calls in a
 * single LLM step land in one batch (collected via a microtask flush), then
 * runs them sequentially in a Kahn-sorted order derived from each call's
 * declared dependencies:
 *
 *   - CODE-mode `createOrModifyOperator`: deps = `def process(p1, p2, …)`
 *     parameter names (operator ids of upstream ops). `def load()` has none.
 *   - GENERAL-mode `addOperator`/`modifyOperator`: deps = flatten
 *     `inputOperatorIds: Record<portIdx, string[]>`.
 *   - `deleteOperator`: no upstream deps; instead forced to run AFTER every
 *     non-delete in the same batch, so a sibling rewire doesn't observe a
 *     missing op.
 *
 * Execution-side semantics:
 *
 *   - Per-call failures are local: if A errors, an unrelated sibling C still
 *     runs. A dependent B will see its own validation surface the missing
 *     upstream — the same error it would emit if the model had sent the
 *     calls serially.
 *   - Multiple calls touching the same `operatorId` form an emission-order
 *     chain (later sees earlier's writes), so `add(A)` then `modify(A)` in
 *     the same turn behaves correctly.
 *   - Cycles within a batch are not rejected outright; cycle members run in
 *     emission order so any well-formed independent siblings still land
 *     cleanly and the cycle members get the same validation feedback they
 *     would in serial mode.
 */

export type DependencyExtractor = (toolName: string, input: any) => string[];
export type ProducedOpExtractor = (toolName: string, input: any) => string | undefined;
export type IsDeleteFn = (toolName: string) => boolean;

/**
 * Default dep extractor for the agent's known tools. Splits out so tests can
 * exercise it without spinning up the whole tool set.
 */
export function defaultParseDeps(toolName: string, input: any): string[] {
  if (!input || typeof input !== "object") return [];

  if (toolName === "createOrModifyOperator") {
    const code: unknown = (input as any).code;
    if (typeof code !== "string") return [];
    // `def process(p1, p2, ...)` → [p1, p2, ...]. `def load()` → [].
    const m = /def\s+process\s*\(([^)]*)\)/.exec(code);
    if (!m) return [];
    return m[1]
      .split(",")
      .map(s => s.split(":")[0].split("=")[0].trim())
      .filter(s => s.length > 0);
  }

  if (toolName === "addOperator" || toolName === "modifyOperator") {
    const map = (input as any).inputOperatorIds;
    if (!map || typeof map !== "object") return [];
    const out: string[] = [];
    for (const v of Object.values(map)) {
      if (Array.isArray(v)) {
        for (const id of v) if (typeof id === "string" && id.length > 0) out.push(id);
      }
    }
    return out;
  }

  return [];
}

export function defaultProducedOpId(toolName: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (
    toolName === "createOrModifyOperator" ||
    toolName === "addOperator" ||
    toolName === "modifyOperator" ||
    toolName === "deleteOperator"
  ) {
    const id = (input as any).operatorId ?? (input as any).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  }
  return undefined;
}

export function defaultIsDelete(toolName: string): boolean {
  return toolName === "deleteOperator";
}

interface ScheduledCall {
  toolName: string;
  input: any;
  options: any;
  originalExecute: (input: any, options: any) => Promise<any>;
  resolve: (result: any) => void;
  reject: (err: any) => void;
}

export interface SchedulerOptions {
  parseDeps?: DependencyExtractor;
  producedOpId?: ProducedOpExtractor;
  isDelete?: IsDeleteFn;
}

/**
 * Build a Kahn-sorted execution order for a batch of submissions.
 *
 * Edges:
 *   - dep edge from producer(opId) → consumer if consumer.deps includes opId
 *     AND the producer is in this batch.
 *   - same-op chain: if multiple submissions touch the same operatorId, each
 *     later submission depends on the previous (emission-order chain).
 *   - delete fence: every non-delete is a predecessor of every delete.
 *
 * Tie-break for ready nodes: lower batch index first (emission order).
 *
 * On cycle: remaining nodes are appended in emission order. They still get
 * executed; the validation inside each tool's `execute` will produce a
 * meaningful error per call.
 */
export function computeTopologicalOrder(batch: ScheduledCall[], opts: Required<SchedulerOptions>): number[] {
  const n = batch.length;
  if (n <= 1) return batch.map((_, i) => i);

  // Map operator id → list of batch indices that touch it (in emission order).
  // The "producer" used for resolving an external dep is the first index in
  // the list; the chain edges wire i_k+1 to depend on i_k for the same op.
  const touchesByOpId = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const opId = opts.producedOpId(batch[i].toolName, batch[i].input);
    if (opId) {
      const list = touchesByOpId.get(opId) ?? [];
      list.push(i);
      touchesByOpId.set(opId, list);
    }
  }

  const adj: number[][] = Array.from({ length: n }, () => []);
  const inDegree = new Array<number>(n).fill(0);

  const addEdge = (from: number, to: number) => {
    if (from === to) return;
    // Avoid duplicate edges (Kahn correctness needs in-degree to match).
    if (adj[from].includes(to)) return;
    adj[from].push(to);
    inDegree[to]++;
  };

  // 1) Dep edges from upstream producers in this batch.
  for (let i = 0; i < n; i++) {
    const deps = opts.parseDeps(batch[i].toolName, batch[i].input);
    for (const depOpId of deps) {
      const touches = touchesByOpId.get(depOpId);
      if (!touches) continue;
      // Use the first touch (earliest emission) as the producer for an
      // external dep. If the consumer itself is one of the touches, it must
      // come *after* the producer too — handled by the same-op chain below.
      const producerIdx = touches[0];
      if (producerIdx !== i) addEdge(producerIdx, i);
    }
  }

  // 2) Same-op chain so add(A) then modify(A) (or two modify(A)s) stay in
  //    emission order. We treat the first occurrence as the producer; every
  //    later occurrence depends on the one immediately before it.
  for (const touches of touchesByOpId.values()) {
    for (let k = 1; k < touches.length; k++) {
      addEdge(touches[k - 1], touches[k]);
    }
  }

  // 3) Delete fence: deletes go last so a sibling rewire doesn't see a hole.
  const deleteIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (opts.isDelete(batch[i].toolName)) deleteIdx.push(i);
  }
  if (deleteIdx.length > 0 && deleteIdx.length < n) {
    for (let i = 0; i < n; i++) {
      if (!opts.isDelete(batch[i].toolName)) {
        for (const dIdx of deleteIdx) addEdge(i, dIdx);
      }
    }
  }

  // Kahn's algorithm. Ready set kept sorted ascending so ties break on
  // emission order — the model's emission order is usually already a valid
  // topological order, so this keeps reordering minimal.
  const ready: number[] = [];
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0) ready.push(i);
  }
  ready.sort((a, b) => a - b);

  const order: number[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    order.push(node);
    let pushedAny = false;
    for (const next of adj[node]) {
      inDegree[next]--;
      if (inDegree[next] === 0) {
        ready.push(next);
        pushedAny = true;
      }
    }
    if (pushedAny) ready.sort((a, b) => a - b);
  }

  // Cycle (or unreachable nodes): append remaining in emission order. They
  // still execute — their own validation will surface the dependency error.
  if (order.length < n) {
    const placed = new Set(order);
    for (let i = 0; i < n; i++) {
      if (!placed.has(i)) order.push(i);
    }
  }

  return order;
}

/**
 * Wraps each tool's `execute` so all calls in one LLM step land in one batch
 * and run sequentially in topological order.
 *
 * The scheduler is stateless between batches: a batch starts on the first
 * `submit()`, accumulates further submissions during the same microtask tick
 * (the SDK fires every concurrent tool execute synchronously), then flushes
 * before any awaited result returns. After flush the scheduler is ready for
 * the next batch — one instance is fine for the agent's lifetime.
 */
export class ToolCallScheduler {
  private batch: ScheduledCall[] = [];
  private flushScheduled = false;
  private readonly opts: Required<SchedulerOptions>;

  constructor(options: SchedulerOptions = {}) {
    this.opts = {
      parseDeps: options.parseDeps ?? defaultParseDeps,
      producedOpId: options.producedOpId ?? defaultProducedOpId,
      isDelete: options.isDelete ?? defaultIsDelete,
    };
  }

  /**
   * Return a new tool object whose `execute` routes through this scheduler.
   * The original tool's other properties (description, inputSchema, …) are
   * preserved. If the tool has no `execute`, it's returned unchanged.
   */
  wrap<T extends { execute?: (input: any, options: any) => Promise<any> }>(toolName: string, t: T): T {
    const original = t.execute;
    if (!original) return t;
    const submit = (input: any, options: any) => this.submit(toolName, input, original, options);
    return new Proxy(t, {
      get: (target, prop, receiver) => {
        if (prop === "execute") return submit;
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private submit(
    toolName: string,
    input: any,
    originalExecute: (input: any, options: any) => Promise<any>,
    options: any
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      this.batch.push({ toolName, input, options, originalExecute, resolve, reject });
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.batch;
    this.batch = [];
    this.flushScheduled = false;
    if (batch.length === 0) return;

    const order = computeTopologicalOrder(batch, this.opts);

    for (const idx of order) {
      const call = batch[idx];
      try {
        const result = await call.originalExecute(call.input, call.options);
        call.resolve(result);
      } catch (e) {
        call.reject(e);
      }
    }
  }
}

/** Exposed for unit tests. */
export const __forTesting = {
  defaultParseDeps,
  defaultProducedOpId,
  defaultIsDelete,
  computeTopologicalOrder,
};
