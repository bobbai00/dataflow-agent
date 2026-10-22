/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { OperatorInfo } from "../types/execution";
import type { WorkflowContent } from "../types/workflow";
import { getVisibleResultHeaders } from "../agent/tools/tools-utility";

export interface OperatorResultSummary extends Pick<
  OperatorInfo,
  | "state"
  | "inputTuples"
  | "outputTuples"
  | "inputPortShapes"
  | "error"
  | "warnings"
  | "totalRowCount"
  | "truncated"
  | "columnStats"
  | "resultSchema"
  | "executionContext"
  | "materialization"
  | "resultVersion"
  | "tableProfile"
  | "nativeError"
> {
  outputColumns?: number;
  consoleLogCount?: number;
  sampleRecords?: Record<string, any>[];
  /** The engine reused this result from cache instead of computing it. */
  cached?: true;
}

/** Dashboard/snapshot transport, not the model-facing observation renderer.
 * Keep the decoded version-bound profile, without duplicating worker envelopes. */
export function operatorInfoToSummary(info: OperatorInfo): OperatorResultSummary {
  return {
    state: info.state,
    inputTuples: info.inputTuples,
    outputTuples: info.outputTuples,
    inputPortShapes: info.inputPortShapes,
    outputColumns: columnCount(info),
    error: info.error,
    ...(info.nativeError ? { nativeError: info.nativeError } : {}),
    warnings: info.warnings,
    consoleLogCount: info.consoleLogs?.length,
    totalRowCount: info.totalRowCount,
    truncated: info.truncated,
    sampleRecords: info.result,
    columnStats: info.columnStats,
    resultSchema: info.resultSchema,
    ...(info.executionContext || info.resultVersion
      ? {
          executionContext: info.executionContext,
          materialization: info.materialization,
          resultVersion: info.resultVersion,
          tableProfile: info.tableProfile,
        }
      : {}),
  };
}

function columnCount(info: OperatorInfo): number | undefined {
  return (
    info.resultSchema?.length ??
    (info.result && info.result.length > 0 ? getVisibleResultHeaders(info.result[0]).length : undefined)
  );
}

type PortShape = NonNullable<OperatorInfo["inputPortShapes"]>[number];

const fromCache = (info: OperatorInfo): boolean =>
  info.state === "CompletedFromCache" || !!info.materialization?.cached;

/**
 * Every operator's summary at one state of the dataflow. The engine reports
 * no tuple counts for a result it reused from cache (-1 on its inputs, and on
 * an output it kept no count for); such a summary is marked `cached` and shows
 * the rows of the table it reused, and on each input the rows of the operator
 * feeding it, so a cached operator reads as the table it is, not as empty.
 */
export function operatorResultSummaries(
  results: ReadonlyMap<string, OperatorInfo>,
  workflow: Pick<WorkflowContent, "operators" | "links">
): Record<string, OperatorResultSummary> {
  /** The rows an operator's result holds, when known. */
  const rows = (operatorId: string): number | undefined => {
    const info = results.get(operatorId);
    if (!info || info.error) return undefined;
    if (info.totalRowCount !== undefined) return info.totalRowCount;
    return info.outputTuples > 0 || (info.outputTuples === 0 && !fromCache(info)) ? info.outputTuples : undefined;
  };
  const summaries: Record<string, OperatorResultSummary> = {};
  for (const [operatorId, info] of results) {
    const summary = operatorInfoToSummary(info);
    summaries[operatorId] = summary;
    if (!fromCache(info) || info.error) continue;
    summary.cached = true;
    summary.outputTuples = rows(operatorId) ?? -1;
    const operator = workflow.operators.find(op => op.operatorID === operatorId);
    const inputs: PortShape[] = [];
    for (const link of workflow.links) {
      if (link.target.operatorID !== operatorId) continue;
      const portIndex = operator?.inputPorts.findIndex(port => port.portID === link.target.portID) ?? -1;
      const input = results.get(link.source.operatorID);
      const count = rows(link.source.operatorID);
      if (portIndex >= 0 && input && count !== undefined)
        inputs.push({ portIndex, rows: count, columns: columnCount(input) ?? 0 });
    }
    inputs.sort((a, b) => a.portIndex - b.portIndex);
    if (inputs.length) {
      summary.inputPortShapes = inputs;
      summary.inputTuples = inputs.reduce((total, shape) => total + shape.rows, 0);
    }
  }
  return summaries;
}
