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

import { z } from "zod";

/** Query for the retained, revision-pinned diagnostic of one operator. Used by
 * the REST inspection endpoint; the model has no inspection tool (a rejected
 * edit's diagnostic travels in the dataflow receipt). */
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
