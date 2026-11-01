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
  Point,
  CommentBox,
  WorkflowSettings,
} from "../types/workflow";

const DEFAULT_WORKFLOW_SETTINGS: WorkflowSettings = {
  dataTransferBatchSize: 400,
};

/**
 * In-memory logical plan the agent edits across a conversation.
 *
 * Holds operators, links, positions, comment boxes, and workflow settings,
 * and emits change events via RxJS so subscribers (auto-persist, websocket
 * broadcast) can react. Converts to/from the backend `WorkflowContent` wire
 * format.
 */
export class WorkflowState {
  private operators: Map<string, OperatorPredicate> = new Map();
  private links: Map<string, OperatorLink> = new Map();
  private operatorPositions: Map<string, Point> = new Map();
  private commentBoxes: CommentBox[] = [];
  private settings: WorkflowSettings = { ...DEFAULT_WORKFLOW_SETTINGS };
  private nativeNamespace: WorkflowContent["nativeNamespace"];

  private operatorIdCounter: number = 0;

  /** The whole content was replaced (a dataflow edit, a checkout, an import): one change, like the others. */
  private readonly contentReplacedSubject = new Subject<void>();
  private readonly operatorAddSubject = new Subject<OperatorPredicate>();
  private readonly operatorDeleteSubject = new Subject<{ deletedOperatorID: string }>();
  private readonly linkAddSubject = new Subject<OperatorLink>();
  private readonly linkDeleteSubject = new Subject<{ deletedLink: OperatorLink }>();

  private subscriptions: Subscription[] = [];

  getWorkflowChangedStream(): Observable<unknown> {
    return merge(
      this.operatorAddSubject,
      this.operatorDeleteSubject,
      this.linkAddSubject,
      this.linkDeleteSubject,
      this.contentReplacedSubject
    );
  }

  generateOperatorId(operatorType: string): string {
    return `${operatorType}-operator-${++this.operatorIdCounter}`;
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

    this.operatorPositions.delete(operatorId);
    const deleted = this.operators.delete(operatorId);

    if (deleted) {
      this.operatorDeleteSubject.next({ deletedOperatorID: operatorId });
    }

    return deleted;
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
  }

  destroy(): void {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];

    this.operatorAddSubject.complete();
    this.operatorDeleteSubject.complete();
    this.linkAddSubject.complete();
    this.linkDeleteSubject.complete();

    this.reset();
  }
}
