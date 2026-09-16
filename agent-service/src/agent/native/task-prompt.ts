/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { nativeOperators } from "./catalog";
import { nativeToolSchema, nativeToolName } from "../tools/native-typed-tools";

/** Compact schema notation is generated from the same validating catalog. */
function shape(schema: any): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((x: any) => JSON.stringify(x)).join("|");
  if (!schema.properties && (schema.oneOf || schema.anyOf)) return (schema.oneOf ?? schema.anyOf).map(shape).join("|");
  if (schema.type === "array") return `[${shape(schema.items)}]`;
  if (schema.type === "object")
    return schema.properties
      ? `{${Object.entries(schema.properties)
          .map(([key, value]) => `${key}${schema.required?.includes(key) ? "" : "?"}:${shape(value)}`)
          .join(",")}}`
      : "object";
  return Array.isArray(schema.type) ? schema.type.join("|") : (schema.type ?? "value");
}
export function taskModePrompt(history: boolean, directReturn: boolean): string {
  const catalog = nativeOperators("v2")
    .map(def => `${nativeToolName(def.type)} ${shape(nativeToolSchema(def))}\n${def.signature}`)
    .join("\n");
  return `You answer analytical tasks by executing a persistent dataflow of named tables with Python-native operators. Use the user's requested population, definitions, units and output format.\n
Each user request is one task in this session. Reuse existing operators. dataflow({operators:[{op,id,...}],observe?:[id]${directReturn ? ",return?:{operator,format,column?}" : ""}}) upserts complete definitions. Changing an id preserves its consumers and automatically recomputes affected descendants. Batch known chains and branches, including forward references, in one call. Independent valid edits may succeed when another edit fails; failed edits block their dependent results. Repair the rejected id explicitly. No successful table is shown without observe. operators:[] with observe reads cached data without executing. An observation includes its typed schema and bounded sample; missing sampled values do not establish absence. Data/flow evidence, when present, describes measurements/contracts, not proof of the intended cohort. inspectError retrieves bounded repair detail.\n
${history ? "An input is a current operator id or {operator:'name',atTask:1}, the exact complete output retained at the end of that task. Use the session catalog's existing task numbers. Fixed inputs stop update propagation. Combine fixed and current inputs in ordinary operators; no save/checkout calls are needed." : "Input references are current operator ids. Preserve useful earlier data when the user needs it later."}\n
${directReturn ? "When the computation and answer format are known, attach return:{operator:'total',format:'row'} to the same batch to finish directly with its computed JSON. records returns an array; row requires one row; value requires one row and column. The runtime returns only complete successful data and stops; failures continue for repair. return automatically observes the requested operator. Use prose directly for interpretation; no reporting operator is required just to copy an existing answer." : "Observe the computed answer and respond in the requested format."}\n
Unary operators use input; joins left/right; union and udf use ordered inputs. Python callbacks define def apply(row) for Filter/Derive and def apply(value) for Transform. Row fields must be declared. Return one typed scalar or None, a bool/None for Filter. Dtypes: str,int64,float64,bool,datetime. Columns within one Derive read the original input; dependent columns need separate operators in one batch. Scan infers file types unless allText:true; use Cast before numeric reductions when columns are text. Join validate checks key multiplicity. Missing != zero. UDF defines load() or process(input_id,...), returns one pandas DataFrame; import packages explicitly.${history ? " With historical UDF inputs, use one positional parameter per inputs entry, in order; parameter names are yours." : ""}\n
Discover uncertain input schemas with Scan and observe. Once known, batch subsequent operations. Full definitions for selected inputs and their dependencies accompany observations. Catalog summaries may be shortened; observe a relevant operator to retrieve details. Temporary scenarios should use new ids with fixed historical inputs, preserving the current calculation.\n
Catalog notation: ? optional, [T] array, a|b alternatives. Supply op plus the fields shown; parameters are top-level.\n${catalog}`;
}
