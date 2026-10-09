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
}

/** Dashboard/snapshot transport, not the model-facing observation renderer.
 * Keep the decoded version-bound profile, without duplicating worker envelopes. */
export function operatorInfoToSummary(info: OperatorInfo): OperatorResultSummary {
  return {
    state: info.state,
    inputTuples: info.inputTuples,
    outputTuples: info.outputTuples,
    inputPortShapes: info.inputPortShapes,
    outputColumns:
      info.resultSchema?.length ??
      (info.result && info.result.length > 0 ? getVisibleResultHeaders(info.result[0]).length : undefined),
    error: info.error,
    ...(info.nativeError ? { nativeError: info.nativeError } : {}),
    warnings: info.warnings,
    consoleLogCount: info.consoleLogs?.length,
    totalRowCount: info.totalRowCount,
    truncated: info.truncated,
    sampleRecords: info.result,
    columnStats: info.columnStats,
    ...(info.executionContext || info.resultVersion
      ? {
          resultSchema: info.resultSchema,
          executionContext: info.executionContext,
          materialization: info.materialization,
          resultVersion: info.resultVersion,
          tableProfile: info.tableProfile,
        }
      : {}),
  };
}
