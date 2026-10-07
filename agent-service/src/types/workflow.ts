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

interface LogicalPort {
  readonly operatorID: string;
  readonly portID: string;
}

interface PortIdentity {
  readonly id: number;
  readonly internal: boolean;
}

type PartitionInfo =
  | { readonly type: "hash"; readonly hashAttributeNames: string[] }
  | {
      readonly type: "range";
      readonly rangeAttributeNames: string[];
      readonly rangeMin: number;
      readonly rangeMax: number;
    }
  | { readonly type: "single" }
  | { readonly type: "broadcast" }
  | { readonly type: "none" };

export interface PortDescription {
  readonly portID: string;
  readonly displayName?: string;
  readonly disallowMultiInputs?: boolean;
  readonly isDynamicPort?: boolean;
  readonly partitionRequirement?: PartitionInfo;
  readonly dependencies?: { id: number; internal: boolean }[];
}

export interface OperatorPredicate {
  /** Internal immutable input handle. The engine resolves its exact producer;
   * this is not an executable copy of the historical definition. */
  readonly savedResult?: {
    taskId: number;
    stepId: string;
    operatorId: string;
    executionId: string;
    outputPort: number;
    resultVersion?: string;
  };
  /** Provenance of a copied historical definition. Saved observations keep
   * their original identity; they are not a materialization of this new ID. */
  readonly stateOrigin?: { taskId: number; stepId: string; operatorId: string; subgraphHash: string };
  readonly operatorID: string;
  readonly operatorType: string;
  readonly operatorVersion: string;
  readonly operatorProperties: Record<string, any>;
  readonly inputPorts: PortDescription[];
  readonly outputPorts: PortDescription[];
  readonly dynamicInputPorts?: boolean;
  readonly dynamicOutputPorts?: boolean;
  readonly showAdvanced: boolean;
  readonly isDisabled?: boolean;
  readonly viewResult?: boolean;
  readonly markedForReuse?: boolean;
  readonly customDisplayName?: string;
  /**
   * NATIVE mode: the typed view of an operator the service compiled from
   * parameters (`type`, `properties`, ordered `inputs`). The engine only ever
   * sees the generated `code` in `operatorProperties`; this field is for the
   * renderer and result selection, and is never forwarded in execution payloads.
   */
  readonly nativeOp?: {
    type: string;
    properties: Record<string, unknown>;
    inputs: string[];
    /** Public graph ports in logical input order. */
    graph?: { inputPorts: string[] };
    revision?: string;
    profileCollection?: boolean;
    /** The assignment as the model wrote it (`x = filter(...)`). */
    source?: string;
    /** Top-level `def` sources the statement refers to, by name. */
    functions?: Record<string, string>;
    /** A shared-function call's settings with defaults filled in. */
    settings?: Record<string, unknown>;
    /** Set on the steps a variant copied; see `VariantInfo` in the native catalog. */
    variant?: {
      name: string;
      step: string;
      of?: string;
      changes?: Array<{ step: string; settings?: Record<string, unknown>; definition?: string }>;
    };
  };
}

export interface LogicalOperator {
  readonly operatorID: string;
  readonly operatorType: string;
  readonly [key: string]: any;
}

export interface OperatorLink {
  readonly linkID: string;
  readonly source: LogicalPort;
  readonly target: LogicalPort;
}

export interface LogicalLink {
  readonly fromOpId: string;
  readonly fromPortId: PortIdentity;
  readonly toOpId: string;
  readonly toPortId: PortIdentity;
}

export interface LogicalPlan {
  readonly operators: LogicalOperator[];
  readonly links: LogicalLink[];
  readonly opsToViewResult?: string[];
  readonly opsToReuseResult?: string[];
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CommentBox {
  readonly commentBoxID: string;
  readonly comments: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WorkflowSettings {
  readonly dataTransferBatchSize: number;
}

export interface WorkflowContent {
  readonly operators: OperatorPredicate[];
  readonly operatorPositions: { [key: string]: Point };
  readonly links: OperatorLink[];
  readonly commentBoxes: CommentBox[];
  readonly settings: WorkflowSettings;
}

type AttributeType = "string" | "integer" | "double" | "boolean" | "long" | "timestamp" | "binary";

export interface SchemaAttribute {
  readonly attributeName: string;
  readonly attributeType: AttributeType;
}

export type PortSchema = readonly SchemaAttribute[];

export type OperatorPortSchemaMap = Record<string, PortSchema | undefined>;

export interface OperatorDetail {
  operatorId: string;
  operatorType: string;
  customDisplayName?: string;
  operatorProperties: Record<string, any>;
  inputPorts: PortDescription[];
  outputPorts: PortDescription[];
}

export type ValidationError = {
  isValid: false;
  messages: Record<string, string>;
};

export type Validation = { isValid: true } | ValidationError;
