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
 * SELECT stage — history representation (see claude/CONTEXT-DESIGN.md §4).
 *
 * The agent's session is {snapshots, events}. SELECT decides HOW MUCH of that
 * history enters the context: one folded snapshot (aggregated) vs a sequence of
 * historical states (trajectory). DataFlow's distinctive affordance is that the
 * DAG is a canonical AGGREGATED state — a fold over the whole edit history into
 * one current artifact a flat-script agent has no equivalent of.
 *
 * The three context modes are points on one axis, ordered by how much history
 * they replay:
 *
 *   LATEST  — current DAG snapshot only (history folded in). The AGGREGATED pole.
 *   DELTA   — changes since the last turn. Bounded TRAJECTORY.
 *   FULL    — entire verbatim message array. Unbounded trajectory (≈ the
 *             flat-script context). Dominated on cost; kept as a reference, not
 *             a recommended operating point.
 *
 * Aggregation is LOSSY: folding history into the current DAG discards the
 * failed / superseded attempts (the rejected code variants), which is exactly
 * the thrash blind spot. The REINJECTION ladder (reinjection/*) selectively
 * recovers that dropped subset back into LATEST — movement along this axis,
 * NOT a decoration.
 */

/** Position of a mode on the aggregated↔trajectory axis (0 = fully aggregated). */
export type HistoryRepresentation = "aggregated" | "trajectory";

export interface HistoryModeDescriptor {
  /** matches ContextMode values ("latest" | "delta"). */
  mode: string;
  representation: HistoryRepresentation;
  /** ordinal on the axis: 0 aggregated → 1 bounded trajectory. */
  axisRank: 0 | 1;
  note: string;
}

export const HISTORY_MODES: readonly HistoryModeDescriptor[] = [
  {
    mode: "latest",
    representation: "aggregated",
    axisRank: 0,
    note: "current DAG snapshot, with errors inline and explicitly selected evidence",
  },
  {
    mode: "delta",
    representation: "trajectory",
    axisRank: 1,
    note: "changes since the last turn (bounded trajectory)",
  },
] as const;

export function historyModeDescriptor(mode: string): HistoryModeDescriptor | undefined {
  return HISTORY_MODES.find(m => m.mode === mode.toLowerCase());
}
