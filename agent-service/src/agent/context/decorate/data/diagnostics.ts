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

import type { OperatorInfo } from "../../../../types/execution";
import { JOIN_TELEMETRY_KEY } from "./reserved-keys";

/**
 * Worker-published operator-level diagnostics (post-hoc). The amber worker ships
 * these under reserved `columnStats` keys (it has the input frames + join keys
 * via transparent pandas instrumentation); these functions only render. The
 * worker joins multiple diagnostics with " || "; we render one per line.
 *
 *   - join telemetry  (flow L3): degenerate joins (near-zero key match, m:n)
 *   - coercion telemetry (data L3): to_numeric/to_datetime(coerce) NaN dataloss
 */

/** Render a reserved operator-level diagnostic shipped under `key` on
 *  columnStats (one diagnostic per line). Returns undefined when absent. */
export function formatReservedDiag(opInfo: OperatorInfo, key: string): string | undefined {
  const v = opInfo.columnStats?.[key];
  if (typeof v !== "string" || v.length === 0) return undefined;
  return v.split(" || ").map(s => s.trim()).filter(Boolean).join("\n");
}

export function formatJoinTelemetry(opInfo: OperatorInfo): string | undefined {
  return formatReservedDiag(opInfo, JOIN_TELEMETRY_KEY);
}
