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
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
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

/**
 * Strip Python comments and string literals so a later regex scan for tokens
 * like `print(` / `return` doesn't match things that aren't actual code.
 * Handles: `# …` line comments, single/double-quoted strings (with escapes),
 * and triple-quoted strings. Replaces each match with whitespace of equal
 * length so line/column numbers stay meaningful if we ever surface them.
 */
function stripPythonCommentsAndStrings(code: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    // Triple-quoted strings (check before single-quoted).
    if (code.startsWith('"""', i) || code.startsWith("'''", i)) {
      const quote = code.substr(i, 3);
      const end = code.indexOf(quote, i + 3);
      const stop = end === -1 ? code.length : end + 3;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    // Single/double-quoted strings.
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === "\n") break;
        if (code[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      out += blank(code.slice(i, j));
      i = j;
      continue;
    }
    // Line comments.
    if (c === "#") {
      const eol = code.indexOf("\n", i);
      const stop = eol === -1 ? code.length : eol;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Reject operator code that violates the "every function returns a DataFrame,
 * never bare print()" contract. Two checks, run in order — first failure wins:
 *
 *   1. `print(` token anywhere in real code (string/comment occurrences are
 *      stripped first). Prints turn an operator into a side-effect-only step:
 *      the runtime calls it a success but downstream / the inspector see no
 *      result data, which leaves the agent stuck.
 *   2. At least one of the function definitions inside the snippet must
 *      contain a `return <expr>` (not a bare `return`). A function that falls
 *      through returns None, which the runtime serializes as "no result data".
 *
 * Returns a single sentence describing the problem on failure, or null on
 * success. Uses Python AST via the system interpreter when available (most
 * accurate), and falls back to a regex pass over comment/string-stripped code
 * when Python isn't installed — so the validation still runs in CI containers
 * without python3.
 *
 * IMPORTANT: this runs BEFORE any state mutation in
 * `createCreateOrModifyOperatorTool`, so a rejected operator never lands in
 * the workflow.
 */
async function validateOperatorContract(code: string): Promise<string | null> {
  const pyResult = await runPythonContractCheck(code);
  if (pyResult !== "PYTHON_UNAVAILABLE") return pyResult;
  return regexContractCheck(code);
}

/** Exposed for unit tests — exercises the no-Python regex fallback path. */
export const __forTesting = { regexContractCheck, stripPythonCommentsAndStrings };

async function runPythonContractCheck(code: string): Promise<string | null | "PYTHON_UNAVAILABLE"> {
  const { spawn } = await import("child_process");
  return new Promise(resolve => {
    const pythonCode = `
import ast, sys
src = '''${code.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'''
try:
    tree = ast.parse(src)
except SyntaxError:
    sys.exit(0)
for n in ast.walk(tree):
    if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'print':
        sys.stdout.write('HAS_PRINT')
        sys.exit(2)
funcs = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
for fn in funcs:
    has_value_return = False
    for sub in ast.walk(fn):
        if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub is not fn:
            continue
        if isinstance(sub, ast.Return) and sub.value is not None:
            has_value_return = True
            break
    if not has_value_return:
        sys.stdout.write('NO_RETURN:' + fn.name)
        sys.exit(3)
sys.exit(0)
`;
    const proc = spawn("python3", ["-c", pythonCode]);
    let stdout = "";
    let pythonMissing = false;
    proc.stdout.on("data", data => {
      stdout += data.toString();
    });
    proc.on("close", exitCode => {
      if (pythonMissing) return resolve("PYTHON_UNAVAILABLE");
      if (exitCode === 0) return resolve(null);
      if (exitCode === 2) {
        return resolve(
          "Operator code contains `print(...)` — every operator must `return` a pd.DataFrame so downstream operators (and the result inspector) receive data; wrap the values you wanted to print into a single-row DataFrame and return it instead."
        );
      }
      if (exitCode === 3) {
        const fnName = stdout.replace(/^NO_RETURN:/, "") || "function";
        return resolve(
          `Operator code's \`${fnName}\` function has no \`return <pd.DataFrame>\` statement — every operator must return a pd.DataFrame, otherwise it runs but produces no result data.`
        );
      }
      // Any other exit code → treat as inconclusive, let the workflow proceed.
      resolve(null);
    });
    proc.on("error", () => {
      pythonMissing = true;
      resolve("PYTHON_UNAVAILABLE");
    });
    setTimeout(() => {
      proc.kill();
      resolve("PYTHON_UNAVAILABLE");
    }, 5000);
  });
}

function regexContractCheck(code: string): string | null {
  const stripped = stripPythonCommentsAndStrings(code);
  if (/\bprint\s*\(/.test(stripped)) {
    return "Operator code contains `print(...)` — every operator must `return` a pd.DataFrame so downstream operators (and the result inspector) receive data; wrap the values you wanted to print into a single-row DataFrame and return it instead.";
  }
  // Find every function header and verify the body contains a value-returning
  // return. The body of `def name(...):` runs from end-of-header to the next
  // top-level construct; a regex approximation that walks line-by-line with
  // indentation tracking works for the well-formed snippets the agent emits.
  const lines = stripped.split("\n");
  const funcHeader = /^(\s*)def\s+(\w+)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = funcHeader.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const fnName = m[2];
    let hasValueReturn = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") continue;
      const leadSpaces = l.match(/^\s*/)![0].length;
      if (leadSpaces <= indent) break; // function body ended
      const returnMatch = /^\s*return(\b)(.*)$/.exec(l);
      if (returnMatch && returnMatch[2].trim().length > 0) {
        hasValueReturn = true;
        break;
      }
    }
    if (!hasValueReturn) {
      return `Operator code's \`${fnName}\` function has no \`return <pd.DataFrame>\` statement — every operator must return a pd.DataFrame, otherwise it runs but produces no result data.`;
    }
  }
  return null;
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
        .describe("Unique operator name (valid Python variable). Other operators reference this as input parameter."),
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

        // Enforce the "every operator returns a DataFrame, no bare prints"
        // contract BEFORE any state mutation. A violation never touches the
        // workflow — the agent gets the one-sentence cause back and must
        // resubmit code that returns a DataFrame.
        const contractError = await validateOperatorContract(code);
        if (contractError) {
          return createErrorResult(contractError);
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
