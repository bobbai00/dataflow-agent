/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import type { TaskInput } from "./task-history";

/** One intermediate table a UDF assigned and did not return, as the runtime
 * reported it: the author's own variable name, its row count and schema. */
export interface KeptFrame {
  name: string;
  rows: number;
  columns: Array<{ name: string; dtype: string }>;
  more?: number;
}

/** `{operator, frame}` reads the frame as the UDF computes it now and follows
 * later edits; `{operator, atTask, frame}` replays the UDF as sealed at that
 * task, over its inputs as retained then. */
export interface FrameReference {
  operator: string;
  frame: string;
  atTask?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The kept frames of a successful UDF result, from the engine's table
 * profile of exactly this result version; anything else is no frames. */
export function keptFramesOf(info?: OperatorInfo): KeptFrame[] {
  const profile = info?.tableProfile;
  if (!info || info.error || !profile || profile.status === "unavailable") return [];
  if (!info.resultVersion?.id || profile.resultVersion !== info.resultVersion.id) return [];
  const raw = (profile.native?.operations as Record<string, unknown> | undefined)?.keptFrames;
  if (!Array.isArray(raw)) return [];
  const frames: KeptFrame[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !IDENTIFIER.test(record.name)) continue;
    if (!Number.isSafeInteger(record.rows) || (record.rows as number) < 0) continue;
    if (!Array.isArray(record.columns)) continue;
    const columns = record.columns.flatMap(column =>
      column && typeof column === "object" && typeof (column as any).name === "string"
        ? [{ name: String((column as any).name), dtype: String((column as any).dtype ?? "") }]
        : []
    );
    frames.push({
      name: record.name,
      rows: record.rows as number,
      columns,
      ...(Number.isSafeInteger(record.more) && (record.more as number) > 0 ? { more: record.more as number } : {}),
    });
  }
  return frames;
}

/** `w(86×22: player, team, side, …+19), pm(10×4: player, team, side, rank)` */
export function formatKeptFrames(frames: KeptFrame[], columnsShown = 6): string {
  return frames
    .map(frame => {
      const names = frame.columns.map(column => column.name);
      const total = frame.columns.length + (frame.more ?? 0);
      const shown = names.slice(0, columnsShown).join(",");
      const rest = total - Math.min(names.length, columnsShown);
      return `${frame.name}(${frame.rows}×${total}: ${shown}${rest > 0 ? `, …+${rest}` : ""})`;
    })
    .join("; ");
}

/** A frame reference in an input slot, or undefined for any other value. */
export function parseFrameReference(value: unknown): FrameReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.frame !== "string") return undefined;
  const keys = Object.keys(record).sort().join();
  if (keys !== "frame,operator" && keys !== "atTask,frame,operator") return undefined;
  if (typeof record.operator !== "string" || !IDENTIFIER.test(record.operator)) return undefined;
  if (!IDENTIFIER.test(record.frame)) return undefined;
  if (record.atTask !== undefined && (!Number.isSafeInteger(record.atTask) || (record.atTask as number) < 1))
    return undefined;
  return {
    operator: record.operator,
    frame: record.frame,
    ...(record.atTask !== undefined ? { atTask: record.atTask as number } : {}),
  };
}

/** Whether a value looks like a frame reference at all, valid or not. */
export function mentionsFrame(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && "frame" in (value as object);
}

/** The id of the derived view operator: readable, deterministic, and
 * distinct from anything the model would write for its own operators. */
export function frameViewId(reference: FrameReference): string {
  return `${reference.operator}__${reference.frame}${reference.atTask ? `__at${reference.atTask}` : ""}`;
}

/** The `udf` spec of the view: the parent's code and inputs, returning the
 * named local. For a replay the parent is its sealed predicate and every live
 * input becomes that input's retained output at the same task. */
export function frameViewSpec(reference: FrameReference, parent: OperatorPredicate): Record<string, unknown> {
  const view = parent.nativeOp;
  if (!view || view.type !== "UDF")
    throw new Error(`${reference.operator} is not a udf; only udf locals are kept as frames.`);
  const inputs = (view.taskInputs ?? view.inputs ?? []) as TaskInput[];
  const replayed = reference.atTask
    ? inputs.map(input => (typeof input === "string" ? { operator: input, atTask: reference.atTask! } : input))
    : inputs;
  return {
    op: "udf",
    id: frameViewId(reference),
    inputs: replayed,
    code: String(view.properties.code ?? ""),
    frame: reference.frame,
  };
}

/** Every input slot of a spec, with a setter, so references can be rewritten
 * in place regardless of the operator's arity. */
export function inputSlots(params: Record<string, unknown>): Array<{ get(): unknown; set(value: unknown): void }> {
  const slots: Array<{ get(): unknown; set(value: unknown): void }> = [];
  for (const key of ["input", "left", "right"]) {
    if (key in params) slots.push({ get: () => params[key], set: value => (params[key] = value) });
  }
  if (Array.isArray(params.inputs)) {
    const list = params.inputs as unknown[];
    list.forEach((_, index) => slots.push({ get: () => list[index], set: value => (list[index] = value) }));
  }
  return slots;
}
