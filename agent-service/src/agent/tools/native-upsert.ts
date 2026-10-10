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

/** Ancestry facts recorded on a native operator for engine-side checks. */

import type { WorkflowState } from "../workflow-state";
import type { NativeOpView } from "../native/catalog";

/** Ancestry facts for engine-side checks: rows from several sources (a glob
 * or file-list scan, or a union) and the scans' file-name columns. */
export function nativeLineage(workflowState: WorkflowState, view: NativeOpView): NonNullable<NativeOpView["lineage"]> {
  const provenance = new Set<string>();
  let multiSource = view.type === "Union";
  const seen = new Set<string>();
  const queue = [...view.inputs];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const up = workflowState.getOperator(id)?.nativeOp;
    if (!up) continue;
    if (up.type === "Union") multiSource = true;
    if (up.type === "Scan") {
      const files = up.properties.files;
      if (Array.isArray(files) ? files.length > 1 : typeof files === "string" && /[*?[]/.test(files))
        multiSource = true;
      if (typeof up.properties.fileColumn === "string") provenance.add(up.properties.fileColumn);
    }
    queue.push(...up.inputs);
  }
  return { multiSource, provenanceColumns: [...provenance] };
}
