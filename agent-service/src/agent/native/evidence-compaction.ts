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

import type { NativeObservation } from "./evidence";

/** Structured identities, not parsing of model-facing metric sentences. */
export interface NativeColumnCount {
  column: string;
  resultVersion: string;
  scope: string;
  rows: number;
  nulls: number;
  nonnull: number;
  distinct: number | null;
}

export interface NativeUpstreamIdentity {
  operatorId: string;
  resultVersion: string;
  /** Facts included in this ancestor summary, for same-call references. */
  factIds?: string[];
  description?: string;
  scope?: string;
}

/** The memo belongs to ONE rendered event. Register a fact only once its
 * complete text is shown. A reference can never point at an unobserved output,
 * an omitted chunk, or another event. Standalone stored observations remain
 * self-contained for inspection/replay. */
export function shareNativeObservation(
  text: string,
  observation: NativeObservation,
  observerId: string,
  seen?: Map<string, string>
): string {
  if (!seen) return text;
  const candidates = new Map(observation.chunks.filter(c => c.upstream).map(c => [c.text, c.upstream!]));
  return text
    .split("\n")
    .map(line => {
      const origin = candidates.get(line);
      if (!origin) return line;
      const key = JSON.stringify([origin.operatorId, origin.resultVersion, line]);
      const earlier = seen.get(key);
      if (earlier && earlier !== observerId) {
        const reference = `${observation.version === 2 ? "- runtime stats: see" : "Flow upstream: see"} ${JSON.stringify(earlier)} above for ${JSON.stringify(origin.operatorId)}.`;
        if (reference.length < line.length) return reference;
      }
      if (!earlier) seen.set(key, observerId);
      return line;
    })
    .join("\n");
}

/** A memo is confined to one action batch. Frozen observations stay complete;
 * only the receipt uses references to facts actually printed earlier here. */
export type FlowReceiptObservation = Pick<NativeObservation, "resultVersion" | "chunks">;

export class FlowReceiptMemo {
  private readonly shown = new Map<string, string>();

  render(observation: FlowReceiptObservation, operatorId: string, location: string): string {
    const key = (id: string, version: string, fact: string) => JSON.stringify([id, version, fact]);
    return observation.chunks
      .map(chunk => {
        if (!chunk.id.startsWith("flow.") || chunk.id === "flow.omitted") return chunk.text;
        const origin = chunk.upstream;
        const version = origin?.resultVersion ?? observation.resultVersion;
        if (!version) return chunk.text; // Unknown identity never establishes equivalence.
        const id = origin?.operatorId ?? operatorId;
        const facts = origin?.factIds?.length ? origin.factIds : [chunk.id];
        // Facts already printed earlier in this receipt are not repeated, and
        // a pointer back to them would only restate the operator's definition.
        if (facts.every(fact => this.shown.has(key(id, version, fact)))) return "";
        // Ancestor summaries can contain a subset; register only named facts.
        for (const fact of facts) this.shown.set(key(id, version, fact), location);
        return chunk.text;
      })
      .filter(Boolean)
      .join("\n");
  }
}
