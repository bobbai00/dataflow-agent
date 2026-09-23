/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * The one piece of multi-task syntax in the program language:
 *
 *   original = project(at(cohort, task=2), keep=["id"])
 *
 * `at(name, task=N)` stands wherever a table is an input and means the output
 * `name` held at the end of completed task N. The parser already encodes it as
 * an ordinary call; this module turns that call into a reference and the
 * reference into the id of the runtime-owned source that serves it. Kept apart
 * from the catalog and the history so neither imports the other.
 */

import { createHash } from "node:crypto";

/** A current table by name, or a table as retained at the end of a task. */
export type TaskInput = string | { operator: string; atTask: number };

export const HISTORY_REFERENCE = "at";
export const TASK_SOURCE_PREFIX = "task_archive_";

/** Deterministic: one retained output is always served by the same source id,
 * so a statement's revision is stable and two references share one source. */
export function taskInputId(reference: Exclude<TaskInput, string>): string {
  return (
    TASK_SOURCE_PREFIX +
    createHash("sha256")
      .update(JSON.stringify({ operator: reference.operator, atTask: reference.atTask }))
      .digest("hex")
      .slice(0, 20)
  );
}

/** The program text of a reference, as the model writes it and as renders show it. */
export function historyReferenceSource(reference: Exclude<TaskInput, string>): string {
  return `${HISTORY_REFERENCE}(${reference.operator}, task=${reference.atTask})`;
}
