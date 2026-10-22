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

import { Subject, Observable, merge, Subscription } from "rxjs";
import type {
  OperatorPredicate,
  OperatorLink,
  WorkflowContent,
  LogicalPlan,
  LogicalOperator,
  LogicalLink,
  Point,
  CommentBox,
  WorkflowSettings,
  ValidationError,
} from "../types/workflow";

export type { ValidationError, Validation } from "../types/workflow";

interface ValidationOutput {
  errors: Record<string, ValidationError>;
  workflowEmpty: boolean;
}

const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  dataTransferBatchSize: 400,
};

/**
 * In-memory logical plan the agent edits across a conversation.
 *
 * Holds operators, links, positions, comment boxes, and workflow settings,
 * and emits change events via RxJS so subscribers (auto-persist, websocket
 * broadcast) can react. Converts to/from the backend `WorkflowContent` wire
 * format and to the `LogicalPlan` shape used for compilation and execution.
 */
export class WorkflowState {
  private operators: Map<string, OperatorPredicate> = new Map();
  private links: Map<string, OperatorLink> = new Map();
  private operatorPositions: Map<string, Point> = new Map();
  private commentBoxes: CommentBox[] = [];
  private settings: WorkflowSettings = { ...DEFAULT_WORKFLOW_SETTINGS };
  private nativeNamespace: WorkflowContent["nativeNamespace"];
  private operatorsToViewResult: Set<string> = new Set();

  private operatorIdCounter: number = 0;
  private linkIdCounter: number = 0;

  /** The whole content was replaced (a dataflow edit, a checkout, an import): one change, like the others. */
  private readonly contentReplacedSubject = new Subject<void>();
  private readonly operatorAddSubject = new Subject<OperatorPredicate>();
  private readonly operatorDeleteSubject = new Subject<{ deletedOperatorID: string }>();
  private readonly operatorPropertyChangeSubject = new Subject<{ operator: OperatorPredicate }>();
  private readonly linkAddSubject = new Subject<OperatorLink>();
  private readonly linkDeleteSubject = new Subject<{ deletedLink: OperatorLink }>();
  private readonly disabledOperatorChangedSubject = new Subject<{
    newDisabled: string[];
    newEnabled: string[];
  }>();
  private readonly viewResultOperatorChangedSubject = new Subject<{
    newViewResultOps: string[];
    newUnviewResultOps: string[];
  }>();

  private validationErrors: Record<string, ValidationError> = Object.create(null);
  private workflowEmpty: boolean = true;

  private readonly validationChangedSubject = new Subject<ValidationOutput>();

  private subscriptions: Subscription[] = [];

  getWorkflowChangedStream(): Observable<unknown> {
    return merge(
      this.operatorAddSubject,
      this.operatorDeleteSubject,
      this.operatorPropertyChangeSubject,
      this.linkAddSubject,
      this.linkDeleteSubject,
      this.disabledOperatorChangedSubject,
      this.contentReplacedSubject
    );
  }

  generateOperatorId(operatorType: string): string {
    return `${operatorType}-operator-${++this.operatorIdCounter}`;
  }

  generateLinkId(): string {
    return `link-${++this.linkIdCounter}`;
  }

  addOperator(operator: OperatorPredicate, position?: Point): void {
    this.operators.set(operator.operatorID, operator);
    const defaultPosition: Point = position || {
      x: 100 + (this.operators.size - 1) * 200,
      y: 100 + (this.operators.size - 1) * 100,
    };
    this.operatorPositions.set(operator.operatorID, defaultPosition);
    this.operatorAddSubject.next(operator);
  }

  getOperator(operatorId: string): OperatorPredicate | undefined {
    return this.operators.get(operatorId);
  }

  getAllOperators(): OperatorPredicate[] {
    return Array.from(this.operators.values());
  }

  getAllEnabledOperators(): OperatorPredicate[] {
    return this.getAllOperators();
  }

  deleteOperator(operatorId: string): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;

    const linksToDelete = this.getLinksConnectedToOperator(operatorId);
    for (const link of linksToDelete) {
      this.links.delete(link.linkID);
      this.linkDeleteSubject.next({ deletedLink: link });
    }

    this.operatorsToViewResult.delete(operatorId);
    this.operatorPositions.delete(operatorId);
    const deleted = this.operators.delete(operatorId);

    if (deleted) {
      this.operatorDeleteSubject.next({ deletedOperatorID: operatorId });
    }

    return deleted;
  }

  updateOperatorProperties(operatorId: string, properties: Record<string, any>): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;

    const updatedOperator: OperatorPredicate = {
      ...operator,
      operatorProperties: { ...operator.operatorProperties, ...properties },
    };
    this.operators.set(operatorId, updatedOperator);
    this.operatorPropertyChangeSubject.next({ operator: updatedOperator });
    return true;
  }

  updateOperatorDisplayName(operatorId: string, displayName: string): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;

    const updatedOperator: OperatorPredicate = {
      ...operator,
      customDisplayName: displayName,
    };
    this.operators.set(operatorId, updatedOperator);
    this.operatorPropertyChangeSubject.next({ operator: updatedOperator });
    return true;
  }

  updateOperatorInputPorts(operatorId: string, numInputPorts: number): boolean {
    const operator = this.operators.get(operatorId);
    if (!operator) return false;

    const newInputPorts: import("../types/workflow").PortDescription[] = [];
    for (let i = 0; i < numInputPorts; i++) {
      newInputPorts.push({
        portID: `input-${i}`,
        displayName: `Input ${i}`,
        disallowMultiInputs: true,
        isDynamicPort: i > 0,
      });
    }

    const updatedOperator: OperatorPredicate = {
      ...operator,
      inputPorts: newInputPorts,
    };
    this.operators.set(operatorId, updatedOperator);
    this.operatorPropertyChangeSubject.next({ operator: updatedOperator });
    return true;
  }

  updateOperatorPosition(operatorId: string, position: Point): boolean {
    if (!this.operators.has(operatorId)) {
      return false;
    }
    this.operatorPositions.set(operatorId, position);
    return true;
  }

  getOperatorPosition(operatorId: string): Point | undefined {
    return this.operatorPositions.get(operatorId);
  }

  /**
   * Add a link, refusing shapes the engine cannot execute.
   *
   * A self-link (`X -> X`) makes the workflow cyclic; the execution service
   * rejects the ENTIRE plan with `400 Unable to process JSON`, so one bad edge
   * silently kills every later execution in the session. Measured: one such
   * link at turn 28 of a 42-turn task left 15 turns cyclic, every operator
   * rendering `(not executed)`, and the model rewriting them in a loop until
   * its step budget died (5 turns, ~$0.90 each).
   *
   * Returning false rather than throwing: callers already report link outcomes
   * to the model, and a rejected edge must leave the graph untouched.
   */
  addLink(link: OperatorLink): boolean {
    if (link.source.operatorID === link.target.operatorID) return false;
    this.links.set(link.linkID, link);
    this.linkAddSubject.next(link);
    return true;
  }

  /**
   * Would adding `source -> target` close a cycle? True when `source` is
   * already reachable FROM `target` (or they are the same operator).
   *
   * Cheap DFS over current links; used by the write path to reject a cyclic
   * wiring with a teaching error instead of shipping a plan the engine will
   * refuse wholesale.
   */
  wouldCreateCycle(sourceOperatorId: string, targetOperatorId: string): boolean {
    if (sourceOperatorId === targetOperatorId) return true;
    const downstream = new Map<string, string[]>();
    for (const l of this.links.values()) {
      const arr = downstream.get(l.source.operatorID);
      if (arr) arr.push(l.target.operatorID);
      else downstream.set(l.source.operatorID, [l.target.operatorID]);
    }
    const seen = new Set<string>();
    const stack = [targetOperatorId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === sourceOperatorId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of downstream.get(cur) ?? []) stack.push(next);
    }
    return false;
  }

  getLink(linkId: string): OperatorLink | undefined {
    return this.links.get(linkId);
  }

  getAllLinks(): OperatorLink[] {
    return Array.from(this.links.values());
  }

  deleteLink(linkId: string): boolean {
    const link = this.links.get(linkId);
    if (!link) return false;

    const deleted = this.links.delete(linkId);
    if (deleted) {
      this.linkDeleteSubject.next({ deletedLink: link });
    }
    return deleted;
  }

  getLinksConnectedToOperator(operatorId: string): OperatorLink[] {
    return this.getAllLinks().filter(
      link => link.source.operatorID === operatorId || link.target.operatorID === operatorId
    );
  }

  /**
   * The upstream closure of SEVERAL targets at once, deduplicated.
   *
   * Execution only ever needs the ancestors of the operators whose results are
   * wanted. Building that set one target at a time and unioning it keeps the
   * shipped plan proportional to the work, not to the session: a 215-operator
   * NFL workflow asked for two sibling leaves ships ~10 operators, not 215.
   *
   * This exists because the single-target `getSubDAG` was the ONLY pruning
   * path — a multi-target request fell back to the entire workflow, whose JSON
   * crossed the execution service's request limit at ~200 KB and returned
   * `400 Unable to process JSON`. Every operator in that step then rendered as
   * `(not executed)`, and the model rewrote them in a loop until the step
   * budget died (measured: 5 such turns on one task, ~$0.90 each).
   */
  getSubDAGForTargets(targetOperatorIds: readonly string[]): {
    operators: OperatorPredicate[];
    links: OperatorLink[];
  } {
    const operators: OperatorPredicate[] = [];
    const links: OperatorLink[] = [];
    const seenOps = new Set<string>();
    const seenLinks = new Set<string>();
    for (const target of targetOperatorIds) {
      const part = this.getSubDAG(target);
      for (const op of part.operators) {
        if (seenOps.has(op.operatorID)) continue;
        seenOps.add(op.operatorID);
        operators.push(op);
      }
      for (const link of part.links) {
        const key = `${link.source.operatorID}:${link.source.portID}->${link.target.operatorID}:${link.target.portID}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);
        links.push(link);
      }
    }
    return { operators, links };
  }

  getSubDAG(targetOperatorId: string): { operators: OperatorPredicate[]; links: OperatorLink[] } {
    const visited = new Set<string>();
    const subDagOperators: OperatorPredicate[] = [];
    const subDagLinks: OperatorLink[] = [];

    const dfs = (currentOperatorId: string) => {
      if (visited.has(currentOperatorId)) {
        return;
      }

      visited.add(currentOperatorId);

      const currentOperator = this.getOperator(currentOperatorId);
      if (currentOperator && !currentOperator.isDisabled) {
        subDagOperators.push(currentOperator);

        const connectedLinks = this.getAllLinks().filter(
          link => link.target.operatorID === currentOperatorId && !this.getOperator(link.source.operatorID)?.isDisabled
        );

        connectedLinks.forEach(link => {
          subDagLinks.push(link);
          dfs(link.source.operatorID);
        });
      }
    };

    dfs(targetOperatorId);

    return { operators: subDagOperators, links: subDagLinks };
  }

  /**
   * Return the set of downstream sink operators reachable from `startOpId`
   * via outgoing enabled links. A "sink" here is an enabled operator with no
   * outgoing enabled links. If `startOpId` itself has no outgoing enabled
   * links it is returned as the sole sink. Disabled operators are skipped.
   *
   * Used by post-step execution: after editing an operator, executing each
   * downstream sink causes the backend to re-run the edited op and every
   * descendant on the path to that sink.
   */
  /**
   * Every enabled operator reachable downstream of `startOpId` (excluding it).
   * NATIVE mode materializes all of these after an edit — a modified operator
   * changes every table below it, and the typed render shows each of them —
   * where code mode only re-materializes the sinks.
   */
  getDownstreamOperators(startOpId: string): string[] {
    const allLinks = this.getAllLinks();
    const visited = new Set<string>();
    const stack: string[] = [startOpId];
    while (stack.length > 0) {
      const opId = stack.pop()!;
      for (const link of allLinks) {
        if (link.source.operatorID !== opId) continue;
        const tgt = link.target.operatorID;
        if (visited.has(tgt) || this.getOperator(tgt)?.isDisabled) continue;
        visited.add(tgt);
        stack.push(tgt);
      }
    }
    visited.delete(startOpId);
    return Array.from(visited);
  }

  getDownstreamSinks(startOpId: string): string[] {
    const startOp = this.getOperator(startOpId);
    if (!startOp || startOp.isDisabled) return [];

    const allLinks = this.getAllLinks();
    const visited = new Set<string>();
    const sinks = new Set<string>();
    const stack: string[] = [startOpId];

    while (stack.length > 0) {
      const opId = stack.pop()!;
      if (visited.has(opId)) continue;
      visited.add(opId);

      const op = this.getOperator(opId);
      if (!op || op.isDisabled) continue;

      const outgoing = allLinks.filter(
        link => link.source.operatorID === opId && !this.getOperator(link.target.operatorID)?.isDisabled
      );

      if (outgoing.length === 0) {
        sinks.add(opId);
      } else {
        for (const link of outgoing) {
          if (!visited.has(link.target.operatorID)) {
            stack.push(link.target.operatorID);
          }
        }
      }
    }

    return Array.from(sinks);
  }

  getFrontierOperators(depth: number): string[] {
    const allOperators = this.getAllOperators();
    if (allOperators.length === 0) return [];

    const sourceOperatorIds = new Set<string>();
    for (const link of this.getAllLinks()) {
      sourceOperatorIds.add(link.source.operatorID);
    }

    const leaves = allOperators.filter(op => !sourceOperatorIds.has(op.operatorID)).map(op => op.operatorID);

    if (leaves.length === 0) {
      return allOperators.map(op => op.operatorID);
    }

    const frontier = new Set<string>(leaves);
    let currentLevel = new Set<string>(leaves);

    for (let d = 1; d < depth; d++) {
      const nextLevel = new Set<string>();
      for (const opId of currentLevel) {
        for (const link of this.getAllLinks()) {
          if (link.target.operatorID === opId && !frontier.has(link.source.operatorID)) {
            nextLevel.add(link.source.operatorID);
            frontier.add(link.source.operatorID);
          }
        }
      }
      if (nextLevel.size === 0) break;
      currentLevel = nextLevel;
    }

    const frontierArray = Array.from(frontier);
    const inDegree = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const opId of frontierArray) {
      inDegree.set(opId, 0);
      children.set(opId, []);
    }
    for (const link of this.getAllLinks()) {
      if (frontier.has(link.source.operatorID) && frontier.has(link.target.operatorID)) {
        children.get(link.source.operatorID)!.push(link.target.operatorID);
        inDegree.set(link.target.operatorID, (inDegree.get(link.target.operatorID) ?? 0) + 1);
      }
    }

    const queue: string[] = frontierArray.filter(opId => (inDegree.get(opId) ?? 0) === 0);
    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      for (const child of children.get(node) ?? []) {
        const newDeg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, newDeg);
        if (newDeg === 0) queue.push(child);
      }
    }

    if (sorted.length < frontierArray.length) {
      for (const opId of frontierArray) {
        if (!sorted.includes(opId)) sorted.push(opId);
      }
    }

    return sorted;
  }

  getValidationChangedStream(): Observable<ValidationOutput> {
    return this.validationChangedSubject.asObservable();
  }

  getValidationOutput(): ValidationOutput {
    return {
      errors: { ...this.validationErrors },
      workflowEmpty: this.workflowEmpty,
    };
  }

  setValidationError(operatorId: string, error: ValidationError): void {
    this.validationErrors[operatorId] = error;
    this.emitValidationChanged();
  }

  clearValidationError(operatorId: string): void {
    delete this.validationErrors[operatorId];
    this.emitValidationChanged();
  }

  setAllValidationErrors(errors: Record<string, ValidationError>): void {
    this.validationErrors = Object.assign(Object.create(null), errors);
    this.updateWorkflowEmptyState();
    this.emitValidationChanged();
  }

  private updateWorkflowEmptyState(): void {
    const operators = this.getAllOperators();
    this.workflowEmpty = operators.length === 0;

    if (!this.workflowEmpty) {
      this.workflowEmpty = operators.every(op => op.isDisabled);
    }
  }

  private emitValidationChanged(): void {
    this.validationChangedSubject.next({
      errors: { ...this.validationErrors },
      workflowEmpty: this.workflowEmpty,
    });
  }

  getWorkflowContent(): WorkflowContent {
    const positionsObj: { [key: string]: Point } = Object.fromEntries(this.operatorPositions);

    return {
      operators: this.getAllOperators(),
      operatorPositions: positionsObj,
      links: this.getAllLinks(),
      commentBoxes: [...this.commentBoxes],
      settings: { ...this.settings },
      ...(this.nativeNamespace ? { nativeNamespace: structuredClone(this.nativeNamespace) } : {}),
    };
  }

  setWorkflowContent(content: WorkflowContent): void {
    this.operators.clear();
    this.links.clear();
    this.operatorPositions.clear();

    for (const op of content.operators) {
      this.operators.set(op.operatorID, op);
    }
    for (const link of content.links) {
      this.links.set(link.linkID, link);
    }

    if (content.operatorPositions) {
      for (const [id, pos] of Object.entries(content.operatorPositions)) {
        this.operatorPositions.set(id, pos);
      }
    }

    this.commentBoxes = content.commentBoxes ? [...content.commentBoxes] : [];

    this.settings = content.settings ? { ...content.settings } : { ...DEFAULT_WORKFLOW_SETTINGS };
    this.nativeNamespace = content.nativeNamespace ? structuredClone(content.nativeNamespace) : undefined;
    this.contentReplacedSubject.next();
  }

  toLogicalPlan(targetOperatorId?: string): LogicalPlan {
    const enabledOperators = this.getAllEnabledOperators();

    const operators: LogicalOperator[] = enabledOperators.map(op => ({
      operatorID: op.operatorID,
      operatorType: op.operatorType,
      ...op.operatorProperties,
      inputPorts: op.inputPorts,
      outputPorts: op.outputPorts,
    }));

    const operatorIds = new Set(operators.map(op => op.operatorID));

    const links: LogicalLink[] = this.getAllLinks()
      .filter(link => operatorIds.has(link.source.operatorID) && operatorIds.has(link.target.operatorID))
      .map(link => {
        const sourceOp = this.getOperator(link.source.operatorID)!;
        const targetOp = this.getOperator(link.target.operatorID)!;

        const fromPortIdx = sourceOp.outputPorts.findIndex(p => p.portID === link.source.portID);
        const toPortIdx = targetOp.inputPorts.findIndex(p => p.portID === link.target.portID);

        return {
          fromOpId: link.source.operatorID,
          fromPortId: { id: fromPortIdx >= 0 ? fromPortIdx : 0, internal: false },
          toOpId: link.target.operatorID,
          toPortId: { id: toPortIdx >= 0 ? toPortIdx : 0, internal: false },
        };
      });

    return {
      operators,
      links,
      opsToViewResult: Array.from(this.operatorsToViewResult).filter(id => operatorIds.has(id)),
      opsToReuseResult: [],
    };
  }

  addSubscription(subscription: Subscription): void {
    this.subscriptions.push(subscription);
  }

  reset(): void {
    this.operators.clear();
    this.links.clear();
    this.operatorPositions.clear();
    this.commentBoxes = [];
    this.settings = { ...DEFAULT_WORKFLOW_SETTINGS };
    this.nativeNamespace = undefined;
    this.operatorsToViewResult.clear();
    this.validationErrors = Object.create(null);
    this.workflowEmpty = true;
  }

  destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    this.operatorAddSubject.complete();
    this.operatorDeleteSubject.complete();
    this.operatorPropertyChangeSubject.complete();
    this.linkAddSubject.complete();
    this.linkDeleteSubject.complete();
    this.disabledOperatorChangedSubject.complete();
    this.viewResultOperatorChangedSubject.complete();
    this.validationChangedSubject.complete();

    this.reset();
  }
}
