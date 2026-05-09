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

import type {
  CommentBox,
  OperatorLink,
  OperatorPredicate,
  Point,
  PortDescription,
  WorkflowContent,
} from "../../src/types/workflow";

/**
 * Intentionally-broken workflows used to verify the runtime error format
 * coming out of `data_processor.py:_report_exception`. Each spec pins the
 * operator that should fail, the exception type, and a substring from the
 * offending line — the orchestrator asserts all three are present in the
 * `info.error` returned by the sync execution endpoint.
 *
 * Operators under test:
 *   - DataLoading   (source, file I/O allowed; user writes `def load()`)
 *   - DataProcessing (transform; user writes `def process(p1, ...)`)
 */

const DEFAULT_SETTINGS = { dataTransferBatchSize: 400 };

function pos(x: number, y: number): Point {
  return { x, y };
}

function inputPort(idx: number, isDynamic = false): PortDescription {
  return {
    portID: `input-${idx}`,
    displayName: "",
    disallowMultiInputs: true,
    isDynamicPort: isDynamic,
    dependencies: [],
  };
}

function outputPort(idx: number): PortDescription {
  return {
    portID: `output-${idx}`,
    displayName: "",
    disallowMultiInputs: false,
    isDynamicPort: false,
  };
}

function buildOperator(init: {
  type: string;
  id: string;
  displayName: string;
  properties: Record<string, any>;
  numInputs: number;
  numOutputs: number;
  viewResult?: boolean;
}): OperatorPredicate {
  const inputPorts: PortDescription[] = [];
  for (let i = 0; i < init.numInputs; i++) inputPorts.push(inputPort(i, i > 0));
  const outputPorts: PortDescription[] = [];
  for (let i = 0; i < init.numOutputs; i++) outputPorts.push(outputPort(i));
  return {
    operatorID: init.id,
    operatorType: init.type,
    operatorVersion: "N/A",
    operatorProperties: init.properties,
    inputPorts,
    outputPorts,
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: init.displayName,
    dynamicInputPorts: init.numInputs > 1,
    dynamicOutputPorts: false,
    viewResult: init.viewResult ?? false,
  };
}

function buildLink(linkID: string, fromOp: string, fromPort: number, toOp: string, toPort: number): OperatorLink {
  return {
    linkID,
    source: { operatorID: fromOp, portID: `output-${fromPort}` },
    target: { operatorID: toOp, portID: `input-${toPort}` },
  };
}

function dataLoading(id: string, displayName: string, code: string, viewResult = false): OperatorPredicate {
  return buildOperator({
    type: "DataLoading",
    id,
    displayName,
    properties: { code },
    numInputs: 0,
    numOutputs: 1,
    viewResult,
  });
}

function dataProcessing(
  id: string,
  displayName: string,
  code: string,
  numInputs: number,
  viewResult: boolean
): OperatorPredicate {
  return buildOperator({
    type: "DataProcessing",
    id,
    displayName,
    properties: { code },
    numInputs,
    numOutputs: 1,
    viewResult,
  });
}

export interface ErrorWorkflowSpec {
  name: string;
  description: string;
  /** ID of the operator we expect to fail. */
  failingOperatorId: string;
  /** Substring expected in the exception type field (e.g. "NameError"). */
  expectedExceptionType: string;
  /**
   * Substring from the *exact* line of user code that errored — used to assert
   * the renderer pointed at the right line via the `>` marker.
   */
  expectedLineSubstring: string;
  build: () => WorkflowContent;
}

/* ---------------- 1. DataLoading: NameError ---------------- */

const loadingNameErrorCode = `def load() -> pd.DataFrame:
    rows = {'a': [1, 2, 3]}
    df = pd.DataFrame(rows)
    df['b'] = undefined_variable_name
    return df
`;

function buildLoadingNameError(): WorkflowContent {
  const src = dataLoading("DataLoading-operator-nameError", "Load (NameError)", loadingNameErrorCode, true);
  return {
    operators: [src],
    operatorPositions: { [src.operatorID]: pos(120, 200) },
    links: [],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

/* ---------------- 2. DataLoading: TypeError ---------------- */

const loadingTypeErrorCode = `def load() -> pd.DataFrame:
    label = 'count='
    n = 5
    combined = label + n
    return pd.DataFrame({'combined': [combined]})
`;

function buildLoadingTypeError(): WorkflowContent {
  const src = dataLoading("DataLoading-operator-typeError", "Load (TypeError)", loadingTypeErrorCode, true);
  return {
    operators: [src],
    operatorPositions: { [src.operatorID]: pos(120, 200) },
    links: [],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

/* ---------------- 3. DataProcessing: KeyError on missing column ---------------- */

const processingSourceCode = `def load() -> pd.DataFrame:
    return pd.DataFrame({'x': [10, 20, 30]})
`;

const processingKeyErrorCode = `def process(input_0) -> pd.DataFrame:
    out = input_0.copy()
    out['doubled'] = out['x'] * 2
    selected = out[['x', 'missing_column_name']]
    return selected
`;

function buildProcessingKeyError(): WorkflowContent {
  const src = dataLoading("DataLoading-operator-keyerrSource", "Source", processingSourceCode);
  const proc = dataProcessing("DataProcessing-operator-keyerrProc", "Process (KeyError)", processingKeyErrorCode, 1, true);
  return {
    operators: [src, proc],
    operatorPositions: {
      [src.operatorID]: pos(120, 200),
      [proc.operatorID]: pos(420, 200),
    },
    links: [buildLink("link-keyerr", src.operatorID, 0, proc.operatorID, 0)],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

/* ---------------- 4. DataProcessing: ZeroDivisionError ---------------- */

const processingZeroDivCode = `def process(input_0) -> pd.DataFrame:
    numerator = 1
    denominator = 0
    boom = numerator / denominator
    out = input_0.copy()
    out['boom'] = boom
    return out
`;

function buildProcessingZeroDivision(): WorkflowContent {
  const src = dataLoading("DataLoading-operator-zdSource", "Source", processingSourceCode);
  const proc = dataProcessing("DataProcessing-operator-zdProc", "Process (ZeroDivision)", processingZeroDivCode, 1, true);
  return {
    operators: [src, proc],
    operatorPositions: {
      [src.operatorID]: pos(120, 200),
      [proc.operatorID]: pos(420, 200),
    },
    links: [buildLink("link-zd", src.operatorID, 0, proc.operatorID, 0)],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

export const ERROR_WORKFLOW_SPECS: ErrorWorkflowSpec[] = [
  {
    name: "[Errors] DataLoading NameError",
    description: "DataLoading user code references an undefined variable.",
    failingOperatorId: "DataLoading-operator-nameError",
    expectedExceptionType: "NameError",
    expectedLineSubstring: "df['b'] = undefined_variable_name",
    build: buildLoadingNameError,
  },
  {
    name: "[Errors] DataLoading TypeError",
    description: "DataLoading user code adds str + int.",
    failingOperatorId: "DataLoading-operator-typeError",
    expectedExceptionType: "TypeError",
    expectedLineSubstring: "combined = label + n",
    build: buildLoadingTypeError,
  },
  {
    name: "[Errors] DataProcessing KeyError",
    description: "DataProcessing accesses a column that doesn't exist on the input table.",
    failingOperatorId: "DataProcessing-operator-keyerrProc",
    expectedExceptionType: "KeyError",
    expectedLineSubstring: "out[['x', 'missing_column_name']]",
    build: buildProcessingKeyError,
  },
  {
    name: "[Errors] DataProcessing ZeroDivisionError",
    description: "DataProcessing divides by zero in user code.",
    failingOperatorId: "DataProcessing-operator-zdProc",
    expectedExceptionType: "ZeroDivisionError",
    expectedLineSubstring: "boom = numerator / denominator",
    build: buildProcessingZeroDivision,
  },
];
