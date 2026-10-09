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

/** The debug endpoint takes a Python repr, not JSON. Encode the tree, never
 * replace token words inside submitted callbacks or user string literals. */
export function nativeDebugInput(tool: string, args: Record<string, unknown>): string {
  function python(value: unknown): string {
    if (value === null) return "None";
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return `[${value.map(python).join(",")}]`;
    if (typeof value === "object" && value !== null)
      return `{${Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([key, v]) => `${JSON.stringify(key)}:${python(v)}`)
        .join(",")}}`;
    throw new TypeError("Debug arguments must be JSON-compatible values");
  }
  return `Function(name=${JSON.stringify(tool)}, arguments=${JSON.stringify(python(args))})`;
}
