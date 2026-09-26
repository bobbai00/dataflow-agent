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
  functionClosure,
  bindRegisteredCall,
  registeredSignature,
  show,
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

export interface NormalizeOptions {
  profileCollection?: boolean;
  sharedFunctions?: boolean;
  tableNames?: ReadonlySet<string>;
  /** A `def` of the program (or a shared one) may be called by name as an operator. */
  registeredOperators?: boolean;
}

/** Normalize one parsed statement against the catalog. */
export function normalizeStatement(
  statement: ParsedStatement,
  functions: Record<string, ParsedFunction>,
  options: NormalizeOptions = {}
): ProgramStatement {
  const base = { id: statement.id, op: statement.op, line: statement.line, source: statement.source };
  const def = NATIVE_BY_NAME.get(statement.op);
  if (!def) {
    const fn = functions[statement.op];
    if (fn && options.registeredOperators) return normalizeRegisteredCall(statement, fn, functions, options);
    const hint =
      statement.op === statement.id
        ? " The operator name goes on the right-hand side: `name = filter(...)`."
        : fn
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
    const split = splitInputs(def, statement.args, functions, options.tableNames);
    inputs = split.inputs;
    const used = usedFunctions(functions, options);
    const properties = def.normalize(split.rest, statement.kwargs, { functions, inputs, used: used.record });
    validated(def.name, properties);
    return { ...base, ...compiledView(def.type, properties, inputs, statement, split.references, used.map, options) };
  } catch (error) {
    if (error instanceof NativeArgumentError) {
      return {
        ...base,
        error: {
          message: `Invalid ${def.name} arguments: ${error.message} Signature: ${def.signature}`,
          field: error.field,
        },
        attempted: attemptedView(statement, def.type, inputs),
      };
    }
    throw error;
  }
}

/** `top_edu = band_report(cleaned, band_column="prevEducation")`: a `def`
 * called as an operator. The call binds the def's parameters like Python;
 * the arguments that name tables are the inputs, the literals are the
 * settings, and the docstring rendered with them is the doc. It compiles to a
 * process; the statement keeps the model's line as its source, so entries,
 * restores and forks treat it like any other statement. */
function normalizeRegisteredCall(
  statement: ParsedStatement,
  fn: ParsedFunction,
  functions: Record<string, ParsedFunction>,
  options: NormalizeOptions
): ProgramStatement {
  const base = { id: statement.id, op: statement.op, line: statement.line, source: statement.source };
  const process = NATIVE_BY_NAME.get("process")!;
  let inputs: string[] = [];
  try {
    const used = usedFunctions(functions, options);
    const call = bindRegisteredCall(
      fn,
      statement.args,
      statement.kwargs,
      { functions, inputs: [], used: used.record },
      options.tableNames
    );
    inputs = call.inputs;
    validated(process.name, call.properties);
    return { ...base, ...compiledView("Process", call.properties, inputs, statement, call.references, used.map, options) };
  } catch (error) {
    if (error instanceof NativeArgumentError) {
      return {
        ...base,
        error: {
          message: `Invalid ${fn.name} arguments: ${error.message} Signature: ${registeredSignature(fn)}`,
          field: error.field,
        },
        attempted: attemptedView(statement, "Process", inputs),
      };
    }
    throw error;
  }
}

/** Records the top-level `def`s a statement used, for rendering: with shared
 * functions each def of the closure by its own name, otherwise the slot's
 * whole source under the referenced name. */
function usedFunctions(functions: Record<string, ParsedFunction>, options: NormalizeOptions) {
  const map = new Map<string, string>();
  return {
    map,
    record: (slot: FunctionSlot) => {
      if (!slot.ref) return;
      if (options.sharedFunctions && functions[slot.ref]) {
        for (const fn of functionClosure(functions[slot.ref], functions)) map.set(fn.name, fn.source);
      } else map.set(slot.ref, slot.source);
    },
  };
}

function validated(name: string, properties: Record<string, unknown>): void {
  const validate = validatorFor(name);
  if (validate(properties)) return;
  const first = validate.errors?.[0];
  throw new NativeArgumentError(
    `${first?.instancePath || "arguments"} ${first?.message ?? "invalid"}${first?.params && "allowedValues" in first.params ? `: ${JSON.stringify((first.params as any).allowedValues)}` : ""}`,
    first?.instancePath?.replace(/^\//, "") || undefined
  );
}

function compiledView(
  type: string,
  properties: Record<string, unknown>,
  inputs: string[],
  statement: ParsedStatement,
  references: ReturnType<typeof splitInputs>["references"],
  used: Map<string, string>,
  options: NormalizeOptions
): { view: NativeOpView; attempted: NativeOpView } {
  const view: NativeOpView = { type, properties, inputs, source: statement.source };
  if (used.size) view.functions = Object.fromEntries(used);
  // Multi-task: keep what was written when an input reads a saved table, so
  // renders and task provenance show `at(name, task=N)`, not the source id.
  if (references.some(ref => typeof ref !== "string")) view.taskInputs = references;
  if (options.profileCollection === true) view.profileCollection = true;
  view.revision = nativeRevision(view);
  return { view, attempted: view };
}

/** Parse and normalize a whole program. */
export async function compileProgram(program: string, options: NormalizeOptions = {}): Promise<ProgramResult> {
  const parsed = await parseNativeProgram(program);
  return {
    ok: true,
    statements: parsed.statements.map(statement => normalizeStatement(statement, parsed.functions, options)),
    functions: parsed.functions,
    errors: parsed.errors ?? [],
  };
}
