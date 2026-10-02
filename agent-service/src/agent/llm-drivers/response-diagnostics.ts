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

/** Bounded response provenance; stored in traces, never replayed to the model. */
export interface ResponseDiagnostics {
  finishReason: string;
  rawFinishReason?: string;
  calls: Array<{
    toolCallId: string;
    toolName?: string;
    rawChars?: number;
    rawPreview?: string;
    validJson?: boolean;
    matchesParsed: boolean | null;
    parsedChars?: number;
  }>;
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(k => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",")}}`;
  return JSON.stringify(value);
}
function redact(text: string): string {
  return text
    .replace(/("(?:api[_-]?key|token|password|secret|authorization)"\s*:\s*")[^"]*/gi, "$1[redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted]");
}
export function responseDiagnostics(
  finishReason: string,
  body: any,
  parsed: Array<{ toolCallId: string; toolName: string; input: unknown }>
): ResponseDiagnostics {
  const raw = body?.choices?.[0]?.message?.tool_calls ?? [];
  const result: ResponseDiagnostics = {
    finishReason,
    rawFinishReason: body?.choices?.[0]?.finish_reason ?? body?.stop_reason,
    calls: [],
  };
  let remaining = 4096;
  const ids = [...new Set([...raw.map((c: any) => c.id), ...parsed.map(c => c.toolCallId)])].slice(0, 8);
  for (const id of ids) {
    const source = raw.find((c: any) => c.id === id);
    const target = parsed.find(c => c.toolCallId === id);
    const args = source?.function?.arguments;
    const entry: ResponseDiagnostics["calls"][number] = {
      toolCallId: id,
      toolName: target?.toolName ?? source?.function?.name,
      matchesParsed: null,
      parsedChars: target ? (JSON.stringify(target.input)?.length ?? 0) : undefined,
    };
    if (typeof args === "string") {
      entry.rawChars = args.length;
      // Redact before clipping so a cut cannot expose part of a credential.
      entry.rawPreview = redact(args).slice(0, Math.min(2048, remaining));
      remaining -= entry.rawPreview.length;
      try {
        const decoded = JSON.parse(args);
        entry.validJson = true;
        if (target) entry.matchesParsed = canonical(decoded) === canonical(target.input);
      } catch {
        entry.validJson = false;
      }
    }
    result.calls.push(entry);
  }
  return result;
}
