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
import { parseNativeDiagnostic, nativeDiagnosticIssue, resolveNativeDiagnostic } from "../native/diagnostics";
import { nativeOperatorName } from "../native/catalog";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import {
  selectNativeObservation,
  type NativeEvidenceContext,
  type NativeObservation,
  type NativeObservationOptions,
} from "../native/evidence";
import type { WorkflowState } from "../workflow-state";
import { shareNativeObservation } from "../native/evidence-compaction";
import { getVisibleResultHeaders } from "./tools-utility";

export interface FormatOperatorResultOptions {
  /** V2 evidence shares the result body budget. A recorded DELTA frame wins
   * over today's exposure settings. */
  nativeEvidence?: Pick<NativeEvidenceContext, "workflow" | "resolveInput"> &
    NativeObservationOptions & { frozen?: NativeObservation; sharedUpstream?: Map<string, string> };
  /** The operator definition that earned this result. Historical observations
   *  must echo failed parameters/code from their snapshot, not a later edit
   *  (or deletion) in the live DAG. Undefined keeps the current-state lookup. */
  operatorAtEvent?: OperatorPredicate;
  /** W1: cap the TSV sample to first ceil(N/2) + last floor(N/2) rows (a true
   *  row count, vs the char-budget proxy). 0/undefined = no cap. */
  maxResultRows?: number;
  /** Resolve an input's COLUMN count from its upstream operator's output. The
   *  engine's input port metrics carry only the row count (tuple count), so the
   *  caller (which has the snapshot) supplies this to fill in `M cols` on the
   *  `Inputs:` shape line. Returns undefined when unknown. */
  resolveInputColumns?: (upstreamOpId: string) => number | undefined;
}

/** Wide DataFrames blow up Latest-mode context because the whole result is
 *  re-echoed every turn. Cap both the TSV preview and the stats block at
 *  this many columns: keep the first half and the last half, drop the
 *  middle, and surface a "(showing N of M columns)" notice so the agent
 *  knows the view is truncated. Defaults chosen to keep an 8-turn run on
 *  a 300-column table well under 100k input tokens. */
const MAX_DISPLAYED_COLUMNS = 50;

/** Whether `operatorId` reads, directly or through other operators, from
 * `rootId`. Walks the native inputs of the workflow as it was at the event
 * (historical renders must not consult a later edit), else the live state. */
export function readsFrom(
  operatorId: string,
  rootId: string,
  workflow: WorkflowContent | undefined,
  workflowState: WorkflowState
): boolean {
  const inputsOf = (id: string): string[] => {
    const op = workflow?.operators.find(o => o.operatorID === id) ?? workflowState.getOperator(id);
    if (op?.nativeOp) return op.nativeOp.inputs;
    const links = workflow?.links ?? workflowState.getAllLinks();
    return links.filter(l => l.target.operatorID === id).map(l => l.source.operatorID);
  };
  const seen = new Set<string>();
  const stack = [operatorId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const input of inputsOf(id)) {
      if (input === rootId) return true;
      if (!seen.has(input)) {
        seen.add(input);
        stack.push(input);
      }
    }
  }
  return false;
}

export function formatOperatorResult(
  operatorId: string,
  opInfo: OperatorInfo,
  workflowState: WorkflowState,
  options: FormatOperatorResultOptions = {}
): string {
  const eventOp = options.operatorAtEvent ?? workflowState.getOperator(operatorId);
  if (opInfo.error && eventOp?.nativeOp) {
    const diagnostic =
      opInfo.nativeError?.diagnostic ??
      resolveNativeDiagnostic(
        eventOp,
        opInfo.error,
        id =>
          options.nativeEvidence?.workflow.operators.find(op => op.operatorID === id) ?? workflowState.getOperator(id)
      );
    const rootInfo = options.nativeEvidence?.resolveInput(diagnostic.operatorId);
    const rootDiagnostic =
      rootInfo?.nativeError?.diagnostic ?? (rootInfo?.error ? parseNativeDiagnostic(rootInfo.error) : undefined);
    const name = `${eventOp.nativeOp.registeredName ?? nativeOperatorName(eventOp.nativeOp.type)} \`${operatorId}\``;
    if (diagnostic.operatorId !== operatorId) {
      // The engine aborts the whole run at the first failure and hands every
      // unfinished operator the same payload. Say which case this is: a
      // consumer of the failed operator, or a bystander whose own definition is
      // not implicated and which merely needs that operator repaired or removed.
      const reads = readsFrom(operatorId, diagnostic.operatorId, options.nativeEvidence?.workflow, workflowState);
      const rootConfirmed =
        rootInfo?.error &&
        rootDiagnostic?.operatorId === diagnostic.operatorId &&
        rootDiagnostic.operatorRevision === diagnostic.operatorRevision &&
        rootDiagnostic.code === diagnostic.code;
      if (!reads) {
        return `- not run: ${name}; the run stopped when \`${diagnostic.operatorId}\` failed (${diagnostic.code}). \`${operatorId}\` does not read from \`${diagnostic.operatorId}\`, so its own definition is not implicated; it runs once that operator is repaired or deleted.`;
      }
      if (rootConfirmed) {
        return `- not run: ${name}; upstream \`${diagnostic.operatorId}\` failed (${diagnostic.code}). Repair that operator; this consumer did not run.`;
      }
    }
    return (
      (diagnostic.operatorId !== operatorId
        ? `- not run: ${name}; upstream \`${diagnostic.operatorId}\` failed (${diagnostic.code}).\n`
        : "") +
      nativeDiagnosticIssue(diagnostic) +
      (opInfo.nativeError?.phase === "attempt" ? "\n- note: rejected edit; dataflow definition unchanged." : "")
    );
  }
  if (opInfo.error) {
    // Old-style error rendering: the ENGINE error message carries only the
    // exception + user-code line pointer (the worker no longer echoes source);
    // the operator's code is appended HERE, from the DAG's own
    // operatorProperties — so the agent still sees exactly what code failed,
    // without the engine duplicating it into every error payload.
    const op = options.operatorAtEvent ?? workflowState.getOperator(operatorId);
    const code = String((op?.operatorProperties as Record<string, unknown> | undefined)?.code ?? "").trim();
    const codeBlock = code ? `\nOperator code:\n${code}` : "";
    return `[ERROR] ${opInfo.error}${codeBlock}`;
  }

  if (!opInfo.result || !Array.isArray(opInfo.result)) {
    return "(no result data)";
  }

  const nativeOp = options.operatorAtEvent ?? workflowState.getOperator(operatorId);
  if (nativeOp?.nativeOp) {
    const evidence = options.nativeEvidence;
    if (evidence?.frozen)
      return shareNativeObservation(evidence.frozen.text, evidence.frozen, operatorId, evidence.sharedUpstream);
    const budget = evidence?.maxChars ?? 2000;
    const observation = selectNativeObservation({
      ...evidence,
      workflow: evidence?.workflow ?? workflowState.getWorkflowContent(),
      resolveInput: evidence?.resolveInput ?? (() => undefined),
      op: nativeOp,
      info: opInfo,
      data: evidence?.data ?? false,
      flow: evidence?.flow ?? false,
      maxChars: budget,
      maxRows: options.maxResultRows,
    });
    return shareNativeObservation(observation.text, observation, operatorId, evidence?.sharedUpstream);
  }

  const jsonArray = opInfo.result as Record<string, any>[];
  const headers = jsonArray.length > 0 ? getVisibleResultHeaders(jsonArray[0]) : [];
  const columns = headers.length;
  const columnsTruncated = columns > MAX_DISPLAYED_COLUMNS;

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

  // W1 (row-based sampling): a TRUE row cap — keep first ceil(N/2) + last
  // floor(N/2) rows (the original row objects keep `__row_index__`, so
  // jsonToTableFormat renders the `...` gap). Cleaner than the char-budget
  // proxy. 0/undefined = no cap (current behavior). Cell-level trim is
  // unaffected (it happens downstream in the TSV renderer / backend).
  let sampleRows = serializableArray;
  const cap = options.maxResultRows ?? 0;
  if (cap > 0 && sampleRows.length > cap) {
    const head = Math.ceil(cap / 2);
    const tail = Math.floor(cap / 2);
    sampleRows =
      tail > 0
        ? [...sampleRows.slice(0, head), ...sampleRows.slice(sampleRows.length - tail)]
        : sampleRows.slice(0, head);
  }
  const dataString = jsonToTableFormat(sampleRows);

  const metadataLines = [
    formatInputOutputMetadata(workflowState, operatorId, opInfo, columns, options.resolveInputColumns),
    columnsTruncated
      ? `(showing first ${Math.ceil(MAX_DISPLAYED_COLUMNS / 2)} and last ${Math.floor(MAX_DISPLAYED_COLUMNS / 2)} of ${columns} columns)`
      : "",
    ...(opInfo.warnings ?? []),
  ].filter(Boolean);

  // Layout: shape metadata (Inputs / Output Table), then the result TABLE (TSV).
  return [...metadataLines, dataString].filter(Boolean).join("\n");
}

function formatInputOutputMetadata(
  workflowState: WorkflowState,
  operatorId: string,
  opInfo: OperatorInfo,
  outputColumns: number,
  resolveInputColumns?: (upstreamOpId: string) => number | undefined
): string {
  const outputRows = opInfo.totalRowCount ?? opInfo.outputTuples;
  const outputLine = `Output Table: ${outputRows} rows, ${outputColumns} cols`;

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
      const upstreamId = portIndexToUpstream.get(p.portIndex);
      const name = upstreamId ?? `input${p.portIndex}`;
      const rowsPart = typeof p.rows === "number" ? `${p.rows} rows` : undefined;
      // Input column count isn't in the engine's port metrics — resolve it from
      // the upstream operator's output column count.
      const cols =
        typeof p.columns === "number" ? p.columns : upstreamId ? resolveInputColumns?.(upstreamId) : undefined;
      const colsPart = typeof cols === "number" ? `${cols} cols` : undefined;
      const shape = [rowsPart, colsPart].filter(Boolean).join(", ");
      return shape ? `${name} (${shape})` : name;
    })
    .join(", ");

  // Descriptive, single line: names each input by its SOURCE OPERATOR id (an
  // operator's output IS this operator's input — see the chaining principle in
  // the system prompt), so the model can trace a column back to the operator
  // whose Result section defines it.
  return `Inputs: ${inputPart}\n${outputLine}`;
}

function jsonToTableFormat(jsonResult: Record<string, any>[]): string {
  if (!jsonResult || jsonResult.length === 0) return "";

  const hasRowIndex = "__row_index__" in jsonResult[0];
  const allHeaders = getVisibleResultHeaders(jsonResult[0]);
  if (allHeaders.length === 0) return "";

  // Wide tables: render only the first half + last half of columns, joined
  // by a `...` separator (mirrors pandas display). The headline metadata
  // line in formatOperatorResult already announces the truncation.
  const totalCols = allHeaders.length;
  const truncated = totalCols > MAX_DISPLAYED_COLUMNS;
  let leftHeaders: string[];
  let rightHeaders: string[];
  if (truncated) {
    const leftCount = Math.ceil(MAX_DISPLAYED_COLUMNS / 2);
    const rightCount = Math.floor(MAX_DISPLAYED_COLUMNS / 2);
    leftHeaders = allHeaders.slice(0, leftCount);
    rightHeaders = allHeaders.slice(-rightCount);
  } else {
    leftHeaders = allHeaders;
    rightHeaders = [];
  }

  const renderHeader = (hs: string[]) => hs.join("\t");
  const headerLine = truncated
    ? "\t" + renderHeader(leftHeaders) + "\t...\t" + renderHeader(rightHeaders)
    : "\t" + renderHeader(leftHeaders);

  const renderCell = (val: unknown): string => {
    if (val === null) return "NaN";
    if (val === undefined) return "";
    if (typeof val === "number" || typeof val === "boolean") return String(val);
    if (typeof val === "string") {
      if (val === "NULL") return "NaN";
      return val.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
    }
    return JSON.stringify(val);
  };

  const formattedRows: string[] = [];
  let prevIndex = -1;
  for (let i = 0; i < jsonResult.length; i++) {
    const row = jsonResult[i];
    const rowIndex = hasRowIndex ? (row["__row_index__"] as number) : i;

    if (prevIndex >= 0 && rowIndex > prevIndex + 1) {
      // Row gap separator. Columns are already capped; just emit one `...` per visible cell.
      const visibleCols = truncated ? leftHeaders.length + 1 + rightHeaders.length : leftHeaders.length;
      const dots = Array(visibleCols).fill("...").join("\t");
      formattedRows.push(`...\t${dots}`);
    }
    prevIndex = rowIndex;

    const leftCells = leftHeaders.map(h => renderCell(row[h]));
    const rightCells = rightHeaders.map(h => renderCell(row[h]));
    const cells = truncated ? [...leftCells, "...", ...rightCells] : leftCells;
    formattedRows.push(`${rowIndex}\t${cells.join("\t")}`);
  }

  return [headerLine, ...formattedRows].join("\n");
}
