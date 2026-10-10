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

import { observationFormat } from "./observation-format";
import type { AgentSettings, RetrievalSettings, RetrievalView } from "../../types/agent";
import type { NativeObservationOptions } from "./evidence";

export const RETRIEVAL_VIEWS: readonly RetrievalView[] = ["full", "sample", "sample_stats"];
export const FULL_RESULT_CHAR_LIMIT = 5000;
export const RESULT_TRANSPORT_CHAR_LIMIT = 100_000;
export const EVIDENCE_CHAR_LIMIT = 2000;

export function availableRetrievalViews(
  settings: RetrievalSettings & { dataEvidence?: boolean } = {}
): RetrievalView[] {
  return [...(settings.retrievalViews ?? ["sample_stats", "full"])] as RetrievalView[];
}

/** The same bounded materialization is retained for every view/experiment arm.
 * Reading another view never executes or changes the result's identity. */
export function nativeResultTransportLimit(_settings: RetrievalSettings): number {
  return RESULT_TRANSPORT_CHAR_LIMIT;
}

export function retrievalOptions(settings: Partial<AgentSettings>, view: RetrievalView): NativeObservationOptions {
  if (!availableRetrievalViews(settings).includes(view))
    throw new Error(
      `The view ${JSON.stringify(view)} is unavailable. Use ${availableRetrievalViews(settings).join(" or ")}.`
    );
  return {
    ...observationFormat(settings),
    view,
    data: view === "sample_stats",
    flow: settings.flowEvidence === true,
    maxChars:
      view === "full"
        ? (settings.fullResultCharLimit ?? FULL_RESULT_CHAR_LIMIT)
        : (settings.maxOperatorResultCharLimit ?? 2000),
    maxRows: view === "full" ? 0 : settings.maxResultRows,
    dataMaxChars: settings.dataEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT,
    flowMaxChars: settings.flowEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT,
  };
}

/** Options for the flow lines an execute receipt shows. They come from the
 * executed operator's own counters, not from a retrieval, so they do not
 * depend on which retrieval views the session offers. */
export function flowObservationOptions(settings: Partial<AgentSettings>): NativeObservationOptions {
  return {
    ...observationFormat(settings),
    view: "sample",
    data: false,
    flow: true,
    maxChars: settings.maxOperatorResultCharLimit ?? 2000,
    maxRows: settings.maxResultRows,
    dataMaxChars: 0,
    flowMaxChars: settings.flowEvidenceCharLimit ?? EVIDENCE_CHAR_LIMIT,
    upstream: false,
  };
}
