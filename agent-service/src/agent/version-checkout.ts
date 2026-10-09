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
 * VERSION CHECKOUT — turning `opId (turn N)` into a node you can wire to.
 *
 * The graph holds one node per operator id, so an old version is not something
 * the engine can reach: the reference names a definition that no longer exists
 * anywhere executable. Before this, the write path validated the reference and
 * then wired to the LIVE node — so `X (turn 3)` silently meant "X as it is
 * now", and `X (turn 28)` while revising `X` meant "X consumes itself", which
 * makes the workflow cyclic and takes every later execution down with it.
 *
 * Checkout closes that gap. A reference resolves to:
 *
 *   - the LIVE node, when it already IS that version (the common path, and
 *     free — no node is created, nothing re-executes); or
 *   - a PIN: a real operator `X__tN` carrying that version's exact code, whose
 *     inputs are themselves resolved from the version's recorded `inputRefs`,
 *     recursively. Old code fed today's inputs would compute a table that
 *     never existed, so the whole closure is checked out as-of-that-turn.
 *
 * Pins are immutable and deduplicated on `(operatorId, turn)`: referencing a
 * version ten times materializes one node. They are ordinary operators to the
 * engine, so a pinned closure executes exactly as it originally did — same
 * code, same static inputs.
 *
 * Self-reference stops being a special case: `X (turn 28)` while writing `X`
 * is a pin, so the wiring is `X__t28 -> X`, which is a DAG and is precisely
 * what the model meant. The cycle is not forbidden — it is unrepresentable.
 */

import type { OperatorVersionStore, VersionRef } from "./operator-version-store";
import type { WorkflowState } from "./workflow-state";
import type { OperatorLink, OperatorPredicate } from "../types/workflow";

/**
 * Pin provenance lives HERE, not in `operatorProperties`.
 *
 * `operatorProperties` is the operator's schema-validated payload: the engine
 * runs the workflow through the operator's JSON schema with
 * `additionalProperties: false`, so an internal marker stored there makes every
 * pin unexecutable —
 *
 *   Workflow validation failed: Operator panel_base__t1:
 *     - additionalProperties: must NOT have additional properties
 *
 * which is exactly what happened: pins wired correctly, then could never run,
 * and the model paid steps hand-copying them to get around it. The pin registry
 * below is the single source of truth for "is this a pin, and of what".
 */

export interface CheckoutResult {
  /** Operator id to wire from — the live node, or a pin. */
  operatorId: string;
  /** True when a pin was created or reused (i.e. this is history). */
  pinned: boolean;
}

export interface CheckoutDeps {
  workflowState: WorkflowState;
  store: OperatorVersionStore;
  /** Builds a blank operator predicate of a type (WorkflowUtilService). */
  newOperator: (operatorType: string, displayName: string) => OperatorPredicate | undefined;
}

/** `X__t3` — a Python-identifier-safe id derived from the composite key. */
export function pinIdFor(operatorId: string, turn: number): string {
  return `${operatorId}__t${turn}`;
}

export class VersionCheckout {
  /** `op@turn` -> materialized pin id. One node per version, ever. */
  private pins = new Map<string, string>();
  /** pin id -> the reference it froze, e.g. `panel_base (turn 1)`. */
  private pinLabels = new Map<string, string>();

  constructor(private deps: CheckoutDeps) {}

  /** Ids of every pin this checkout has materialized. */
  pinnedOperatorIds(): string[] {
    return [...this.pins.values()];
  }

  isPinned(operatorId: string): boolean {
    return this.pinnedLabel(operatorId) !== undefined;
  }

  /**
   * The reference a pin froze, or undefined for a live operator.
   *
   * The registry is authoritative. The id-pattern fallback covers a checkout
   * rebuilt mid-session (it is constructed lazily): `X__t3` only counts as a pin
   * when the store actually holds that version, so an operator the model happens
   * to name `foo__t2` is not mistaken for one.
   */
  pinnedLabel(operatorId: string): string | undefined {
    const known = this.pinLabels.get(operatorId);
    if (known) return known;
    const match = /^(.+)__t(\d+)$/.exec(operatorId);
    if (!match) return undefined;
    const [, base, turnText] = match;
    const turn = Number(turnText);
    if (!this.deps.store.get(base, turn)) return undefined;
    return `${base} (turn ${turn})`;
  }

  /**
   * Resolve one reference.
   *
   * `writingOperatorId` is the operator the current call is defining: a
   * reference to it always pins, because the live node is about to become a
   * DIFFERENT version and wiring to it would be the self-loop.
   */
  resolve(
    ref: VersionRef,
    writingOperatorId?: string
  ): CheckoutResult | { error: string } {
    const { workflowState, store } = this.deps;
    const live = workflowState.getOperator(ref.operatorId);
    const latest = store.latestTurnOf(ref.operatorId);

    // The live node already IS this version, and we are not about to overwrite
    // it: wire straight to it. No pin, no re-execution.
    if (live && latest === ref.turn && ref.operatorId !== writingOperatorId) {
      return { operatorId: ref.operatorId, pinned: false };
    }
    return this.materialize(ref, new Set());
  }

  /**
   * Create (or reuse) the pin for a version, checking out its inputs
   * recursively so the pinned code runs against the data it originally saw.
   */
  private materialize(ref: VersionRef, visiting: Set<string>): CheckoutResult | { error: string } {
    const key = `${ref.operatorId}@${ref.turn}`;
    const existing = this.pins.get(key);
    if (existing) return { operatorId: existing, pinned: true };

    // `inputRefs` point strictly backwards, so this cannot loop — but a
    // corrupted store must fail loudly rather than recurse forever.
    if (visiting.has(key)) {
      return { error: `version lineage for ${key} is circular — cannot check it out` };
    }
    visiting.add(key);

    const { workflowState, store, newOperator } = this.deps;
    const version = store.get(ref.operatorId, ref.turn);
    if (!version) {
      const have = store.versionsOf(ref.operatorId);
      return {
        error:
          have.length > 0
            ? `\`${ref.operatorId}\` has no version at turn ${ref.turn}. It has versions: ` +
              `${have.map(t => `${ref.operatorId} (turn ${t})`).join(", ")}.`
            : `\`${ref.operatorId}\` has no recorded versions.`,
      };
    }

    // Check out this version's own inputs first (depth-first), so the pin can
    // be wired the moment it exists.
    const sourceIds: string[] = [];
    for (const inputRef of version.inputRefs) {
      const resolved = this.resolveForPin(inputRef, ref.turn, visiting);
      if ("error" in resolved) return resolved;
      sourceIds.push(resolved.operatorId);
    }

    const pinId = pinIdFor(ref.operatorId, ref.turn);
    if (!workflowState.getOperator(pinId)) {
      const blank = newOperator(version.operatorType, `${ref.operatorId} (turn ${ref.turn})`);
      if (!blank) return { error: `cannot materialize ${key}: operator type "${version.operatorType}" unavailable` };
      workflowState.addOperator({
        ...blank,
        operatorID: pinId,
        // Properties carry ONLY what the operator's schema declares — the pin's
        // provenance goes in `pinLabels`, never here.
        operatorProperties: {
          ...blank.operatorProperties,
          code: version.code,
        },
      });
      this.pinLabels.set(pinId, `${ref.operatorId} (turn ${ref.turn})`);
      if (sourceIds.length > 1) workflowState.updateOperatorInputPorts(pinId, sourceIds.length);
      sourceIds.forEach((srcId, i) => {
        const src = workflowState.getOperator(srcId);
        if (!src) return;
        const linkID = `${srcId}-->${pinId}`;
        const link: OperatorLink = {
          linkID,
          source: { operatorID: srcId, portID: src.outputPorts[0]?.portID || "output-0" },
          target: { operatorID: pinId, portID: `input-${i}` },
        } as OperatorLink;
        workflowState.addLink(link);
      });
    }

    visiting.delete(key);
    this.pins.set(key, pinId);
    return { operatorId: pinId, pinned: true };
  }

  /**
   * Resolve an input of a pinned version. `asOf` is the pin's turn: an input
   * whose live node is still the version this one consumed can be wired
   * directly; anything since revised gets its own pin, which is what keeps the
   * checked-out closure historically faithful.
   */
  private resolveForPin(ref: VersionRef, asOf: number, visiting: Set<string>): CheckoutResult | { error: string } {
    const { workflowState, store } = this.deps;
    const live = workflowState.getOperator(ref.operatorId);
    const latest = store.latestTurnOf(ref.operatorId);
    if (live && latest === ref.turn) return { operatorId: ref.operatorId, pinned: false };
    if (store.get(ref.operatorId, ref.turn)) return this.materialize(ref, visiting);

    // The exact version was never recorded (e.g. the operator predates the
    // store). Fall back to the newest closed version at or before this pin's
    // turn — still historically ordered — and only then to the live node.
    const fallback = store.latestClosedTurnAtOrBefore(ref.operatorId, asOf);
    if (fallback !== undefined) return this.materialize({ operatorId: ref.operatorId, turn: fallback }, visiting);
    if (live) return { operatorId: ref.operatorId, pinned: false };
    return { error: `cannot resolve input \`${ref.operatorId}\` of a checked-out version` };
  }
}
