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

import { tool } from "ai";
import { z } from "zod";
import type { NativeErrorQuery } from "../native/diagnostics";

export const TOOL_NAME_INSPECT_ERROR = "inspectError";
export const inspectErrorSchema = z
  .object({
    operatorId: z.string().min(1).describe("Operator that owns the diagnostic."),
    revision: z
      .string()
      .min(1)
      .optional()
      .describe("Exact failed revision; searches retained events on the active branch."),
    diagnosticId: z
      .string()
      .min(1)
      .optional()
      .describe("Exact diagnostic ID from an error receipt; disambiguates repeated executions."),
  })
  .strict();

/** The closure is scoped to one agent's retained records, not a global lookup.
 * External API callers authenticate separately; the model cannot choose an
 * agent ID, credentials, files, log paths or an unbounded detail budget. */
export function createInspectErrorTool(inspect: (query: NativeErrorQuery) => { text: string }) {
  return tool({
    description:
      "Inspect a retained, revision-pinned V2 operator error with bounded submitted-source context and repair details. " +
      "Read-only: no execution, workflow edit or successful table output. With only operatorId, reads the current failure; " +
      "after repair use revision or diagnosticId for a historical error. Missing/pruned records are unavailable, not reconstructed from current code.",
    inputSchema: inspectErrorSchema,
    execute: async (input: NativeErrorQuery) => inspect(inspectErrorSchema.parse(input)).text,
  });
}
