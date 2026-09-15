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

import type { OperatorInfo } from "../../types/execution";
import { NATIVE_FLOW_EVIDENCE_KEY } from "../context/decorate/data/reserved-keys";

export const FLOW_EVIDENCE_MAX_CHARS = 1000;

/** Render only valid structured telemetry, from this result's own execution.
 * The budget includes heading and annotations; independent of columnStats and
 * table sample budgets. Complete short facts precede any truncated witness. */
export function formatNativeFlowEvidence(
  info: OperatorInfo | undefined,
  maxChars = FLOW_EVIDENCE_MAX_CHARS
): string | undefined {
  if (!info || info.error || maxChars <= 0) return undefined;
  const raw = info.columnStats?.[NATIVE_FLOW_EVIDENCE_KEY];
  if (!raw || raw.length > 16_000) return undefined;
  let facts: string[] | undefined;
  try {
    const payload = JSON.parse(raw);
    if (payload?.version === 1 && Array.isArray(payload.facts)) {
      facts = payload.facts.filter((f: unknown): f is string => typeof f === "string").slice(0, 4);
    }
  } catch {
    return undefined;
  }
  if (!facts?.length) return undefined;
  const text = "Flow evidence (measured):\n" + facts.map(f => "- " + f.replace(/\s+/g, " ").trim()).join("\n");
  const suffix = " …(evidence truncated)";
  return text.length <= maxChars
    ? text
    : text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix.slice(0, maxChars);
}
