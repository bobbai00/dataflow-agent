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

import type { OperatorPredicate, WorkflowContent } from "../../../types/workflow";
import type { OperatorInfo } from "../../../types/execution";
import type { SnapshotData } from "../../workflow-snapshot-storage";
import type { WorkflowState } from "../../workflow-state";
import type { ActionMode, DecorateFacet, DecorateLevel } from "./types";

/**
 * Everything a per-operator DECORATE rung needs, gathered once by the assembler
 * so individual decorators don't re-fish it out of the snapshot. Pure inputs —
 * a decorator MUST NOT mutate any of these.
 */
export interface OperatorDecorateCtx {
  readonly op: OperatorPredicate;
  readonly snapshot: SnapshotData;
  readonly workflowState: WorkflowState;
  /** links of the current snapshot's workflow (target←source adjacency source). */
  readonly allLinks: WorkflowContent["links"];
  /** this operator's own result/error info, if any. */
  readonly info: OperatorInfo | undefined;
  /** true on the current (last) snapshot — most error/remediation rungs are
   *  current-snapshot-only to avoid repeating across FULL-mode history. */
  readonly isCurrent: boolean;
  /** per-operatorId cumulative edit count across the visible trajectory
   *  (for the attempt-reflection rung). */
  readonly editCount: number;
}

/**
 * A DECORATE rung that appends lines to an operator's rendered block. This is
 * the runtime counterpart to the catalog descriptor in `registry.ts`: the
 * descriptor says WHERE a rung sits (facet/level/mode) and the Decorator says
 * WHAT it renders. The assembler runs every enabled decorator whose `applies`
 * is true, in registration order, and appends its lines.
 *
 * Contract:
 *   - `render` is PURE: same ctx ⇒ same output, no side effects, no mutation.
 *   - `render` returns the lines to append (already-formatted, no leading
 *     indentation — the assembler owns indentation), or [] / null for nothing.
 *   - placement controls WHERE in the operator block the lines land:
 *       "in-result"  → appended inside the `Result:` body (indented), only
 *                      when the op has an execText result block.
 *       "post-block" → appended after the result block at operator level.
 */
export interface OperatorDecorator {
  readonly id: string;
  readonly facet: DecorateFacet;
  readonly level: Exclude<DecorateLevel, 0>;
  readonly mode: ActionMode;
  readonly placement: "in-result" | "post-block";
  applies(ctx: OperatorDecorateCtx): boolean;
  render(ctx: OperatorDecorateCtx): string[];
}
