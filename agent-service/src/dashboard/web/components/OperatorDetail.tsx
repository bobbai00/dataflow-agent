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
import type { ParsedOperatorResult } from "../util/parse-operator-results";

/**
 * Right-pane detail card for one operator. Renders whatever data is
 * available — for imported traces the `parsed` block (from
 * `inputMessages`) is usually present; for live agents the live
 * `result` summary from `/snapshots/:stepId` is richer.
 */
export function OperatorDetail({
  operator,
  parsed,
  result,
  onClose,
}: {
  operator: OperatorPredicate;
  parsed?: ParsedOperatorResult;
  result?: OperatorResultSummary;
  onClose?: () => void;
}) {
  const [showCode, setShowCode] = useState(false);
  const [showStats, setShowStats] = useState(false);

  const code = typeof operator.operatorProperties?.code === "string"
    ? (operator.operatorProperties.code as string)
    : undefined;
  const errorText = parsed?.error || result?.error;
  const failed = !!errorText || parsed?.state === "failed";
  const completed = !failed && (parsed?.state === "completed" || result?.state === "Completed");

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

      {(operator.customDisplayName || parsed?.summary) && (
        <div className="op-detail-summary">
          {operator.customDisplayName || parsed?.summary}
        </div>
      )}

      <div className="op-detail-meta">
        <span>
          inputs <strong>{operator.inputPorts?.length ?? 0}</strong>
        </span>
        <span>
          outputs <strong>{operator.outputPorts?.length ?? 0}</strong>
        </span>
        {parsed?.outputShape && (
          <>
            <span>
              rows <strong>{parsed.outputShape.rows.toLocaleString()}</strong>
            </span>
            <span>
              cols <strong>{parsed.outputShape.columns}</strong>
            </span>
          </>
        )}
        {!parsed?.outputShape && result?.totalRowCount !== undefined && (
          <span>
            rows <strong>{result.totalRowCount.toLocaleString()}</strong>
          </span>
        )}
      </div>

      {errorText && (
        <div className="op-detail-error">
          <div className="label">Error</div>
          <pre className="mono">{errorText}</pre>
        </div>
      )}

      {parsed?.warnings && parsed.warnings.length > 0 && (
        <div className="op-detail-warnings">
          <div className="label">Warnings</div>
          {parsed.warnings.map((w, i) => (
            <div key={i} className="mono">
              {w}
            </div>
          ))}
        </div>
      )}

      {parsed?.tsv && (
        <div className="op-detail-section">
          <div className="label">Output preview ({parsed.outputShape ? `${parsed.outputShape.rows} × ${parsed.outputShape.columns}` : "TSV"})</div>
          <TsvTable tsv={parsed.tsv} />
        </div>
      )}
      {!parsed?.tsv && result?.sampleRecords && result.sampleRecords.length > 0 && (
        <div className="op-detail-section">
          <div className="label">Output preview</div>
          <RecordsTable records={result.sampleRecords} />
        </div>
      )}

      {(parsed?.columnStats || result?.columnStats) && (
        <div className="op-detail-section">
          <button className="ghost" onClick={() => setShowStats(s => !s)}>
            {showStats ? "Hide" : "Show"} column stats (
            {Object.keys(parsed?.columnStats || result?.columnStats || {}).length})
          </button>
          {showStats && (
            <div className="op-detail-stats">
              {Object.entries(parsed?.columnStats || result?.columnStats || {})
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
          via dedicated fields. Useful for general-mode operators with
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

/**
 * Render a TSV blob (header row + data rows) as a real HTML table.
 * The formatter emits tabs as column separators, with a leading-tab
 * convention for the index column. We treat any whitespace block of
 * tabs as one separator and the first column-zero token as the index.
 */
function TsvTable({ tsv }: { tsv: string }) {
  const lines = tsv.split("\n").filter(l => l.length > 0);
  if (lines.length === 0) return null;
  const rows = lines.map(l => l.split("\t"));
  // The first row is the header (with a leading empty cell for the index).
  const header = rows[0];
  const body = rows.slice(1);
  return (
    <div style={{ overflowX: "auto", maxHeight: 320 }}>
      <table className="records">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i}>{h.trim() || "#"}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
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
