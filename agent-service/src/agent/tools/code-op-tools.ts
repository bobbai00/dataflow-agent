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
 * Code-operator tool for CODE mode. The agent emits a Python function — either
 * `def load() -> pd.DataFrame` (DataLoading) or `def process(p1, p2, ...) -> pd.DataFrame`
 * (DataProcessing) — and this tool parses the function to derive operator type,
 * input port count, and the upstream link wiring (each `process()` parameter
 * must name an existing operator).
 */

import { z } from "zod";
import { tool } from "ai";
import type { WorkflowState } from "../workflow-state";
import type { OperatorPredicate, OperatorLink } from "../../types/workflow";
import { autoLayoutWorkflow } from "../util/auto-layout";
import { WorkflowUtilService } from "../util/workflow-utils";
import {
  createToolResult,
  createErrorResult,
  formatAddOperatorResult,
  formatModifyOperatorResult,
  formatOperatorError,
} from "./tools-utility";
import type { ToolContext } from "./workflow-crud-tools";

export const TOOL_NAME_CREATE_OR_MODIFY_OPERATOR = "createOrModifyOperator";

const DATA_PROCESSING_OPERATOR_TYPE = "DataProcessing";
const DATA_LOADING_OPERATOR_TYPE = "DataLoading";

interface CodeBlockParseResult {
  type: "DataLoading" | "DataProcessing";
  functionName: string;
  parameters: string[];
  numInputPorts: number;
}

const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await",
  "break", "class", "continue", "def", "del", "elif", "else", "except",
  "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
  "while", "with", "yield",
]);

export function validatePythonVariableName(name: string): string | null {
  if (!name || name.length === 0) {
    return "Variable name cannot be empty";
  }
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!validPattern.test(name)) {
    return (
      `'${name}' is not a valid Python variable name. ` +
      `Must start with a letter or underscore, followed by letters, digits, or underscores.`
    );
  }
  if (PYTHON_KEYWORDS.has(name)) {
    return `'${name}' is a Python reserved keyword and cannot be used as a variable name.`;
  }
  return null;
}

function parseCodeBlock(code: string): CodeBlockParseResult | { error: string } {
  const funcPattern = /def\s+(\w+)\s*\(([^)]*)\)/;
  const match = funcPattern.exec(code);

  if (!match) {
    return { error: "No valid Python function definition found. Expected: def load() or def process(...):" };
  }

  const functionName = match[1];
  const paramsStr = match[2].trim();

  const parameters: string[] = paramsStr
    ? paramsStr
        .split(",")
        .map(p => p.trim())
        .map(p => p.split(":")[0].trim())
        .filter(p => p.length > 0)
    : [];

  if (functionName === "load") {
    if (parameters.length > 0) {
      return {
        error:
          `Function "load" must have no parameters. Found parameters: [${parameters.join(", ")}]. ` +
          `For data processing with inputs, use "def process(${parameters.join(", ")})".`,
      };
    }
    return { type: "DataLoading", functionName, parameters: [], numInputPorts: 0 };
  }

  if (functionName === "process") {
    if (parameters.length === 0) {
      return {
        error:
          `Function "process" must have at least one parameter representing input data. ` +
          `Example: def process(data) -> pd.DataFrame: ...`,
      };
    }
    return {
      type: "DataProcessing",
      functionName,
      parameters,
      numInputPorts: parameters.length,
    };
  }

  return {
    error:
      `Invalid function name "${functionName}". Function name must be exactly "load" or "process".\n` +
      `- Use "def load() -> pd.DataFrame:" for data loading (no input ports)\n` +
      `- Use "def process(input1, input2, ...) -> pd.DataFrame:" for data processing (with input ports)`,
  };
}

function findOperatorByName(workflowState: WorkflowState, operatorName: string): OperatorPredicate | undefined {
  return workflowState.getOperator(operatorName);
}

/**
 * Validate Python syntax via the system Python interpreter. Returns null on
 * success, or the stderr output on syntax error. Silently skips when Python is
 * not installed (validation is best-effort).
 */
async function validatePythonSyntax(code: string): Promise<string | null> {
  const { spawn } = await import("child_process");

  return new Promise(resolve => {
    const pythonCode = `
import ast
import sys
try:
    ast.parse('''${code.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}''')
    sys.exit(0)
except SyntaxError as e:
    print(f"Line {e.lineno}: {e.msg}", file=sys.stderr)
    sys.exit(1)
`;

    const proc = spawn("python3", ["-c", pythonCode]);
    let stderr = "";

    proc.stderr.on("data", data => {
      stderr += data.toString();
    });

    proc.on("close", exitCode => {
      if (exitCode === 0) {
        resolve(null);
      } else {
        resolve(stderr.trim() || "Python syntax error");
      }
    });

    proc.on("error", () => {
      // Python not available — skip syntax validation.
      resolve(null);
    });

    setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 5000);
  });
}

function validateInputParameters(
  workflowState: WorkflowState,
  parameters: string[]
): { inputOperators: OperatorPredicate[] } | { error: string } {
  const inputOperators: OperatorPredicate[] = [];
  const missingParams: string[] = [];

  for (const param of parameters) {
    const inputOp = findOperatorByName(workflowState, param);
    if (!inputOp) {
      missingParams.push(param);
    } else {
      inputOperators.push(inputOp);
    }
  }

  if (missingParams.length > 0) {
    return {
      error:
        `Input parameter(s) not found as operators: [${missingParams.join(", ")}]. ` +
        `Each parameter in def process(${parameters.join(", ")}) must reference an existing operator.`,
    };
  }

  return { inputOperators };
}

function createInputLinks(
  workflowState: WorkflowState,
  operatorId: string,
  inputOperators: OperatorPredicate[]
): string[] {
  const createdLinkIds: string[] = [];

  for (let i = 0; i < inputOperators.length; i++) {
    const sourceOp = inputOperators[i];
    const linkId = `${sourceOp.operatorID}-->${operatorId}`;

    const link: OperatorLink = {
      linkID: linkId,
      source: {
        operatorID: sourceOp.operatorID,
        portID: sourceOp.outputPorts[0]?.portID || "output-0",
      },
      target: {
        operatorID: operatorId,
        portID: `input-${i}`,
      },
    };

    workflowState.addLink(link);
    createdLinkIds.push(linkId);
  }

  return createdLinkIds;
}

export function createCreateOrModifyOperatorTool(
  workflowState: WorkflowState,
  operatorSchemas: Map<string, any>,
  context?: ToolContext
) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;

  return tool({
    description: `Add or modify a Python function as an operator in the dataflow.
- If operatorId does NOT exist: creates a new operator
- If operatorId exists: modifies the existing operator (must keep same type)

RULES:
1. operatorId must be a valid Python variable name
2. Function name MUST be exactly "load" or "process"
3. For process(): each parameter MUST match an existing operator's operatorId - links are auto-created/updated

## def load() -> pd.DataFrame
Load data from files. No input parameters. File I/O allowed.

Example: operatorId="customers"
  def load() -> pd.DataFrame:
      return pd.read_csv('/data/customers.csv')

## def process(opId1, opId2, ...) -> pd.DataFrame
Transform input data. Each parameter references an existing operator id. Links between operators will be auto-created.

Example: operatorId="filtered" (requires "customers" to exist)
  def process(customers) -> pd.DataFrame:
      return customers[customers['age'] > 18]
  # Creates link: customers-->filtered`,
    inputSchema: z.object({
      operatorId: z
        .string()
        .describe(
          "Unique operator name (valid Python variable). Other operators reference this as input parameter."
        ),
      code: z.string().describe("Python function: def load() or def process(...)"),
      summary: z
        .string()
        .describe(
          "Detailed summary of the operator behavior. For load() operators, you MUST include the filename(s) being loaded."
        ),
    }),
    execute: async (args: { operatorId: string; code: string; summary?: string }) => {
      try {
        const { operatorId, code, summary } = args;

        const nameValidationError = validatePythonVariableName(operatorId);
        if (nameValidationError) {
          return createErrorResult(`Invalid operatorId: ${nameValidationError}`);
        }

        const parseResult = parseCodeBlock(code);
        if ("error" in parseResult) {
          return createErrorResult(parseResult.error);
        }

        const { type, numInputPorts, parameters } = parseResult;
        const isDataProcessing = type === "DataProcessing";

        const syntaxError = await validatePythonSyntax(code);
        if (syntaxError) {
          return createErrorResult(`Python syntax error: ${syntaxError}`);
        }

        let inputOperators: OperatorPredicate[] = [];
        if (isDataProcessing && parameters.length > 0) {
          const validation = validateInputParameters(workflowState, parameters);
          if ("error" in validation) {
            return createErrorResult(validation.error);
          }
          inputOperators = validation.inputOperators;
        }

        const existingOperator = findOperatorByName(workflowState, operatorId);
        const displayName = summary || operatorId;

        let resultMsg: string;
        let createdLinkPairs: { source: string; target: string }[] = [];
        let deletedLinkPairs: { source: string; target: string }[] = [];

        if (!existingOperator) {
          // === ADD NEW OPERATOR ===
          const operatorType = isDataProcessing ? DATA_PROCESSING_OPERATOR_TYPE : DATA_LOADING_OPERATOR_TYPE;

          const schemaEntry = operatorSchemas.get(operatorType);
          if (!schemaEntry) {
            return createErrorResult(`Operator type "${operatorType}" is not available.`);
          }

          if (!workflowUtil) {
            return createErrorResult("Metadata store not available for operator creation");
          }

          let operator = workflowUtil.getNewOperatorPredicate(operatorType, displayName);
          operator = {
            ...operator,
            operatorID: operatorId,
            operatorProperties: { ...operator.operatorProperties, code },
          };

          workflowState.addOperator(operator);

          if (isDataProcessing && numInputPorts > 1) {
            workflowState.updateOperatorInputPorts(operatorId, numInputPorts);
          }

          if (isDataProcessing && inputOperators.length > 0) {
            createInputLinks(workflowState, operatorId, inputOperators);
            createdLinkPairs = inputOperators.map(src => ({ source: src.operatorID, target: operatorId }));
          }

          autoLayoutWorkflow(workflowState);

          const finalOperator = workflowState.getOperator(operatorId) || operator;
          resultMsg = formatAddOperatorResult(
            operatorId,
            finalOperator.inputPorts.length,
            finalOperator.outputPorts.length,
            createdLinkPairs.length > 0 ? createdLinkPairs : undefined
          );
        } else {
          // === MODIFY EXISTING OPERATOR ===
          const isExistingDataLoading = existingOperator.operatorType === DATA_LOADING_OPERATOR_TYPE;
          const isExistingDataProcessing = existingOperator.operatorType === DATA_PROCESSING_OPERATOR_TYPE;

          if (!isExistingDataLoading && !isExistingDataProcessing) {
            return createErrorResult(
              `Operator ${operatorId} is not a code operator. ` +
                `Expected: ${DATA_LOADING_OPERATOR_TYPE} or ${DATA_PROCESSING_OPERATOR_TYPE}, got: ${existingOperator.operatorType}`
            );
          }

          const expectedType = isExistingDataLoading ? "DataLoading" : "DataProcessing";
          if (type !== expectedType) {
            return createErrorResult(
              `Type mismatch: ${operatorId} is ${expectedType}, but code is ${type}. ` +
                `Use ${expectedType === "DataLoading" ? "load()" : "process(...)"}.`
            );
          }

          workflowState.updateOperatorProperties(operatorId, { code });
          if (summary) {
            workflowState.updateOperatorDisplayName(operatorId, summary);
          }

          if (isExistingDataProcessing) {
            if (numInputPorts !== existingOperator.inputPorts.length) {
              workflowState.updateOperatorInputPorts(operatorId, numInputPorts);
            }

            const currentLinks = workflowState
              .getLinksConnectedToOperator(operatorId)
              .filter(link => link.target.operatorID === operatorId);
            for (const link of currentLinks) {
              deletedLinkPairs.push({ source: link.source.operatorID, target: link.target.operatorID });
              workflowState.deleteLink(link.linkID);
            }

            if (inputOperators.length > 0) {
              createInputLinks(workflowState, operatorId, inputOperators);
              createdLinkPairs = inputOperators.map(src => ({ source: src.operatorID, target: operatorId }));
            }
          }

          resultMsg = formatModifyOperatorResult(
            operatorId,
            createdLinkPairs.length > 0 ? createdLinkPairs : undefined,
            deletedLinkPairs.length > 0 ? deletedLinkPairs : undefined
          );
        }

        return createToolResult(resultMsg);
      } catch (error: any) {
        return createErrorResult(formatOperatorError(args.operatorId, error.message || String(error)));
      }
    },
  });
}
