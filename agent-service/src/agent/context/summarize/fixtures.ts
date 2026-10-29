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
 * Test-only fixtures for the context renderer: builders for operators,
 * workflows, steps and results, and the text the renderer produces for a
 * scenario (`renderText`).
 */

import { WorkflowSnapshotStorage } from "../../workflow-snapshot-storage";
import { WorkflowState } from "../../workflow-state";
import type { ReActStep } from "../../../types/agent";
import type { OperatorInfo } from "../../../types/execution";
import type { OperatorPredicate, PortDescription, WorkflowContent } from "../../../types/workflow";
import { renderContextCore, type AssembleContextOptions } from "../../util/context-utils";

export interface OpSpec {
  id: string;
  type?: string;
  properties?: Record<string, any>;
  numInputPorts?: number;
  displayName?: string;
}

export function makeOp(spec: OpSpec): OperatorPredicate {
  const numIn = spec.numInputPorts ?? 0;
  const inputPorts: PortDescription[] = Array.from({ length: numIn }, (_, i) => ({
    portID: `input-${i}`,
    displayName: `Input ${i}`,
    disallowMultiInputs: true,
    isDynamicPort: i > 0,
  }));
  return {
    operatorID: spec.id,
    operatorType: spec.type ?? "TestOp",
    operatorVersion: "1",
    operatorProperties: spec.properties ?? {},
    inputPorts,
    outputPorts: [{ portID: "output-0", displayName: "Output" }],
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: spec.displayName ?? spec.id,
  } as OperatorPredicate;
}

export function makeWorkflow(ops: OpSpec[], links: Array<[string, string, number?]> = []): WorkflowContent {
  return {
    operators: ops.map(makeOp),
    operatorPositions: {},
    links: links.map(([s, t, port]) => ({
      linkID: `${s}-->${t}`,
      source: { operatorID: s, portID: "output-0" },
      target: { operatorID: t, portID: `input-${port ?? 0}` },
    })),
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

export function makeStep(overrides: Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">): ReActStep {
  return {
    messageId: "msg-default",
    parentId: undefined,
    timestamp: 1,
    content: "",
    isBegin: true,
    isEnd: true,
    ...overrides,
  };
}

export interface Scenario {
  steps: ReActStep[];
  storage: WorkflowSnapshotStorage;
  workflowState: WorkflowState;
}

/** Mirror of TexeraAgent.getAncestorPath over the fixture's step list. */
export function buildScenario(
  stepsInput: Array<Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">>
): Scenario {
  const steps = stepsInput.map(s => makeStep(s));
  const byId = new Map(steps.map(s => [s.id, s]));
  const storage = new WorkflowSnapshotStorage(stepId => {
    const chain: string[] = [];
    let cur: string | undefined = stepId;
    while (cur) {
      chain.unshift(cur);
      cur = byId.get(cur)?.parentId;
    }
    return chain;
  });
  return { steps, storage, workflowState: new WorkflowState() };
}

export function makeInfo(
  rows: number,
  extra: Partial<OperatorInfo> & { sampleRows?: Record<string, any>[] } = {}
): OperatorInfo {
  const { sampleRows, ...rest } = extra;
  return {
    state: rest.error ? "Failed" : "Completed",
    inputTuples: 0,
    outputTuples: rows,
    resultMode: "table",
    totalRowCount: rows,
    result: rest.error
      ? undefined
      : (sampleRows ?? Array.from({ length: Math.min(rows, 3) }, (_, i) => ({ id: i + 1, value: `v${i}` }))),
    ...rest,
  } as OperatorInfo;
}

/** What the renderer produces for `options`, before the transcript frames it. */
export function renderText(scenario: Scenario, options: AssembleContextOptions = {}): string {
  const { steps, storage, workflowState } = scenario;
  return renderContextCore(steps, workflowState, storage, options);
}
