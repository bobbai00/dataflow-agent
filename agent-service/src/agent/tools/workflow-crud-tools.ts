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

/**
 * The context native graph edits run with, and the name of the delete tool
 * older traces carry, whose calls computeOperatorAccess reads.
 */

import { type WorkflowSystemMetadata } from "../util/workflow-system-metadata";

export interface ToolContext {
  metadataStore?: WorkflowSystemMetadata;
  settings?: {
    maxOperatorResultCharLimit?: number;
    executionTimeoutMs?: number;
    nativeProfileCollection?: boolean;
    /** Native operators carry the lineage flow evidence reads (records listed by several source files). */
    flowEvidence?: boolean;
    /** Key and null notes on executed operators (`dataHygiene`). */
    dataHygiene?: boolean;
    /** Native operators round floats in user code as pandas does (`pandasRound`). */
    pandasRound?: boolean;
    /** Edits that set an operator without a `doc` say so in the tool result. */
    operatorDoc?: boolean;
  };
}

export const TOOL_NAME_DELETE_OPERATOR = "deleteOperator";
