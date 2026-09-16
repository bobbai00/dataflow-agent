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
import { isSuccessfulOperatorResult, type OperatorInfo } from "../../types/execution";

export interface DirectReturn {
  operator: string;
  format: "records" | "columns" | "row" | "value" | "json";
  column?: string;
}
export const directReturnSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operator", "format"],
  properties: {
    operator: {
      type: "string",
      description: "Current output to return as the final JSON answer after this batch succeeds.",
    },
    format: {
      type: "string",
      enum: ["records", "columns", "row", "value", "json"],
      description:
        "records = array of rows; columns = object of column arrays; row = exactly one row; value = one named cell; json = JSON document in one named string cell. value/json require exactly one row.",
    },
    column: { type: "string", description: "Required for value/json." },
  },
};

/** Only complete, typed materialized results can bypass another model call. */
export function resolveDirectReturn(request: DirectReturn, info?: OperatorInfo): string {
  if (
    !info ||
    !isSuccessfulOperatorResult(info) ||
    info.resultMode !== "table" ||
    !Array.isArray(info.result) ||
    info.truncated !== false ||
    info.totalRowCount !== info.result.length ||
    info.displayedRows !== info.result.length ||
    !info.resultSchema
  )
    throw new Error(
      `Cannot return ${request.operator}: a complete successful table is required. Observe the result or compute a smaller answer.`
    );
  const columns = info.resultSchema.map(field => field.name);
  const rows = info.result.map(row =>
    Object.fromEntries(
      columns.map(column => {
        if (!Object.hasOwn(row, column)) throw new Error(`Missing field ${column} in returned result`);
        return [column, row[column]];
      })
    )
  );
  if (request.format === "records") return JSON.stringify(rows);
  if (request.format === "columns")
    return JSON.stringify(Object.fromEntries(columns.map(column => [column, rows.map(row => row[column])])));
  if (rows.length !== 1) throw new Error(`${request.format} requires exactly one row`);
  if (request.format === "row") return JSON.stringify(rows[0]);
  if (!["value", "json"].includes(request.format) || !request.column || !columns.includes(request.column))
    throw new Error("value/json require an existing column");
  const value = rows[0]![request.column];
  if (request.format === "json") {
    if (typeof value !== "string") throw new Error("json requires a string cell containing a JSON document");
    JSON.parse(value); // Validate only: re-encoding could round exact int64 text.
    return value;
  }
  return JSON.stringify(value);
}
