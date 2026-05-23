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

import { useState } from "react";
import type { OperatorResultSummary, ReActStep } from "../types";

export function StepDetail({
  step,
  results,
}: {
  step: ReActStep | null;
  results: Record<string, OperatorResultSummary>;
}) {
  const [showInputs, setShowInputs] = useState(false);
  if (!step) return <div className="muted">Select a step.</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: "0.4rem" }}>
        <h3 style={{ margin: 0 }}>Step {step.stepId}</h3>
        <span className="muted">{step.role}</span>
        {step.usage && (
          <span className="muted">
            · in {step.usage.inputTokens ?? 0} / out {step.usage.outputTokens ?? 0}
            {step.usage.cachedInputTokens ? ` / cached ${step.usage.cachedInputTokens}` : ""}
          </span>
        )}
      </div>

      {step.content && (
        <>
          <h4>Content</h4>
          <div className="content-block">{step.content}</div>
        </>
      )}

      {step.toolCalls?.map(tc => {
        const result = step.toolResults?.find(r => r.toolCallId === tc.toolCallId);
        const isError = !!result?.isError;
        // For ops that produce a result row preview, render it as a table.
        // The wire shape from `operator-results` carries `sampleRecords`;
        // we look it up by the operator id the tool call refers to.
        const opId = typeof tc.input?.operatorId === "string" ? tc.input.operatorId : undefined;
        const opResult = opId ? results[opId] : undefined;
        return (
          <div key={tc.toolCallId} className="tool-block">
            <div className="tool-header">
              <span className="tool-name">{tc.toolName}</span>
              {isError && <span className="pill state-STOPPING">error</span>}
            </div>
            <div className="tool-section">
              <div className="label">Input</div>
              <pre className="json">{JSON.stringify(tc.input, null, 2)}</pre>
            </div>
            {result && (
              <div className="tool-section">
                <div className="label">Output</div>
                <pre className={`json ${isError ? "error" : ""}`}>
                  {typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)}
                </pre>
              </div>
            )}
            {opResult?.sampleRecords && opResult.sampleRecords.length > 0 && (
              <div className="tool-section">
                <div className="label">
                  Operator preview ({opResult.totalRowCount ?? opResult.sampleRecords.length} rows total)
                </div>
                <RecordsTable records={opResult.sampleRecords} />
              </div>
            )}
            {opResult?.error && (
              <div className="tool-section error">
                <div className="label">Operator error</div>
                <div>{opResult.error}</div>
              </div>
            )}
            {opResult?.warnings && opResult.warnings.length > 0 && (
              <div className="tool-section warning">
                <div className="label">Warnings</div>
                {opResult.warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {step.inputMessages && step.inputMessages.length > 0 && (
        <>
          <button className="ghost" onClick={() => setShowInputs(s => !s)}>
            {showInputs ? "Hide" : "Show"} input messages ({step.inputMessages.length})
          </button>
          {showInputs && <pre className="json">{JSON.stringify(step.inputMessages, null, 2)}</pre>}
        </>
      )}
    </>
  );
}

function RecordsTable({ records }: { records: Record<string, unknown>[] }) {
  if (records.length === 0) return <div className="muted">(empty)</div>;
  // Use the union of keys across the first ~5 rows. The agent service
  // serializes results uniformly enough that the first record's shape is
  // almost always representative, but widening to a few rows guards
  // against ragged objects without scanning the whole sample.
  const keys = new Set<string>();
  for (const r of records.slice(0, 5)) for (const k of Object.keys(r)) keys.add(k);
  const cols = [...keys].filter(k => k !== "__row_index__");
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="records">
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td key={c} title={String(r[c] ?? "")}>
                  {formatCell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
