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

export interface NativeDiagnostic {
  version: 1;
  operatorId: string;
  operatorRevision: string;
  code: string;
  stage: "validate" | "compile" | "execute" | "contract";
  message: string;
  field?: string;
  source?: { entry: string; line: number; column?: number; excerpt: string };
}

/** Decode the runtime's machine payload in the engine error channel, not a
 * rendered display string. Ignore incomplete/unrecognized payloads and retain
 * the raw error. Quoted/escaped user braces must not terminate the object. */
export function parseNativeDiagnostic(error: string): NativeDiagnostic | undefined {
  const marker = "NATIVE_ERROR_V2:";
  let offset = 0;
  for (;;) {
    const start = error.indexOf(marker, offset);
    if (start < 0) return undefined;
    const begin = start + marker.length;
    offset = begin;
    if (error[begin] !== "{") continue;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let end = begin; end < Math.min(error.length, begin + 4096); end++) {
      const character = error[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        try {
          const value = JSON.parse(error.slice(begin, end + 1));
          if (
            value.version !== 1 ||
            typeof value.operatorId !== "string" ||
            typeof value.operatorRevision !== "string" ||
            typeof value.code !== "string" ||
            typeof value.message !== "string" ||
            !["validate", "compile", "execute", "contract"].includes(value.stage)
          )
            break;
          if (value.field !== undefined && typeof value.field !== "string") break;
          if (
            value.source !== undefined &&
            (!value.source ||
              typeof value.source.entry !== "string" ||
              !Number.isSafeInteger(value.source.line) ||
              value.source.line < 1 ||
              typeof value.source.excerpt !== "string" ||
              (value.source.column !== undefined &&
                (!Number.isSafeInteger(value.source.column) || value.source.column < 0)))
          )
            break;
          return value as NativeDiagnostic;
        } catch {
          break;
        }
      }
    }
  }
}

export function formatNativeDiagnostic(diagnostic: NativeDiagnostic): string {
  const where = diagnostic.source ? `; ${diagnostic.source.entry} line ${diagnostic.source.line}` : "";
  const field = diagnostic.field ? `; ${diagnostic.field}` : "";
  const excerpt = diagnostic.source?.excerpt ? `\n  ${diagnostic.source.excerpt.trim().slice(0, 180)}` : "";
  return `[${diagnostic.code}; ${diagnostic.stage}; revision ${diagnostic.operatorRevision}${field}${where}] ${diagnostic.message}${excerpt}`;
}
