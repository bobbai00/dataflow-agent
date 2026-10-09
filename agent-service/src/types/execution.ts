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

import type { TableProfile } from "../agent/native/profiles";
import type { NativeErrorSummary } from "../agent/native/diagnostics";

export interface ResultVersion {
  version: 1;
  id: string;
  workflowId: number | null;
  operatorId: string;
  operatorRevision: string | null;
  definitionHash: string | null;
  subgraphHash: string | null;
  outputPort: number | null;
  executionId: string | null;
  inputs: Array<{ inputIndex: number; operatorId: string; outputPort: number; resultVersion: string | null }>;
  sourceFingerprints: Array<{ path: string; sizeBytes: number; mtimeNs: string }> | null;
  /** Complete binding, distinct from complete profile coverage or file freshness. */
  complete: boolean;
  omissions: string[];
}

interface ConsoleMessage {
  msgType: string;
  // print() output is carried in `title` (message is empty); error messages may
  // populate either field. Read whichever is non-empty.
  title?: string;
  message: string;
}

interface PortShape {
  portIndex: number;
  rows: number;
  columns: number;
}

export interface OperatorInfo {
  state: string;
  inputTuples: number;
  outputTuples: number;
  inputPortShapes?: PortShape[];
  resultMode: string;
  result?: Record<string, any>[];
  totalRowCount?: number;
  displayedRows?: number;
  truncated?: boolean;
  consoleLogs?: ConsoleMessage[];
  error?: string;
  /** Sanitized identity/repair envelope; expanded records stay in snapshot storage. */
  nativeError?: NativeErrorSummary;
  warnings?: string[];
  columnStats?: Record<string, string>;
  /** Reserved machine envelopes, separate from display-truncated columnStats. */
  resultMetadata?: Record<string, string>;
  metadataOmissions?: string[];
  numWorkers?: number;
  resultSchema?: Array<{ name: string; type: string; encoding: string }>;
  /** Execution that retrieved this response; not a claim that cached data reran. */
  executionContext?: {
    workflowId: number;
    executionId: string;
    definitionHash?: string;
    subgraphHash?: string;
    inputs?: Array<{ operatorId: string; inputPort: number; outputPort: number; executionId: string | null }>;
  };
  /** Actual producing execution (may predate retrieval); null means unknown. */
  materialization?: { outputPort: number; executionId?: string | null; cached: boolean; subdagHash?: string | null };
  resultVersion?: ResultVersion;
  tableProfile?: TableProfile & { resultVersion: string };
}

/** Agent-side wall times; waiting includes engine work and network latency.
 * These are not a disjoint engine compute/transfer/persistence breakdown. */
export interface ExecutionClientTiming {
  requestToHeadersMs: number | null;
  responseBodyDecodeMs: number | null;
  resultPreparationMs: number | null;
  snapshotStoreMs: number | null;
}

export interface SyncExecutionResult {
  clientTiming?: ExecutionClientTiming;
  success: boolean;
  state: string;
  operators: Record<string, OperatorInfo>;
  compilationErrors?: Record<string, string>;
  errors?: string[];
  executionId?: string;
  /** Actual engine call-site measurements; absent means unknown on older backends.
   * Separate from Python callback preflight and heuristic display state strings. */
  phaseMetrics?: {
    version: 1;
    compilation: "not_attempted" | "running" | "passed" | "failed";
    compilationDurationMs: number | null;
    runtimeStartAttempted: boolean;
  };
  capabilities?: string[];
  /** Producing identities for inputs whose table bodies were not requested. */
  inputMaterializations?: Record<string, NonNullable<OperatorInfo["materialization"]>>;
}

/** One actual engine request, including failed independent execution groups.
 * Null measurements mean the backend did not report them, not zero work. */
export interface ExecutionRunMetrics {
  clientTiming?: ExecutionClientTiming;
  targets: string[];
  executionId: string | null;
  success: boolean;
  state: string;
  phaseMetrics: NonNullable<SyncExecutionResult["phaseMetrics"]> | null;
}
