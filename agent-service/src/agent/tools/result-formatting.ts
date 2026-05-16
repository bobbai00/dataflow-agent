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

import type { OperatorInfo } from "../../types/execution";
import type { WorkflowState } from "../workflow-state";
import { formatExecuteOperatorResult } from "./tools-utility";

export interface FormatOperatorResultOptions {
  /** When true and `opInfo.columnStats` is a non-empty map, append a
   *  `Column stats:` block — one indented line per column. Errors are
   *  rendered the same way regardless. Defaults to false. */
  statsEnabled?: boolean;
}

export function formatOperatorResult(
  operatorId: string,
  opInfo: OperatorInfo,
  workflowState: WorkflowState,
  options: FormatOperatorResultOptions = {}
): string {
  if (opInfo.error) {
    return `[ERROR] ${opInfo.error}`;
  }

  if (!opInfo.result || !Array.isArray(opInfo.result)) {
    return "(no result data)";
  }

  const jsonArray = opInfo.result as Record<string, any>[];
  const headers =
    jsonArray.length > 0
      ? Object.keys(jsonArray[0]).filter(k => k !== "__row_index__" && k !== "__is_visualization__")
      : [];
  const columns = headers.length;

  const isViz = jsonArray.length > 0 && jsonArray[0]["__is_visualization__"] === true;
  const serializableArray = isViz
    ? jsonArray.map(row => {
        const cleaned: Record<string, any> = {};
        for (const key of Object.keys(row)) {
          if (key === "__is_visualization__") continue;
          if (key === "html-content" || key === "json-content") {
            cleaned[key] = "<skipped: visualization content>";
          } else {
            cleaned[key] = row[key];
          }
        }
        return cleaned;
      })
    : jsonArray;

  const dataString = jsonToTableFormat(serializableArray);

  const metadataLines = [
    formatInputOutputMetadata(workflowState, operatorId, opInfo, columns),
    ...(opInfo.warnings ?? []),
  ].filter(Boolean);

  const briefSummary = formatExecuteOperatorResult(operatorId);
  const statsBlock = options.statsEnabled ? formatColumnStats(opInfo.columnStats) : undefined;
  return [briefSummary, ...metadataLines, dataString, statsBlock].filter(Boolean).join("\n");
}

/**
 * Render a `Column stats:` block from `OperatorInfo.columnStats`.
 * The backend's per-column annotation is already a `Record<column, string>`,
 * so we just sort by column name and emit one indented line per column.
 * Returns `undefined` when the map is missing, empty, or otherwise unhelpful
 * (caller treats `undefined` as "omit this section entirely").
 */
function formatColumnStats(stats: Record<string, string> | undefined): string | undefined {
  if (!stats) return undefined;
  const entries = Object.entries(stats).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (entries.length === 0) return undefined;
  entries.sort(([a], [b]) => a.localeCompare(b));
  const lines = ["Column stats:"];
  for (const [col, stat] of entries) lines.push(`  ${col}: ${stat}`);
  return lines.join("\n");
}

function formatInputOutputMetadata(
  workflowState: WorkflowState,
  operatorId: string,
  opInfo: OperatorInfo,
  outputColumns: number
): string {
  const outputRows = opInfo.totalRowCount ?? opInfo.outputTuples;
  const outputLine = `Output table shape: (${outputRows}, ${outputColumns})`;

  const inputShapes = opInfo.inputPortShapes;
  if (!inputShapes || inputShapes.length === 0) {
    return outputLine;
  }

  const inputLinks = workflowState.getAllLinks().filter(l => l.target.operatorID === operatorId);
  const portIndexToUpstream = new Map<number, string>();
  const op = workflowState.getOperator(operatorId);
  for (const link of inputLinks) {
    const portIdx = op?.inputPorts.findIndex(p => p.portID === link.target.portID) ?? -1;
    if (portIdx >= 0) {
      portIndexToUpstream.set(portIdx, link.source.operatorID);
    }
  }

  const inputPart = inputShapes
    .sort((a, b) => a.portIndex - b.portIndex)
    .map(p => {
      const name = portIndexToUpstream.get(p.portIndex) ?? `input${p.portIndex}`;
      return `${name}(${p.rows}, ${p.columns})`;
    })
    .join(", ");

  return `Input operator(table shape): ${inputPart}\n${outputLine}`;
}

function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const hasRowIndex = "__row_index__" in jsonResult[0];
  const headers = Object.keys(jsonResult[0]).filter(h => h !== "__row_index__");
  if (headers.length === 0) return "";

  const headerLine = "\t" + headers.join("\t");
  const formattedRows: string[] = [];
  let prevIndex = -1;

  for (let i = 0; i < jsonResult.length; i++) {
    const row = jsonResult[i];
    const rowIndex = hasRowIndex ? (row["__row_index__"] as number) : i;

    if (prevIndex >= 0 && rowIndex > prevIndex + 1) {
      const dots = headers.map(() => "...").join("\t");
      formattedRows.push(`...\t${dots}`);
    }
    prevIndex = rowIndex;

    const cells = headers.map(h => {
      const val = row[h];
      if (val === null) return "NaN";
      if (val === undefined) return "";
      if (typeof val === "number" || typeof val === "boolean") return String(val);
      if (typeof val === "string") {
        if (val === "NULL") return "NaN";
        return val.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
      }
      return JSON.stringify(val);
    });
    formattedRows.push(`${rowIndex}\t${cells.join("\t")}`);
  }

  return [headerLine, ...formattedRows].join("\n");
}
