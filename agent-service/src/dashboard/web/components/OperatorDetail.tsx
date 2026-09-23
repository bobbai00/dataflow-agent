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
import type { OperatorPredicate, OperatorResultSummary } from "../types";

/**
 * Right-pane detail card for one operator. Reads everything from the
 * server-built `OperatorResultSummary` — for imported traces, the
 * agent service's `importReActSteps` parses each step's `inputMessages`
 * and writes recovered results into `WorkflowSnapshotStorage`, so this
 * component is symmetric across live and imported agents.
 */
export function OperatorDetail({
  operator,
  result,
  onClose,
}: {
  operator: OperatorPredicate;
  result?: OperatorResultSummary;
  onClose?: () => void;
}) {
  const [showCode, setShowCode] = useState(false);
  const [showStats, setShowStats] = useState(false);

  const code = typeof operator.operatorProperties?.code === "string"
    ? (operator.operatorProperties.code as string)
    : undefined;
  const errorText = result?.error;
  const failed = !!errorText || result?.state === "Failed";
  const completed = !failed && result?.state === "Completed";

  return (
    <div className="op-detail">
      <div className="op-detail-head">
        <div className="row" style={{ flex: 1, minWidth: 0 }}>
          <span className={`pill ${failed ? "state-STOPPING" : completed ? "state-AVAILABLE" : ""}`}>
            {failed ? "Failed" : completed ? "Completed" : "Unknown"}
          </span>
          <strong className="mono">{operator.operatorID}</strong>
          <span className="muted">({operator.operatorType})</span>
        </div>
        {onClose && (
          <button className="ghost" onClick={onClose} title="Close">
            ✕
          </button>
        )}
      </div>

      {operator.customDisplayName && (
        <div className="op-detail-summary">{operator.customDisplayName}</div>
      )}

      <div className="op-detail-meta">
        <span>
          inputs <strong>{operator.inputPorts?.length ?? 0}</strong>
        </span>
        <span>
          outputs <strong>{operator.outputPorts?.length ?? 0}</strong>
        </span>
        {result?.totalRowCount !== undefined && (
          <span>
            rows <strong>{result.totalRowCount.toLocaleString()}</strong>
          </span>
        )}
        {result?.outputColumns !== undefined && (
          <span>
            cols <strong>{result.outputColumns}</strong>
          </span>
        )}
      </div>

      {errorText && (
        <div className="op-detail-error">
          <div className="label">Error</div>
          <pre className="mono">{errorText}</pre>
        </div>
      )}

      {result?.warnings && result.warnings.length > 0 && (
        <div className="op-detail-warnings">
          <div className="label">Warnings</div>
          {result.warnings.map((w, i) => (
            <div key={i} className="mono">
              {w}
            </div>
          ))}
        </div>
      )}

      {result?.sampleRecords && result.sampleRecords.length > 0 && (
        <div className="op-detail-section">
          <div className="label">
            Output preview
            {result.totalRowCount !== undefined && result.outputColumns !== undefined
              ? ` (${result.totalRowCount.toLocaleString()} × ${result.outputColumns}; showing ${result.sampleRecords.length})`
              : ""}
          </div>
          <RecordsTable records={result.sampleRecords} />
        </div>
      )}

      {result?.columnStats && Object.keys(result.columnStats).length > 0 && (
        <div className="op-detail-section">
          <button className="ghost" onClick={() => setShowStats(s => !s)}>
            {showStats ? "Hide" : "Show"} column stats ({Object.keys(result.columnStats).length})
          </button>
          {showStats && (
            <div className="op-detail-stats">
              {Object.entries(result.columnStats)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([col, stat]) => (
                  <div key={col} className="op-stat-row">
                    <span className="op-stat-col mono">{col}</span>
                    <span className="op-stat-val mono">{stat}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {code && (
        <div className="op-detail-section">
          <button className="ghost" onClick={() => setShowCode(s => !s)}>
            {showCode ? "Hide" : "Show"} code ({code.split("\n").length} lines)
          </button>
          {showCode && <pre className="op-detail-code mono">{code}</pre>}
        </div>
      )}

      {/* Additional metadata block — anything we haven't already rendered
          via dedicated fields. Useful for GUI-authored operators with
          non-`code` properties (KeywordSearch's `keyword`, Filter's
          `predicates`, etc.). */}
      {operator.operatorProperties && Object.keys(operator.operatorProperties).filter(k => k !== "code").length > 0 && (
        <div className="op-detail-section">
          <div className="label">Other properties</div>
          <pre className="op-detail-props mono">
            {JSON.stringify(
              Object.fromEntries(Object.entries(operator.operatorProperties).filter(([k]) => k !== "code")),
              null,
              2
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

function RecordsTable({ records }: { records: Record<string, unknown>[] }) {
  const keys = new Set<string>();
  for (const r of records.slice(0, 5)) for (const k of Object.keys(r)) keys.add(k);
  const cols = [...keys].filter(k => k !== "__row_index__");
  return (
    <div style={{ overflowX: "auto", maxHeight: 320 }}>
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
