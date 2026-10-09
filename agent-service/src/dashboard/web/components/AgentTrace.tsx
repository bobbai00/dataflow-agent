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

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  AgentInfo,
  OperatorResultSummary,
  ReActStep,
  SnapshotTreeResponse,
  WorkflowContent,
} from "../types";
import { StepTimeline } from "./StepTimeline";
import { SnapshotTree } from "./SnapshotTree";
import { DagView, type DiffStatus } from "./DagView";
import { StepDetail } from "./StepDetail";
import { OperatorDetail } from "./OperatorDetail";
import { ReplayControls } from "./ReplayControls";
import { TokenPanel } from "./TokenPanel";

type Knob = "react-list" | "snapshot-tree" | "dag-only";

interface SnapshotPayload {
  stepId: string | null;
  workflow: WorkflowContent | null;
  results: Record<string, OperatorResultSummary>;
}

/**
 * Trace view. Owns the trace state, the currently-selected step, and the
 * currently-selected operator (if any). Child components are
 * presentational. Refreshes the trace every few seconds while the page is
 * open so a still-running agent stays current.
 */
export function AgentTrace({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [steps, setSteps] = useState<ReActStep[]>([]);
  const [tree, setTree] = useState<SnapshotTreeResponse | null>(null);
  const [knob, setKnob] = useState<Knob>("react-list");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedOperatorId, setSelectedOperatorId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotPayload | null>(null);
  const [prevSnapshot, setPrevSnapshot] = useState<SnapshotPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);
  const [diffOn, setDiffOn] = useState(false);

  const seekableSteps = useMemo(() => steps.filter(s => s.role === "agent"), [steps]);

  const refresh = useCallback(async () => {
    try {
      const [info, traceRes, treeRes] = await Promise.all([
        api.getAgent(agentId),
        api.getReActSteps(agentId),
        api.getSnapshotTree(agentId).catch(() => null),
      ]);
      setAgent(info);
      setSteps(traceRes.steps);
      setTree(treeRes);
      setSelectedStepId(prev => prev ?? traceRes.steps.filter(s => s.role === "agent").at(-1)?.id ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agentId]);

  useEffect(() => {
    refresh();
    const handle = window.setInterval(refresh, 4000);
    return () => window.clearInterval(handle);
  }, [refresh]);

  // Load the snapshot for the currently selected step. We also fetch the
  // PREVIOUS seekable step's snapshot — only used for the diff toggle, but
  // we fetch eagerly so toggling on doesn't cause a stutter.
  useEffect(() => {
    if (!selectedStepId) {
      setSnapshot(null);
      setPrevSnapshot(null);
      return;
    }
    const idx = seekableSteps.findIndex(s => s.id === selectedStepId);
    const prevId = idx > 0 ? seekableSteps[idx - 1].id : null;
    let cancelled = false;
    Promise.all([
      api.getSnapshot(agentId, selectedStepId),
      prevId ? api.getSnapshot(agentId, prevId) : Promise.resolve(null),
    ])
      .then(([cur, prev]) => {
        if (cancelled) return;
        setSnapshot(cur);
        setPrevSnapshot(prev);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, selectedStepId, seekableSteps]);

  // Auto-play
  useEffect(() => {
    if (!playing) return;
    const handle = window.setInterval(() => {
      setSelectedStepId(current => {
        if (!current) return seekableSteps[0]?.id ?? null;
        const idx = seekableSteps.findIndex(s => s.id === current);
        if (idx < 0 || idx >= seekableSteps.length - 1) {
          setPlaying(false);
          return current;
        }
        return seekableSteps[idx + 1].id;
      });
    }, Math.max(150, 1200 / playSpeed));
    return () => window.clearInterval(handle);
  }, [playing, playSpeed, seekableSteps]);

  // Keyboard shortcuts
  useEffect(() => {
    const isEditable = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || (el as HTMLElement).isContentEditable;
    };
    const seek = (delta: number) => {
      setSelectedStepId(current => {
        if (!current) return seekableSteps[0]?.id ?? null;
        const idx = seekableSteps.findIndex(s => s.id === current);
        if (idx < 0) return current;
        const next = Math.max(0, Math.min(seekableSteps.length - 1, idx + delta));
        return seekableSteps[next]?.id ?? current;
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (isEditable()) return;
      if (e.key === "ArrowLeft") seek(-1);
      else if (e.key === "ArrowRight") seek(1);
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying(p => !p);
      } else if (e.key === "Home") setSelectedStepId(seekableSteps[0]?.id ?? null);
      else if (e.key === "End") setSelectedStepId(seekableSteps.at(-1)?.id ?? null);
      else if (e.key === "Escape") setSelectedOperatorId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seekableSteps]);

  // Clear the operator selection whenever the step changes — the selected
  // op may not exist in the new step's workflow.
  useEffect(() => {
    setSelectedOperatorId(null);
  }, [selectedStepId]);

  const selectedStep = useMemo(
    () => steps.find(s => s.id === selectedStepId) ?? null,
    [steps, selectedStepId]
  );

  // Compute the diff vs the previous step. We compare ids and the
  // operatorProperties (specifically `code` for code-mode, full props
  // otherwise). The result is consumed by DagView as an outline overlay.
  const diff: Map<string, DiffStatus> | undefined = useMemo(() => {
    if (!diffOn || !snapshot?.workflow) return undefined;
    const out = new Map<string, DiffStatus>();
    const prevOps = new Map(
      (prevSnapshot?.workflow?.operators ?? []).map(o => [o.operatorID, o])
    );
    for (const op of snapshot.workflow.operators) {
      const before = prevOps.get(op.operatorID);
      if (!before) {
        out.set(op.operatorID, "added");
      } else if (operatorChanged(before, op)) {
        out.set(op.operatorID, "modified");
      }
    }
    return out;
  }, [diffOn, snapshot, prevSnapshot]);

  const selectedOperator = useMemo(() => {
    if (!selectedOperatorId || !snapshot?.workflow) return null;
    return snapshot.workflow.operators.find(o => o.operatorID === selectedOperatorId) ?? null;
  }, [selectedOperatorId, snapshot]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="crumbs">
          <a href="#/">Agents</a>
          <span>/</span>
          <span>{agent?.name ?? agentId}</span>
          {agent && <span className={`pill state-${agent.state}`}>{agent.state}</span>}
          {agent && <span className="pill driver">{agent.driver}</span>}
          {agent && <span className="muted mono">{agent.modelType}</span>}
        </div>
        <div className="actions">
          <button onClick={refresh}>Refresh</button>
        </div>
      </header>

      <div className="trace-toolbar">
        <div className="knobs">
          <button
            className={knob === "react-list" ? "active" : ""}
            onClick={() => setKnob("react-list")}
          >
            ReAct list
          </button>
          <button
            className={knob === "snapshot-tree" ? "active" : ""}
            onClick={() => setKnob("snapshot-tree")}
          >
            Snapshot tree
          </button>
          <button
            className={knob === "dag-only" ? "active" : ""}
            onClick={() => setKnob("dag-only")}
          >
            DAG only
          </button>
        </div>
        <label className="diff-toggle" title="Highlight added (green) and modified (yellow) operators vs the previous snapshot">
          <input
            type="checkbox"
            checked={diffOn}
            onChange={e => setDiffOn(e.target.checked)}
          />
          Diff vs previous
        </label>
        <ReplayControls
          steps={seekableSteps}
          selectedStepId={selectedStepId}
          onSeek={setSelectedStepId}
          playing={playing}
          onPlayingChange={setPlaying}
          speed={playSpeed}
          onSpeedChange={setPlaySpeed}
        />
      </div>

      <div className="app-body">
        {error && <div className="error-banner" style={{ margin: "0.5rem 0.75rem" }}>{error}</div>}

        {knob === "dag-only" ? (
          <div className="trace-pane" style={{ flex: 1 }}>
            <DagView
              workflow={snapshot?.workflow ?? null}
              results={snapshot?.results ?? {}}
              selectedOperatorId={selectedOperatorId}
              onSelectOperator={setSelectedOperatorId}
              diff={diff}
            />
          </div>
        ) : (
          <div className="trace-main">
            <div className="trace-left">
              {knob === "react-list" ? (
                <>
                  <h3>ReAct steps ({steps.length})</h3>
                  <div className="scroll">
                    <StepTimeline
                      steps={steps}
                      selectedStepId={selectedStepId}
                      onSelect={setSelectedStepId}
                    />
                  </div>
                </>
              ) : (
                <>
                  <h3>Snapshot tree ({tree?.nodes.length ?? 0})</h3>
                  <div className="scroll">
                    <SnapshotTree
                      tree={tree}
                      selectedStepId={selectedStepId}
                      onSelect={setSelectedStepId}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="trace-right">
              <div className="trace-pane">
                <DagView
                  workflow={snapshot?.workflow ?? null}
                  results={snapshot?.results ?? {}}
                  selectedOperatorId={selectedOperatorId}
                  onSelectOperator={setSelectedOperatorId}
                  diff={diff}
                />
              </div>
              <div className="trace-pane step-detail">
                {selectedOperator ? (
                  <OperatorDetail
                    operator={selectedOperator}
                    result={snapshot?.results?.[selectedOperator.operatorID]}
                    onClose={() => setSelectedOperatorId(null)}
                  />
                ) : (
                  <StepDetail step={selectedStep} results={snapshot?.results ?? {}} />
                )}
              </div>
            </div>
          </div>
        )}

        <TokenPanel steps={seekableSteps} selectedStepId={selectedStepId} onSelect={setSelectedStepId} />
      </div>
    </div>
  );
}

/**
 * Two operators with the same id are "modified" if their
 * execution-affecting fields differ. For code-mode operators we mostly
 * just need the Python `code` field, but we cast a wider net so the
 * GUI-authored (typed-operator) traces also get a useful highlight when the
 * agent reconfigures a Filter / Aggregate / etc.
 */
function operatorChanged(
  a: { operatorProperties?: Record<string, unknown>; inputPorts?: unknown[]; operatorType?: string },
  b: { operatorProperties?: Record<string, unknown>; inputPorts?: unknown[]; operatorType?: string }
): boolean {
  if (a.operatorType !== b.operatorType) return true;
  if ((a.inputPorts?.length ?? 0) !== (b.inputPorts?.length ?? 0)) return true;
  // Stringify-compare is rough but fine here — operatorProperties is a
  // small JSON-ish object and the cost of a deep equality helper isn't
  // worth it for a diff that runs once per seek.
  return JSON.stringify(a.operatorProperties ?? {}) !== JSON.stringify(b.operatorProperties ?? {});
}
