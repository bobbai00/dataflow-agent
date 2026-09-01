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

import { describe, expect, test } from "bun:test";
import { buildGeneralModeSystemPrompt, ML_OPERATOR_TYPE_PATTERN } from "./prompts";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { DEFAULT_AGENT_SETTINGS } from "../types/agent";

/** Minimal metadata store: every type gets a one-property schema. */
function metadataWith(types: string[]): WorkflowSystemMetadata {
  const store = new WorkflowSystemMetadata();
  store.loadFromMetadata({
    operators: types.map(operatorType => ({
      operatorType,
      jsonSchema: { type: "object", properties: { code: { type: "string" } }, required: [] },
      additionalMetadata: { userFriendlyName: operatorType, operatorDescription: `${operatorType} op` },
    })),
    groups: [],
  } as any);
  return store;
}

const ALL = [
  "CSVFileScan",
  "Filter",
  "Aggregate",
  "HashJoin",
  "PythonUDFV2",
  "PythonUDFSourceV2",
  "DataLoading",
  "DataProcessing",
  "RUDF",
];

describe("GENERAL-mode system prompt", () => {
  test("default allowlist is exactly relational + visualization + DataProcessing", () => {
    const allowed = DEFAULT_AGENT_SETTINGS.allowedOperatorTypes;
    // Relational ETL + the charts + the one Python escape hatch.
    for (const t of ["CSVFileScan", "Filter", "Projection", "HashJoin", "Aggregate", "Limit", "Union"]) {
      expect(allowed).toContain(t);
    }
    for (const t of ["BarChart", "LineChart", "PieChart", "Histogram", "Scatterplot"]) {
      expect(allowed).toContain(t);
    }
    expect(allowed).toContain("DataProcessing");
    // No sklearn / Split: model work happens inside DataProcessing.
    expect(allowed.filter(t => ML_OPERATOR_TYPE_PATTERN.test(t))).toEqual([]);
    // The other Python operators are opt-in, not default.
    for (const t of ["PythonUDFV2", "PythonUDFSourceV2", "DataLoading", "RUDF"]) {
      expect(allowed).not.toContain(t);
    }
  });

  test("routes each step to a family: relational for ETL, DataProcessing for custom logic/ML, charts for viz", () => {
    const prompt = buildGeneralModeSystemPrompt(metadataWith(ALL), DEFAULT_AGENT_SETTINGS.allowedOperatorTypes);
    expect(prompt).toContain("**Pick the operator family that matches the step**");
    expect(prompt).toContain("for all straightforward data ETL");
    expect(prompt).toContain("for all visualization");
    expect(prompt).toContain("for custom logic and for machine learning");
    // With no sklearn operators, the model is built inside the Python operator.
    expect(prompt).toContain("### Machine learning inside `DataProcessing`");
    expect(prompt).toContain("train_test_split");
    // Never advertises an operator that is not allowed.
    for (const t of ["PythonUDFSourceV2", "DataLoading", "`RUDF`"]) {
      expect(prompt).not.toContain(t);
    }
  });

  test("states the runtime-schema constraint: nothing native may follow a DataProcessing", () => {
    const prompt = buildGeneralModeSystemPrompt(metadataWith(ALL), DEFAULT_AGENT_SETTINGS.allowedOperatorTypes);
    expect(prompt).toContain("schema is not available");
    expect(prompt).toContain("Only Python operators (`DataProcessing`) may consume the output of a `DataProcessing`");
    expect(prompt).toContain("nothing native (relational or chart) may be linked downstream of it");
    // With PythonUDFV2 also allowed, it is named as a legal consumer.
    const withUdf = buildGeneralModeSystemPrompt(metadataWith(ALL), ["Filter", "DataProcessing", "PythonUDFV2"]);
    expect(withUdf).toContain("Only Python operators (`DataProcessing`, `PythonUDFV2`) may consume");
    expect(buildGeneralModeSystemPrompt(metadataWith(ALL), [])).toContain("### Source API (`PythonUDFSourceV2`)");
  });

  test("lists every allowed operator's schema and nothing else", () => {
    const prompt = buildGeneralModeSystemPrompt(metadataWith(ALL), DEFAULT_AGENT_SETTINGS.allowedOperatorTypes);
    for (const t of ["## Filter", "## Aggregate", "## HashJoin", "## DataProcessing"]) {
      expect(prompt).toContain(t);
    }
    // Not allowed → not listed.
    for (const t of ["## RUDF", "## PythonUDFV2", "## DataLoading"]) {
      expect(prompt).not.toContain(t);
    }
  });

  test("speaks GENERAL-mode tool names, never the CODE-mode tool", () => {
    const prompt = buildGeneralModeSystemPrompt(metadataWith(ALL), []);
    expect(prompt).not.toContain("createOrModifyOperator");
    expect(prompt).toContain("modifyOperator");
    // Native-operator guidance names operators that actually exist.
    expect(prompt).not.toContain("TableAggregate");
    expect(prompt).toContain("`Aggregate`");
    expect(prompt).toContain("`HashJoin`");
    // Multi-output wiring syntax is documented where the tools are described.
    expect(prompt).toContain('{"0": ["op9:1"]}');
    // Dataset paths go to CSVFileScan; derived columns to PythonUDFV2 when it is allowed.
    expect(prompt).toContain("never `pd.read_csv` them");
    expect(prompt).toContain("NOT in a `DataProcessing`");
  });

  test("appends the ML guide only when an sklearn operator is allowed", () => {
    const withMl = buildGeneralModeSystemPrompt(
      metadataWith([...ALL, "Split", "SklearnTrainingRandomForest", "Scorer"]),
      ["Filter", "Split", "SklearnTrainingRandomForest", "Scorer"]
    );
    expect(withMl).toContain("## Machine Learning Guide");
    expect(withMl).toContain('{"1": ["<split>:1"]}');
    const nativeOnly = buildGeneralModeSystemPrompt(metadataWith(ALL), ["Filter", "Aggregate"]);
    expect(nativeOnly).not.toContain("## Machine Learning Guide");
    // Default allowlist has no ML operators → no guide by default.
    expect(buildGeneralModeSystemPrompt(metadataWith(ALL), DEFAULT_AGENT_SETTINGS.allowedOperatorTypes)).not.toContain(
      "## Machine Learning Guide"
    );
  });

  test("includes the DataLoading/DataProcessing guide only when one of them is allowed", () => {
    const withData = buildGeneralModeSystemPrompt(metadataWith(ALL), ["Filter", "DataLoading"]);
    expect(withData).toContain("## DataLoading / DataProcessing Guide");
    expect(withData).toContain("def load() -> pd.DataFrame");
    expect(withData).not.toContain("## Python UDF Guide"); // PythonUDFV2 not allowed here

    const nativeOnly = buildGeneralModeSystemPrompt(metadataWith(ALL), ["Filter", "Aggregate"]);
    expect(nativeOnly).not.toContain("## DataLoading / DataProcessing Guide");
    expect(nativeOnly).not.toContain("## Python UDF Guide");

    const allowAll = buildGeneralModeSystemPrompt(metadataWith(ALL), []);
    expect(allowAll).toContain("## DataLoading / DataProcessing Guide");
    expect(allowAll).toContain("## Python UDF Guide");
    expect(allowAll).toContain("## R UDF Guide");
  });
});
