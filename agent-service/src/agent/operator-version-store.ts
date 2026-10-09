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
 * THE OPERATOR VERSION STORE — `(operatorId, turnId)` is the identity.
 *
 * The live workflow holds exactly ONE node per `operatorID`; revising an
 * operator overwrites it. Versions therefore cannot live in the graph, and
 * before this module they did not live anywhere either — they were recomputed
 * by replaying snapshots, which made a version something you could *name* but
 * never *use*: `upstreams: ["X (turn 3)"]` was validated and then discarded,
 * wiring to whatever `X` happened to be at the time. Reads were versioned,
 * writes were not, and the uniform notation hid the difference (from us and
 * from the model — which is how an operator ended up wired to itself).
 *
 * So versions get a real home. The record is:
 *
 *     (operatorId, turnId) -> { code, type, ports, inputRefs, resultStepId }
 *
 * Two properties make it the foundation everything else stands on:
 *
 *   IMMUTABILITY. While a turn is open its entries are provisional — a
 *   re-write within the same turn replaces the entry, because the turn has not
 *   yet produced a version anyone can reference. At `closeTurn` the entries
 *   freeze permanently. A closed version is a fact; overwriting one is a bug,
 *   and the store throws rather than silently rewriting history.
 *
 *   RECORDED LINEAGE (`inputRefs`). Each version stores the composite keys it
 *   consumed AT WRITE TIME, so the version DAG is stored rather than inferred.
 *   Checking out an old version is then a lookup chain, not snapshot
 *   archaeology: to rebuild `X (turn 3)` you need what `X` read *then*, and
 *   that is exactly what this field holds.
 *
 * Written in EVERY mode (versioned or not) so the backbone is always
 * turn-tracked; only the versioned write path reads it back for wiring.
 */

/** A version's address. Same shape the catalog prints and `upstreams` carries. */
export interface VersionRef {
  operatorId: string;
  turn: number;
}

export interface OperatorVersion {
  operatorId: string;
  turn: number;
  code: string;
  operatorType: string;
  inputPorts: unknown[];
  outputPorts: unknown[];
  /** What this version consumed, as composite keys. Empty for loaders. */
  inputRefs: VersionRef[];
  /** ReAct step whose snapshot holds this version's materialized result. */
  resultStepId?: string;
  /** False once `closeTurn` has sealed it. */
  provisional: boolean;
}

const keyOf = (operatorId: string, turn: number): string => `${operatorId}@${turn}`;

export class OperatorVersionStore {
  private versions = new Map<string, OperatorVersion>();
  /** operatorId -> ascending turns holding a version of it. */
  private turnsByOp = new Map<string, number[]>();
  private closedTurns = new Set<number>();

  /**
   * Record (or, within an open turn, replace) the version an operator has at
   * `turn`. Throws when the turn is already closed: a sealed version is a
   * historical fact, and quietly rewriting one would corrupt every reference
   * that resolved against it.
   */
  recordWrite(entry: Omit<OperatorVersion, "provisional">): void {
    if (this.closedTurns.has(entry.turn)) {
      throw new Error(
        `cannot write ${keyOf(entry.operatorId, entry.turn)}: turn ${entry.turn} is closed and its versions are immutable`
      );
    }
    const k = keyOf(entry.operatorId, entry.turn);
    if (!this.versions.has(k)) {
      const turns = this.turnsByOp.get(entry.operatorId);
      if (turns) {
        turns.push(entry.turn);
        turns.sort((a, b) => a - b);
      } else {
        this.turnsByOp.set(entry.operatorId, [entry.turn]);
      }
    }
    this.versions.set(k, { ...entry, provisional: true });
  }

  /** Attach the step whose snapshot carries this version's result. */
  setResultStep(operatorId: string, turn: number, stepId: string): void {
    const v = this.versions.get(keyOf(operatorId, turn));
    if (v) v.resultStepId = stepId;
  }

  /** Seal every version written during `turn`. Idempotent. */
  closeTurn(turn: number): void {
    if (this.closedTurns.has(turn)) return;
    this.closedTurns.add(turn);
    for (const v of this.versions.values()) {
      if (v.turn === turn) v.provisional = false;
    }
  }

  isTurnClosed(turn: number): boolean {
    return this.closedTurns.has(turn);
  }

  get(operatorId: string, turn: number): OperatorVersion | undefined {
    return this.versions.get(keyOf(operatorId, turn));
  }

  has(operatorId: string, turn: number): boolean {
    return this.versions.has(keyOf(operatorId, turn));
  }

  /** Ascending turns at which `operatorId` was written. */
  versionsOf(operatorId: string): number[] {
    return [...(this.turnsByOp.get(operatorId) ?? [])];
  }

  /** Newest turn holding a version of `operatorId`, provisional included. */
  latestTurnOf(operatorId: string): number | undefined {
    const turns = this.turnsByOp.get(operatorId);
    return turns && turns.length > 0 ? turns[turns.length - 1] : undefined;
  }

  /**
   * Newest CLOSED version at or before `asOf` — what "the version this ref
   * names" means when checking out history, since an open turn's entry may
   * still change.
   */
  latestClosedTurnAtOrBefore(operatorId: string, asOf: number): number | undefined {
    const turns = this.turnsByOp.get(operatorId);
    if (!turns) return undefined;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i] <= asOf && this.closedTurns.has(turns[i])) return turns[i];
    }
    return undefined;
  }

  /** Every operator id that has at least one version. */
  operatorIds(): string[] {
    return [...this.turnsByOp.keys()];
  }

  /** Total recorded versions — diagnostics. */
  size(): number {
    return this.versions.size;
  }
}
