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
 * From a program to operator definitions.
 *
 *   program text ──python/program_parser.py──▶ statements + functions
 *                ──catalog normalize + Ajv──▶ one NativeOpView per statement
 *
 * A syntax error fails the whole program (there is nothing to apply). An
 * argument error fails only its statement; the other statements still carry
 * a view, and the failed one carries an `attempted` view so the receipt can
 * pin a diagnostic to exactly what was written.
 */

import Ajv from "ajv";
import {
  NATIVE_BY_NAME,
  NATIVE_OPERATOR_NAMES,
  NativeArgumentError,
  splitInputs,
  graphOperatorSignature,
  type FunctionSlot,
  type NativeOpView,
  type ParsedFunction,
  type ParsedStatement,
} from "./catalog";
import { nativeRevision, runNativePython } from "./codegen";

/** One statement (or def) that did not parse or is not `name = operator(...)`.
 * Reported at its line; the rest of the program is unaffected. */
export interface ProgramSyntaxError {
  line: number;
  column?: number | null;
  message: string;
  /** The assigned name when the broken statement has one (`x = ...`), else null. */
  id?: string | null;
  source?: string;
}

export interface ProgramStatement {
  id: string;
  op: string;
  line: number;
  source: string;
  /** The definition to apply; absent when the arguments were rejected. */
  view?: NativeOpView;
  error?: { message: string; field?: string };
  /** What was written, for diagnostics — identical to `view` when it exists. */
  attempted: NativeOpView;
}

export interface ProgramResult {
  ok: true;
  statements: ProgramStatement[];
  functions: Record<string, ParsedFunction>;
  /** Statements that did not parse, in line order; the others were compiled. */
  errors: ProgramSyntaxError[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function validatorFor(name: string) {
  let validate = validators.get(name);
  if (!validate) {
    validate = ajv.compile(NATIVE_BY_NAME.get(name)!.schema);
    validators.set(name, validate);
  }
  return validate;
}

/** Parse only: the Python subset's statements and functions, plus the
 * statements that did not parse (each positioned, each independent). */
export async function parseNativeProgram(program: string): Promise<{
  ok: true;
  statements: ParsedStatement[];
  functions: Record<string, ParsedFunction>;
  errors: ProgramSyntaxError[];
}> {
  return (await runNativePython({ program })) as any;
}

function attemptedView(statement: ParsedStatement, type: string, inputs: string[]): NativeOpView {
  // Diagnostic-only identity for a rejected statement: never compiled or wired.
  // The parsed arguments (not the raw text) identify it, so reordering keywords
  // or reformatting does not count as a correction.
  const view: NativeOpView = {
    type,
    properties: { op: statement.op, args: statement.args, kwargs: statement.kwargs },
    inputs,
    source: statement.source,
  };
  view.revision = nativeRevision(view);
  return view;
}

/** Normalize one parsed statement against the catalog. */
export function normalizeStatement(
  statement: ParsedStatement,
  functions: Record<string, ParsedFunction>,
  options: { profileCollection?: boolean; explicitInputs?: string[]; tables?: ReadonlySet<string> } = {}
): ProgramStatement {
  const base = { id: statement.id, op: statement.op, line: statement.line, source: statement.source };
  const def = NATIVE_BY_NAME.get(statement.op);
  if (!def) {
    const hint =
      statement.op === statement.id
        ? " The operator name goes on the right-hand side: `name = filter(...)`."
        : functions[statement.op]
          ? ` \`${statement.op}\` is a function you defined; call it through an operator, e.g. process(t, fn=${statement.op}) or filter(t, ${statement.op}).`
          : "";
    return {
      ...base,
      error: {
        message: `Unknown operator \`${statement.op}\`. Available: ${NATIVE_OPERATOR_NAMES.join(", ")}.${hint}`,
      },
      attempted: attemptedView(statement, "Unknown", []),
    };
  }
  let inputs: string[] = [];
  try {
    const split = options.explicitInputs
      ? { inputs: options.explicitInputs, rest: statement.args }
      : splitInputs(def, statement.args, functions, options.tables);
    inputs = split.inputs;
    const used = new Map<string, string>();
    const context = {
      functions,
      inputs,
      used: (slot: FunctionSlot) => {
        if (slot.ref) used.set(slot.ref, slot.source);
      },
    };
    const properties = def.normalize(split.rest, statement.kwargs, context);
    const validate = validatorFor(def.name);
    if (!validate(properties)) {
      const first = validate.errors?.[0];
      throw new NativeArgumentError(
        `${first?.instancePath || "arguments"} ${first?.message ?? "invalid"}${first?.params && "allowedValues" in first.params ? `: ${JSON.stringify((first.params as any).allowedValues)}` : ""}`,
        first?.instancePath?.replace(/^\//, "") || undefined
      );
    }
    const view: NativeOpView = { type: def.type, properties, inputs, source: statement.source };
    if (used.size) view.functions = Object.fromEntries(used);
    if (options.profileCollection === true) view.profileCollection = true;
    view.revision = nativeRevision(view);
    return { ...base, view, attempted: view };
  } catch (error) {
    if (error instanceof NativeArgumentError) {
      return {
        ...base,
        error: {
          message: `Invalid ${def.name} arguments: ${error.message} Signature: ${options.explicitInputs ? graphOperatorSignature(def) : def.signature}`,
          field: error.field,
        },
        attempted: attemptedView(statement, def.type, inputs),
      };
    }
    throw error;
  }
}

/** Parse and normalize a whole program. */
export async function compileProgram(
  program: string,
  options: { profileCollection?: boolean } = {}
): Promise<ProgramResult> {
  const parsed = await parseNativeProgram(program);
  return {
    ok: true,
    statements: parsed.statements.map(statement => normalizeStatement(statement, parsed.functions, options)),
    functions: parsed.functions,
    errors: parsed.errors ?? [],
  };
}
