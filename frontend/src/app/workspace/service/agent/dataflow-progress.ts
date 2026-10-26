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
 * Following a running agent call on the canvas. The agent-service streams a
 * "progress" event for each version a `dataflow` call records: the change an
 * edit made, the operators a run computes, and every operator's result once a
 * run finished or a result was shown. The canvas plays them in order, so the
 * dataflow builds up one action at a time instead of landing all at once.
 */
import type { WorkflowContent } from "../../../common/type/workflow";
import type { OperatorLink, OperatorPredicate, Point } from "../../types/workflow-common.interface";
import type { OperatorResultSummary, VersionInfo } from "./agent.service";

/** An edit's change to the dataflow (agent-service `DataflowChange`): the
 * operators it added or changed, in full; the ones it removed; and the links
 * and positions after it. */
export interface DataflowChange {
  operators: OperatorPredicate[];
  removed: string[];
  links: OperatorLink[];
  operatorPositions: Record<string, Point>;
}

/** A "progress" event: one version a running call recorded. */
export interface DataflowProgress {
  stepId: string;
  version: VersionInfo;
  /** An edit: what it changed. */
  dataflow?: DataflowChange;
  /** A run: the operators it computes, until it finished (then `[]`). */
  running?: string[];
  /** A finished run, or a show: every operator's result at this version. */
  operatorResults?: Record<string, OperatorResultSummary>;
}

/** The Python runtime the agent's native operators name in their code instead of holding it (about 200 KB, the same in
 * every operator), as the agent sends it once per connection: `exec(<token>,` stands for `exec(<literal>,`. */
export interface NativeRuntime {
  token: string;
  literal: string;
}

/** `operators` with their code as the engine runs it, the runtime in place of its token. The canvas holds these, so
 * saving the workflow, or running it from the toolbar rather than through the agent, works as before. */
export function withNativeRuntime<T extends { operatorProperties?: Record<string, any> }>(
  operators: T[],
  runtime: NativeRuntime | undefined
): T[] {
  if (!runtime) return operators;
  const token = `exec(${runtime.token},`;
  return operators.map(op => {
    const code = op.operatorProperties?.["code"];
    if (typeof code !== "string" || !code.includes(token)) return op;
    // A function, so the "$" sequences the source may hold are not read as replacement patterns.
    const inline = code.replace(token, () => `exec(${runtime.literal},`);
    return { ...op, operatorProperties: { ...op.operatorProperties, code: inline } };
  });
}

/** `content` after `change`: its operators added or replaced, the removed ones gone, its links and positions. */
export function applyDataflowChange(content: WorkflowContent, change: DataflowChange): WorkflowContent {
  const changed = new Map(change.operators.map(op => [op.operatorID, op]));
  const removed = new Set(change.removed);
  const operators = content.operators
    .filter(op => !removed.has(op.operatorID))
    .map(op => changed.get(op.operatorID) ?? op);
  const present = new Set(operators.map(op => op.operatorID));
  operators.push(...change.operators.filter(op => !present.has(op.operatorID)));
  return { ...content, operators, links: change.links, operatorPositions: change.operatorPositions };
}

/**
 * Plays an agent's progress one frame at a time. A call that adds five
 * operators records five versions at once; applied as they arrive they would
 * land as one jump. A paced frame holds the next one back for `intervalMs`,
 * so each edit and run shows on its own; frames that only complete what was
 * shown (a snapshot, the end of a turn) follow in order without a pause.
 */
export class ProgressPlayer {
  private readonly queue: Array<{ apply: () => void; paced: boolean }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** @param onIdle runs when the last waiting frame has played. */
  constructor(
    private readonly intervalMs: number,
    private readonly onIdle: () => void = () => {}
  ) {}

  /** Play a frame after the frames before it. */
  push(apply: () => void, paced: boolean): void {
    this.queue.push({ apply, paced });
    if (this.timer === null) this.drain();
  }

  /** Play every waiting frame now: a checkout or a reconnect replaces what they would show. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const frame of this.queue.splice(0)) frame.apply();
    this.onIdle();
  }

  /** Frames are playing, or wait to. */
  get playing(): boolean {
    return this.timer !== null || this.queue.length > 0;
  }

  private drain(): void {
    while (this.queue.length) {
      const frame = this.queue.shift()!;
      frame.apply();
      if (frame.paced) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.drain();
        }, this.intervalMs);
        return;
      }
    }
    this.onIdle();
  }
}
