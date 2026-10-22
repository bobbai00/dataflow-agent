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
 * The edit form of a native operator: its `set` statement split the way it
 * was written (python/registered.py `describe_set_statement`), so the canvas
 * can offer one field per argument and put the statement back together from
 * the fields' source text.
 */
import type { WorkflowContent } from "../../types/workflow";
import { nativeAssignmentText, type NativeOpView } from "./catalog";
import { runNativePython } from "./codegen";

export type StatementFieldKind = "string" | "number" | "boolean" | "strings" | "lambda" | "code";

export interface StatementField {
  /** The argument's Python source, as written. */
  source: string;
  kind: StatementFieldKind;
  /** The literal's value, for the kinds a form can edit without source. */
  value?: string | number | boolean | string[];
}

export interface StatementKeyword extends StatementField {
  name: string;
}

export interface NativeStatementForm {
  id: string;
  /** What the statement calls: a built-in (`filter`) or a registered function (`widen`). */
  op: string;
  inputs: string[];
  /** Positional arguments after the inputs: a filter's condition, a map's row function. */
  positional: StatementField[];
  /** Keyword arguments in call order, without `doc`. */
  keywords: StatementKeyword[];
  doc?: string;
  /** The statement as it stands. */
  statement: string;
  /** The registered Python function the statement calls, when it calls one. */
  definition?: { name: string; signature: string; source: string };
}

export async function describeNativeStatement(
  id: string,
  view: NativeOpView,
  workflow: WorkflowContent
): Promise<NativeStatementForm> {
  const statement = nativeAssignmentText(id, view);
  if (!statement?.startsWith("set ")) throw new Error(`\`${id}\` was not written as a set statement.`);
  const response = (await runNativePython({ registered: true, phase: "describe", changes: statement })) as {
    ok: boolean;
    error?: string;
    statement?: { op: string; inputs: string[]; positional: StatementField[]; keywords: StatementKeyword[] };
  };
  if (!response.ok || !response.statement) throw new Error(response.error ?? "The statement could not be read.");
  const { op, inputs, positional, keywords } = response.statement;
  const doc = keywords.find(keyword => keyword.name === "doc");
  const fn = view.registeredName ? workflow.nativeNamespace?.functions[view.registeredName] : undefined;
  return {
    id,
    op,
    inputs,
    positional,
    keywords: keywords.filter(keyword => keyword !== doc),
    ...(doc?.kind === "string" ? { doc: String(doc.value) } : {}),
    statement,
    ...(fn ? { definition: { name: fn.name, signature: fn.signature, source: fn.source } } : {}),
  };
}
