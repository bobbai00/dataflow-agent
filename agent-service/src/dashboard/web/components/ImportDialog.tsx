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

import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ReActStep, WorkflowContent } from "../types";

// NOTE: We intentionally do NOT read a sibling `workflow.json`. The agent
// service's `importReActSteps` reconstructs every snapshot's workflow by
// replaying the trace's tool calls, and we seed `WorkflowSystemMetadata`
// with minimal code-mode schemas server-side so that replay works even
// without the Texera backend. The trace is the single source of truth.

type Mode = "single" | "flat" | "recursive";

interface Candidate {
  /** Stable key for React + status map. The browser may hand us multiple
   *  Files with identical `webkitRelativePath` if the picker is reopened
   *  on the same folder; we suffix with the index so keys stay unique. */
  key: string;
  file: File;
  relPath: string;
  selected: boolean;
  status: "queued" | "creating" | "importing" | "done" | "error";
  message?: string;
  stepCount?: number;
  /** Display name we'll send when creating the agent shell. Derived from
   *  the deepest folder (recursive mode) or the file's basename otherwise. */
  agentName: string;
  /** Cached parse — set after we read+validate the file so the table can
   *  show the step count without re-parsing on import. */
  parsed?: ParsedTrace;
  parseError?: string;
}

interface ParsedTrace {
  steps: ReActStep[];
  snapshots?: Record<string, WorkflowContent>;
}

/**
 * Parse a single trace file. Accepts the `react_steps.json` shape exported
 * by the agent service today (`{ steps, snapshots? }`) and also a bare
 * array of steps for forward-compat with manually-edited traces.
 */
async function readTrace(file: File): Promise<ParsedTrace> {
  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${(e as Error).message}`);
  }
  if (Array.isArray(json)) return { steps: json as ReActStep[] };
  if (json && typeof json === "object" && Array.isArray((json as { steps?: unknown }).steps)) {
    return json as ParsedTrace;
  }
  throw new Error("expected an object with a `steps` array (or a bare array of steps)");
}

function inferAgentName(file: File, relPath: string, mode: Mode): string {
  if (mode === "single") return file.name.replace(/\.json$/i, "") || file.name;
  if (mode === "recursive") {
    // Use the directory containing the trace file. For the Kramabench layout
    // `<run>/<task>/react_steps.json` this gives a useful per-task name.
    const parts = relPath.split("/").filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2];
  }
  return file.name.replace(/\.json$/i, "");
}

/**
 * Wildcard matcher: turns `react_steps.json` / `*.trace.json` into a RegExp
 * that's applied to the *basename* of each file. Anchored at both ends; a
 * leading/trailing `*` is the only wildcard we support — anything more
 * elaborate would be a foot-gun in a one-line UI input.
 */
function basenameMatcher(pattern: string): (path: string) => boolean {
  const trimmed = pattern.trim() || "react_steps.json";
  const escaped = trimmed.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const rx = new RegExp(`^${escaped}$`, "i");
  return (path: string) => {
    const base = path.split("/").pop() ?? "";
    return rx.test(base);
  };
}

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("single");
  const [pattern, setPattern] = useState("react_steps.json");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const singleRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  const allDone = candidates.length > 0 && candidates.every(c => c.status === "done");
  const selectedCount = candidates.filter(c => c.selected && c.status !== "done").length;

  /**
   * Pull a `FileList` into a candidate set, parsing each file in parallel
   * so the table can show step counts before the user commits. Files that
   * fail to parse stay in the list with a `parseError` and a disabled
   * checkbox — preserving them rather than silently dropping makes the
   * "why didn't this get imported?" question trivial to answer.
   */
  const ingestFiles = useCallback(
    async (files: FileList, currentMode: Mode) => {
      setError(null);
      const arr = Array.from(files);
      const matches = (() => {
        if (currentMode === "single") return arr;
        if (currentMode === "flat") {
          return arr.filter(f => {
            const path = f.webkitRelativePath || f.name;
            const depth = path.split("/").length;
            // depth 2 == <picked-folder>/<file.json>. Anything deeper is a
            // subdirectory and belongs to the recursive mode instead.
            return depth === 2 && /\.json$/i.test(path);
          });
        }
        const match = basenameMatcher(pattern);
        return arr.filter(f => match(f.webkitRelativePath || f.name));
      })();

      const initial: Candidate[] = matches.map((file, idx) => {
        const relPath = file.webkitRelativePath || file.name;
        return {
          key: `${relPath}#${idx}`,
          file,
          relPath,
          selected: true,
          status: "queued",
          agentName: inferAgentName(file, relPath, currentMode),
        };
      });
      setCandidates(initial);

      const parsed = await Promise.all(
        initial.map(async c => {
          try {
            const trace = await readTrace(c.file);
            return { ...c, parsed: trace, stepCount: trace.steps.length };
          } catch (e) {
            return {
              ...c,
              parseError: e instanceof Error ? e.message : String(e),
              selected: false,
            };
          }
        })
      );
      setCandidates(parsed);
    },
    [pattern]
  );

  const onSinglePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    ingestFiles(e.target.files, "single");
  };
  const onDirPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    ingestFiles(e.target.files, mode);
  };

  const runImport = useCallback(async () => {
    setBusy(true);
    setError(null);
    // Snapshot the candidates we're going to import so the loop reads a
    // consistent slice even as setCandidates fires intermediate updates.
    const targets = candidates.filter(c => c.selected && c.parsed && c.status !== "done");
    for (const c of targets) {
      setCandidates(prev =>
        prev.map(p => (p.key === c.key ? { ...p, status: "creating", message: undefined } : p))
      );
      try {
        const agent = await api.createAgent({ modelType: "imported", name: c.agentName });
        setCandidates(prev => prev.map(p => (p.key === c.key ? { ...p, status: "importing" } : p)));
        // No `snapshots` override — the server's `importReActSteps`
        // reconstructs the workflow for every snapshot by replaying tool
        // calls against the (now seeded) metadata store.
        const res = await api.importReActSteps(agent.id, {
          steps: c.parsed!.steps,
          snapshots: c.parsed!.snapshots,
        });
        setCandidates(prev =>
          prev.map(p =>
            p.key === c.key
              ? { ...p, status: "done", message: `${res.importedCount} steps → ${agent.id}` }
              : p
          )
        );
      } catch (e) {
        setCandidates(prev =>
          prev.map(p =>
            p.key === c.key
              ? { ...p, status: "error", message: e instanceof Error ? e.message : String(e) }
              : p
          )
        );
      }
    }
    setBusy(false);
  }, [candidates]);

  const totalSelected = useMemo(
    () => candidates.filter(c => c.selected && c.status !== "done").length,
    [candidates]
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import ReAct traces</h2>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="tabs">
            <button className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>
              Single file
            </button>
            <button className={mode === "flat" ? "active" : ""} onClick={() => setMode("flat")}>
              Folder (flat)
            </button>
            <button
              className={mode === "recursive" ? "active" : ""}
              onClick={() => setMode("recursive")}
            >
              Folder (recursive)
            </button>
          </div>

          {mode === "single" && (
            <p className="import-help">
              Pick a single <code>react_steps.json</code> file. The agent service rebuilds
              every workflow snapshot by replaying the trace's tool calls — no companion
              files needed.
            </p>
          )}
          {mode === "flat" && (
            <p className="import-help">
              Pick a folder. Every <code>*.json</code> file <em>directly inside</em> it will
              be treated as a trace.
            </p>
          )}
          {mode === "recursive" && (
            <p className="import-help">
              Pick a folder. The dashboard recursively scans it in the browser (no server-side
              FS access) and imports every file whose basename matches the pattern below — by
              default <code>react_steps.json</code>, matching the Kramabench layout.
            </p>
          )}

          <div className="field row">
            {mode === "single" ? (
              <>
                <input
                  ref={singleRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={onSinglePick}
                />
              </>
            ) : (
              <>
                <input
                  ref={dirRef}
                  type="file"
                  // webkitdirectory is the only cross-browser way to pick a
                  // local folder from a file input. TS doesn't have these in
                  // its DOM lib, so we cast through `any` once.
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  multiple
                  onChange={onDirPick}
                />
                {mode === "recursive" && (
                  <input
                    type="text"
                    value={pattern}
                    placeholder="basename pattern (e.g. react_steps.json or *.trace.json)"
                    onChange={e => setPattern(e.target.value)}
                    style={{ flex: 1 }}
                  />
                )}
              </>
            )}
          </div>

          {error && <div className="error-banner">{error}</div>}

          {candidates.length > 0 && (
            <>
              <div className="row" style={{ marginBottom: "0.5rem" }}>
                <span className="muted">
                  {candidates.length} file{candidates.length === 1 ? "" : "s"} matched
                  {candidates.some(c => c.parseError) &&
                    ` · ${candidates.filter(c => c.parseError).length} unreadable`}
                </span>
                <span className="spacer" />
                <button
                  className="ghost"
                  onClick={() => setCandidates(prev => prev.map(c => ({ ...c, selected: !c.parseError })))}
                >
                  Select all
                </button>
                <button
                  className="ghost"
                  onClick={() => setCandidates(prev => prev.map(c => ({ ...c, selected: false })))}
                >
                  Select none
                </button>
              </div>
              <div className="candidate-list">
                {candidates.map(c => (
                  <div key={c.key} className="candidate-row">
                    <input
                      type="checkbox"
                      checked={c.selected}
                      disabled={!!c.parseError || c.status === "done" || busy}
                      onChange={e =>
                        setCandidates(prev =>
                          prev.map(p => (p.key === c.key ? { ...p, selected: e.target.checked } : p))
                        )
                      }
                    />
                    <div className="path" title={c.relPath}>
                      {c.relPath}
                    </div>
                    <div className="meta">
                      {c.parseError ? (
                        <span className="error">parse error: {c.parseError}</span>
                      ) : (
                        <>
                          {c.stepCount ?? "…"} steps · → <span className="mono">{c.agentName}</span>
                        </>
                      )}
                    </div>
                    <div className={`status ${c.status}`}>{c.status}</div>
                    {c.message && (
                      <div className="meta" style={{ flexBasis: "100%", paddingLeft: "1.5rem" }}>
                        {c.message}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose}>{allDone ? "Done" : "Cancel"}</button>
          <button
            className="primary"
            disabled={busy || totalSelected === 0}
            onClick={runImport}
          >
            {busy ? "Importing…" : `Import ${totalSelected || ""}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
