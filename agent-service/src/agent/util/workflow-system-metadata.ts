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

import Ajv from "ajv";
import { fetchOperatorMetadata, type OperatorMetadata } from "../../api/backend-api";
import type { Validation } from "../../types/workflow";
import { createLogger } from "../../logger";

const log = createLogger("WorkflowSystemMetadata");

// Matches the frontend ValidationWorkflowService Ajv configuration.
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * Process-wide singleton cache of operator metadata fetched from the backend.
 *
 * Holds each operator type's JSON schema and additional metadata, and
 * exposes Ajv-backed property validation that matches the frontend's
 * `ValidationWorkflowService` configuration.
 */
export class WorkflowSystemMetadata {
  private static instance: WorkflowSystemMetadata | null = null;

  static getInstance(): WorkflowSystemMetadata {
    if (!WorkflowSystemMetadata.instance) {
      WorkflowSystemMetadata.instance = new WorkflowSystemMetadata();
    }
    return WorkflowSystemMetadata.instance;
  }

  static async initializeGlobal(): Promise<WorkflowSystemMetadata> {
    const instance = WorkflowSystemMetadata.getInstance();
    if (!instance.isInitialized()) {
      await instance.initializeFromBackend();
    }
    return instance;
  }

  private schemas: Map<string, any> = new Map();
  private additionalMetadata: Map<string, any> = new Map();
  private initialized = false;

  async initializeFromBackend(): Promise<void> {
    try {
      const metadata = await fetchOperatorMetadata();
      this.loadFromMetadata(metadata);
      this.initialized = true;
      log.info({ operatorCount: this.schemas.size }, "loaded operators from backend");
    } catch (error) {
      log.warn({ err: error }, "failed to fetch from backend");
      throw error;
    }
  }

  loadFromMetadata(metadata: OperatorMetadata): void {
    for (const op of metadata.operators) {
      this.schemas.set(op.operatorType, op.jsonSchema);
      this.additionalMetadata.set(op.operatorType, op.additionalMetadata);
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Register minimal schemas for the two operator types native operators
   * compile to (`DataLoading` and `DataProcessing`), but only for types not
   * already known. Backend-loaded metadata always wins — this is just a
   * fallback so graph edits can land operators when the Texera backend is
   * unreachable (most commonly: when a trace is imported into a fresh agent
   * service that boots without its backend cluster up).
   *
   * The seeded `additionalMetadata` gives DataLoading 0 input ports and
   * DataProcessing 1. The JSON schema accepts a `code` string and nothing
   * else — enough to construct an `OperatorPredicate` and round-trip a
   * workflow through serialization.
   *
   * **Deliberately does not flip `initialized`.** That flag means "the
   * backend's full operator catalogue is loaded" — code that gates
   * backend re-fetches off it (e.g. `TexeraAgent.initialize`) would
   * otherwise skip the real fetch on a singleton that's only been
   * pre-seeded with these two fallbacks.
   */
  seedNativeOperatorDefaults(): void {
    const seed = (type: string, friendly: string, numInputPorts: number) => {
      if (this.schemas.has(type)) return;
      this.schemas.set(type, {
        type: "object",
        properties: { code: { type: "string" } },
      });
      this.additionalMetadata.set(type, {
        userFriendlyName: friendly,
        operatorGroupName: "code",
        operatorDescription: friendly,
        inputPorts: Array.from({ length: numInputPorts }, (_, i) => ({ displayName: `input_${i}` })),
        outputPorts: [{ displayName: "" }],
        dynamicInputPorts: false,
        dynamicOutputPorts: false,
      });
    };
    seed("DataLoading", "Data Loading", 0);
    seed("DataProcessing", "Data Processing", 1);
  }

  getSchema(operatorType: string): any | undefined {
    return this.schemas.get(operatorType);
  }

  getAdditionalMetadata(operatorType: string): any | undefined {
    return this.additionalMetadata.get(operatorType);
  }

  getOperatorCount(): number {
    return this.schemas.size;
  }

  validateOperatorProperties(operatorType: string, properties: Record<string, any>): Validation {
    const schema = this.schemas.get(operatorType);
    if (!schema) {
      return { isValid: false, messages: { error: `Unknown operator type: ${operatorType}` } };
    }

    try {
      const isValid = ajv.validate(schema, properties);

      if (isValid) {
        return { isValid: true };
      }

      const messages: Record<string, string> = {};
      if (ajv.errors) {
        for (const error of ajv.errors) {
          const key = error.instancePath
            ? error.instancePath.replace(/^\//, "").replace(/\//g, ".")
            : (error.params as any)?.missingProperty || error.keyword;
          messages[key] = error.message || "Validation failed";
        }
      }
      return { isValid: false, messages };
    } catch (e) {
      return { isValid: false, messages: { error: `Validation error: ${e}` } };
    }
  }
}
