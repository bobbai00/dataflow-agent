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

/**
 * Validator for operator IDs. An operator id must be a Python identifier so
 * the engine's `def process(<id>)` parameter binding works. The engine's
 * VFS URI / serde layer accepts any non-comma character inside `logicalOpId`
 * (see `GlobalPortIdentitySerde`), so the only real constraint here is the
 * Python identifier shape plus the keyword reservation. Earlier versions
 * enforced strict camelCase to mirror a then-existing `_`-as-delimiter
 * guard in the serde; that guard has been removed, so the camelCase rule
 * is gone too — `snake_case` ids are valid again.
 */
export function validateOperatorId(name: string): string | null {
  return validatePythonVariableName(name);
}

export function parseCodeBlock(code: string): CodeBlockParseResult | { error: string } {
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
 * Strip Python docstrings (triple-quoted strings) and `#` line comments from
 * code, leaving regular single/double-quoted string literals intact (those
 * carry data — file paths, separators, regex patterns — and removing them
 * would erase signal). Replaces matched ranges with whitespace of equal
 * length so line/column numbers stay aligned with the original.
 *
 * Used by `normalizeCodeForCompare` so the no-op detector ignores
 * docstring/comment-only edits — a docstring rewrite passing as "code
 * change" was the most common way models leaked past a naive byte check.
 */
function stripDocstringsAndComments(code: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    // Triple-quoted strings → blanked (treat as docstring).
    if (code.startsWith('"""', i) || code.startsWith("'''", i)) {
      const quote = code.substr(i, 3);
      const end = code.indexOf(quote, i + 3);
      const stop = end === -1 ? code.length : end + 3;
      out += blank(code.slice(i, stop));
      i = stop;
      continue;
    }
    // Regular single/double-quoted strings → kept verbatim (carry data).
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
      out += code.slice(i, j);
      i = j;
      continue;
    }
    // `#` line comments → blanked.
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
 * Whitespace-normalize a code blob for byte-comparison purposes after
 * stripping docstrings + line comments. Two snippets that differ only in
 * comments, docstrings, formatting, or blank-line spacing compare equal
 * under this normalization — that's exactly the class of "no-op
 * modification" we want to flag.
 */
function normalizeCodeForCompare(s: string): string {
  return stripDocstringsAndComments(s)
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l.length > 0)
    .join("\n");
}

/**
 * Render the no-op WARNING line appended to a modifyOperator tool result
 * when the agent submits code byte-identical to the prior version (after
 * stripping docstrings/comments and normalizing whitespace). Returns the
 * empty string when the modification is meaningful — in that case the
 * result is just "Operator X modified" and the agent reads the actual code
 * from the rendered context (which carries `code: |` blocks for the most
 * recent N events under the `recentEventsCap` policy).
 */
function formatNoOpWarning(): string {
  return (
    "WARNING: the code you just submitted matches the prior version after stripping docstrings/comments and normalizing whitespace — " +
    "this modification was a no-op. " +
    "If you intended to alter behavior, you must change strategy (e.g., switch the loader function, " +
    "change column-selection logic, look at a different upstream operator's result) — not another small tweak to this same operator. " +
    "Repeating near-identical modifications without pivoting is parametric thrashing and will not converge."
  );
}

/**
 * Build the convergence-guard rejection message (goal.md lever C, limitation
 * L1). Emitted when the agent has edited the same operator `cap` times in a row
 * and submits yet another modification to it. The message names the operator,
 * the cap, and the operator's immediate upstream operator ids so the model is
 * pointed at the usual root cause (a wrong column name/type assumed from
 * upstream) instead of being told only "stop". Listing upstream *ids* is not
 * lever D — it surfaces no schemas/columns, just the lineage neighbors the
 * model already sees in the DAG.
 */
function buildConvergenceGuardMessage(operatorId: string, cap: number, upstreamIds: string[]): string {
  const upstreamHint =
    upstreamIds.length > 0
      ? `Inspect the Result/error of its input operator(s) [${upstreamIds.join(", ")}] first — ` +
        `a column name or type wrongly assumed from upstream is the usual root cause.`
      : `It has no upstream operators — re-read its own error and the task requirements, not its code.`;
  return (
    `Convergence guard: operator \`${operatorId}\` has already been edited ${cap} times (its edit budget), ` +
    `so this further modification was REJECTED. Repeated edits to the same operator are parametric thrashing and ` +
    `do not converge. Do NOT keep editing \`${operatorId}\`. Instead: (1) ${upstreamHint} ` +
    `(2) build the answer from a DIFFERENT operator, or (3) reconsider the overall approach (a different ` +
    `decomposition, loader, or column-selection strategy).`
  );
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
 * Result of the operator-code contract check.
 *
 *   - `null`               → code passes all rules.
 *   - `{ kind: "error" }`  → hard reject; the operator must not land in the
 *                            workflow. Currently fires when a function has no
 *                            value-returning `return` — such an operator runs
 *                            but produces no result data, leaving the agent
 *                            stuck downstream.
 *   - `{ kind: "warning" }`→ soft signal; the operator is still added and
 *                            executed, but a `[WARNING] …` is prepended to
 *                            the tool result. Currently fires for `print(...)`
 *                            usage — prints succeed at runtime but their
 *                            output is dropped (not surfaced as the operator's
 *                            result), so we discourage them without blocking.
 */
type ContractResult = null | { kind: "error" | "warning"; message: string };

function noReturnErrorMessage(fnName: string): string {
  return `Operator code's \`${fnName}\` function has no \`return <pd.DataFrame>\` statement — every operator must return a pd.DataFrame, otherwise it runs but produces no result data.`;
}

/**
 * Validate operator code against the "every function returns a DataFrame,
 * prefer to avoid bare print()" contract. Two checks:
 *
 *   1. (hard) At least one of the function definitions inside the snippet
 *      must contain a `return <expr>` (not a bare `return`). A function that
 *      falls through returns None, which the runtime serializes as
 *      "no result data" — rejecting here prevents that dead operator.
 *   2. (soft) A `print(` token anywhere in real code (string/comment
 *      occurrences are stripped first) downgrades to a warning. The operator
 *      is still added/executed, but the result string is prefixed with
 *      `[WARNING] …` so the agent learns to remove it.
 *
 * The hard check is evaluated first — if a function lacks a return, the
 * print issue is moot (the operator is broken anyway), so we surface the
 * error and stop.
 *
 * Uses Python AST via the system interpreter when available (most accurate),
 * and falls back to a regex pass over comment/string-stripped code when
 * Python isn't installed — so the validation still runs in CI containers
 * without python3.
 *
 * IMPORTANT: this runs BEFORE any state mutation in
 * `createCreateOrModifyOperatorTool`, so a hard-error operator never lands
 * in the workflow.
 */
async function validateOperatorContract(code: string): Promise<ContractResult> {
  const pyResult = await runPythonContractCheck(code);
  if (pyResult !== "PYTHON_UNAVAILABLE") return pyResult;
  return regexContractCheck(code);
}

/** Exposed for unit tests — exercises the no-Python regex fallback path. */
export const __forTesting = {
  regexContractCheck,
  stripPythonCommentsAndStrings,
  stripDocstringsAndComments,
  normalizeCodeForCompare,
  formatNoOpWarning,
  buildConvergenceGuardMessage,
};

async function runPythonContractCheck(code: string): Promise<ContractResult | "PYTHON_UNAVAILABLE"> {
  const { spawn } = await import("child_process");
  return new Promise(resolve => {
    const pythonCode = `
import ast, sys
src = '''${code.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'''
try:
    tree = ast.parse(src)
except SyntaxError:
    sys.exit(0)
# Hard check first: any function missing a value-returning return is a
# blocker. The print check is moot if the operator is broken anyway.
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
      if (exitCode === 3) {
        const fnName = stdout.replace(/^NO_RETURN:/, "") || "function";
        return resolve({ kind: "error", message: noReturnErrorMessage(fnName) });
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

function regexContractCheck(code: string): ContractResult {
  const stripped = stripPythonCommentsAndStrings(code);
  // Hard check first: any function without a value-returning return is a
  // blocker. We walk function headers line-by-line with indentation tracking;
  // this approximation works for the well-formed snippets the agent emits.
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
      return { kind: "error", message: noReturnErrorMessage(fnName) };
    }
  }
  return null;
}

function validateInputParameters(
  workflowState: WorkflowState,
  parameters: string[],
  operatorId?: string
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

  // An operator cannot consume its own output: the graph holds ONE node per
  // id, so `def process(X)` while writing `X` is the edge `X -> X`, which
  // makes the workflow cyclic and causes the execution service to reject every
  // subsequent plan wholesale. Caught here, before anything mutates, with the
  // two things the model can actually do instead.
  if (operatorId && parameters.includes(operatorId)) {
    return {
      error:
        `\`${operatorId}\` cannot take itself as an input — an operator's own output is not available to it, ` +
        `and the link would make the dataflow cyclic. Either fold the extra work into \`${operatorId}\`'s own ` +
        `code (drop \`${operatorId}\` from its parameters), or give the new step a DIFFERENT operator id that ` +
        `reads \`${operatorId}\`.`,
    };
  }

  // Same rule one hop out: a parameter that is DOWNSTREAM of this operator
  // closes a longer cycle. Only meaningful for an existing operator.
  if (operatorId && workflowState.getOperator(operatorId)) {
    for (const param of parameters) {
      if (param === operatorId) continue;
      if (workflowState.wouldCreateCycle(param, operatorId)) {
        return {
          error:
            `\`${param}\` cannot be an input to \`${operatorId}\`: \`${param}\` is downstream of ` +
            `\`${operatorId}\`, so the link would close a cycle. Build the new step as a separate operator ` +
            `reading \`${param}\` instead.`,
        };
      }
    }
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

    // A refused edge (self-link) is skipped, not recorded: reporting a link
    // the graph does not have would tell the model its wiring succeeded.
    if (workflowState.addLink(link)) createdLinkIds.push(linkId);
  }

  return createdLinkIds;
}

export function createCreateOrModifyOperatorTool(
  workflowState: WorkflowState,
  operatorSchemas: Map<string, any>,
  context?: ToolContext,
  maxOperatorEdits = 0,
  renderPrefsEnabled = false,
  // Code visible to the agent is the DEFAULT — true for every DELTA config
  // (events carry `code:`) and for LATEST with code in the snapshot. Only pass
  // false for the one code-blind case: LATEST with the snapshot flag off.
  codeShownEnabled = true
) {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;

  // Convergence-guard state (goal.md lever C). Per-operator CUMULATIVE edit
  // counter: operatorId → number of `createOrModifyOperator` calls that have
  // targeted it during this agent's life. Total (not just consecutive) because
  // baseline thrashing is largely interleaved — one operator gets edited many
  // times with edits of other operators in between (e.g. 30 total edits, only
  // 14 consecutive), which a consecutive-only cap would not catch (the model
  // could ping-pong between two operators to evade it). Each operator has its
  // own independent budget. State lives in this closure, which is stable for
  // the life of one agent (the tool is only rebuilt on createTools(), which
  // never runs mid-`sendMessage`); each KramaBench task uses a fresh agent, so
  // the counters reset per task.
  const guardEditCounts = new Map<string, number>();

  return tool({
    description: `Add or modify a Python function as an operator in the dataflow.
- If operatorId does NOT exist: creates a new operator
- If operatorId exists: modifies the existing operator (must keep same type)

RULES:
1. operatorId must be a valid Python identifier — letters, digits, and underscores;
   the first character must be a letter or underscore. snake_case and camelCase are
   both fine. Reserved Python keywords (e.g. "for", "class") are not allowed.
2. Function name MUST be exactly "load" or "process"
3. For process(): each parameter MUST match an existing operator's operatorId - links are auto-created/updated.
   The parameter name is the upstream operatorId verbatim.

## def load() -> pd.DataFrame
Load data from files. No input parameters. File I/O allowed.

Example: operatorId="customers"
  def load() -> pd.DataFrame:
      return pd.read_csv('/data/customers.csv')

## def process(opId1, opId2, ...) -> pd.DataFrame
Transform input data. Each parameter references an existing operator id. Links between operators will be auto-created.

Example: operatorId="filteredCustomers" (requires "customers" to exist)
  def process(customers) -> pd.DataFrame:
      return customers[customers['age'] > 18]
  # Creates link: customers-->filteredCustomers`,
    inputSchema: (() => {
      const baseShape = {
        operatorId: z
          .string()
          .describe("Unique operator name (valid Python variable). Other operators reference this as input parameter."),
        code: z.string().describe("Python function: def load() or def process(...)"),
        summary: z.string().describe(
          // DEFAULT: the agent can read its own code (DELTA events, or LATEST
          // with code in the snapshot), so the summary carries lineage only,
          // not logic — restating it duplicates what is already on screen.
          codeShownEnabled
            ? "One short line naming what this operator does at a glance — the subject and the gist only " +
                '(e.g. "Load orders.csv" or "Filter orders_clean to 2024, sum amount by customer_id"). ' +
                "Do NOT restate the detailed logic; your code is shown to you and carries the specifics."
            : // Code-blind (LATEST without code in the snapshot): the summaries
              // are the ONLY record of what each operator does, so they must
              // carry the logic themselves.
              "Detailed summary of the operator behavior. For load() operators, you MUST include the filename(s) being loaded. " +
                "For process() operators, name the input operator(s) as the subject and describe the transformation applied to them — " +
                'e.g. "From `orders_clean`, filter to 2024 and sum `amount` by `customer_id`" or "Join `customers` and `orders_clean` on `customer_id`" — ' +
                "including the significant logic (columns, keys, filters, aggregations). This keeps the dataflow's lineage legible from the summaries alone."
        ),
      };
      const richSchema = z.object({
        ...baseShape,
        outputSummary: z
          .enum(["minimal", "standard"])
          .optional()
          .describe(
            "How much of this operator's OUTPUT TABLE is shown to you in context: 'minimal' = a few rows, " +
              "'standard' (default) = the normal view. View-only — the operator always computes its full output " +
              "and downstream operators always receive the complete data. Applies to this version until the next edit."
          ),
      });
      // Control arms (flag off) must not even SEE the pref params — swap in the
      // base schema; the runtime args type is the rich one (fields just absent).
      return (renderPrefsEnabled ? richSchema : z.object(baseShape)) as typeof richSchema;
    })(),
    execute: async (args: {
      operatorId: string;
      code: string;
      summary?: string;
      outputSummary?: "minimal" | "standard";
    }) => {
      try {
        const { operatorId, code, summary } = args;

        const nameValidationError = validateOperatorId(operatorId);
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

        // Enforce the "every operator returns a DataFrame, prefer to avoid
        // bare prints" contract BEFORE any state mutation. A hard error never
        // touches the workflow; a warning lets the operator land but is
        // prepended to the success message so the agent learns to remove it.
        const contract = await validateOperatorContract(code);
        if (contract?.kind === "error") {
          return createErrorResult(contract.message);
        }
        const contractWarning = contract?.kind === "warning" ? contract.message : null;

        let inputOperators: OperatorPredicate[] = [];
        if (isDataProcessing && parameters.length > 0) {
          const validation = validateInputParameters(workflowState, parameters, operatorId);
          if ("error" in validation) {
            return createErrorResult(validation.error);
          }
          inputOperators = validation.inputOperators;
        }

        const existingOperator = findOperatorByName(workflowState, operatorId);

        const displayName = summary || operatorId;

        // Convergence guard (lever C / L1). Count cumulative edits per
        // operator; once an existing operator has already been edited
        // `maxOperatorEdits` times, reject the next MODIFY to it before
        // mutating anything. The counter advances on every well-formed call
        // (create or modify), so a `create` seeds the count at 1. Rejection
        // returns an `[ERROR]` result and touches no state, so the loop's
        // post-step execution skips it (no run, no new result table, no context
        // growth) — truncating the thrashing tail.
        if (maxOperatorEdits > 0) {
          const edits = (guardEditCounts.get(operatorId) ?? 0) + 1;
          guardEditCounts.set(operatorId, edits);
          if (existingOperator && edits > maxOperatorEdits) {
            const upstreamIds = workflowState
              .getLinksConnectedToOperator(operatorId)
              .filter(link => link.target.operatorID === operatorId)
              .map(link => link.source.operatorID);
            return createErrorResult(buildConvergenceGuardMessage(operatorId, maxOperatorEdits, upstreamIds));
          }
        }

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
          // Capture the previous code BEFORE we mutate it so we can show the
          // before/after diff (and detect no-op modifications) in the tool result.
          const beforeCode = String((existingOperator.operatorProperties as any)?.code ?? "");

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

          // Emit a loud WARNING when the agent submitted code byte-identical
          // to the prior version (after stripping docstrings/comments and
          // normalizing whitespace) — operator-thrashing prevention signal.
          // The actual code of recent modifications is visible to the agent
          // via the `code: |` blocks rendered for events inside the
          // `recentEventsCap` window, so we don't need to repeat before/after
          // here for non-noop modifications.
          const isNoOp = normalizeCodeForCompare(beforeCode) === normalizeCodeForCompare(code) && code.length > 0;
          if (isNoOp) {
            resultMsg = `${resultMsg}\n${formatNoOpWarning()}`;
          }
        }

        const finalMsg = contractWarning ? `[WARNING] ${contractWarning}\n${resultMsg}` : resultMsg;
        return createToolResult(finalMsg);
      } catch (error: any) {
        return createErrorResult(formatOperatorError(args.operatorId, error.message || String(error)));
      }
    },
  });
}
