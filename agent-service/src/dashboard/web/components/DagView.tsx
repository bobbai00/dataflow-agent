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

import { useMemo } from "react";
import dagre from "dagre";
import type { OperatorResultSummary, WorkflowContent } from "../types";
import type { ParsedOperatorResult } from "../util/parse-operator-results";

/** Per-operator diff marker computed by the trace view when the user toggles
 *  diff mode on. `added` = present at this step but not the previous one;
 *  `modified` = same id but different code/properties. Anything else → no
 *  override and the node renders with its plain status color. */
export type DiffStatus = "added" | "modified";

const NODE_W = 180;
const NODE_H = 78;
const ID_GAP = 14;

export function DagView({
  workflow,
  results,
  parsedResults,
  selectedOperatorId,
  onSelectOperator,
  diff,
}: {
  workflow: WorkflowContent | null;
  /** Live operator results from `/snapshots/:stepId.results` — populated
   *  when the agent ran against a real backend. Empty for imports. */
  results: Record<string, OperatorResultSummary>;
  /** Per-operator results parsed from the step's `inputMessages` — this
   *  is the fallback that makes failed/succeeded states visible for
   *  imported traces where `results` is empty. */
  parsedResults?: Map<string, ParsedOperatorResult>;
  selectedOperatorId?: string | null;
  onSelectOperator?: (operatorId: string | null) => void;
  diff?: Map<string, DiffStatus>;
}) {
  const layout = useMemo(() => {
    if (!workflow || workflow.operators.length === 0) return null;

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", marginx: 28, marginy: 36, ranksep: 80, nodesep: 36 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const op of workflow.operators) {
      g.setNode(op.operatorID, { width: NODE_W, height: NODE_H });
    }
    for (const link of workflow.links) {
      g.setEdge(link.source.operatorID, link.target.operatorID, { id: link.linkID });
    }
    dagre.layout(g);

    const width = (g.graph().width ?? 600) + ID_GAP * 2;
    const height = (g.graph().height ?? 300) + ID_GAP * 2;

    const nodes = workflow.operators.map(op => {
      const n = g.node(op.operatorID);
      return {
        op,
        x: (n?.x ?? 0) - NODE_W / 2,
        y: (n?.y ?? 0) - NODE_H / 2,
      };
    });
    const edges = workflow.links.map(link => ({
      link,
      points: (g.edge(link.source.operatorID, link.target.operatorID)?.points ?? []).map(p => [
        p.x,
        p.y,
      ]),
    }));
    return { width, height, nodes, edges };
  }, [workflow]);

  if (!workflow || workflow.operators.length === 0) {
    return (
      <div className="muted" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
        No operators yet at this step.
      </div>
    );
  }
  if (!layout) return null;

  return (
    <div className="dag-host">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-soft)" />
          </marker>
        </defs>
        {layout.edges.map(({ link, points }) => (
          <path
            key={link.linkID}
            className="dag-edge"
            d={polyline(points)}
            stroke="var(--border-soft)"
          />
        ))}
        {layout.nodes.map(({ op, x, y }) => {
          const parsed = parsedResults?.get(op.operatorID);
          const liveResult = results[op.operatorID];
          const failed = parsed?.state === "failed" || !!liveResult?.error;
          const completed = parsed?.state === "completed" || liveResult?.state === "Completed";
          const stateCls = failed ? "failed" : completed ? "completed" : "";
          const diffCls = diff?.get(op.operatorID);
          const isSelected = selectedOperatorId === op.operatorID;
          const summary = op.customDisplayName?.trim() || parsed?.summary || op.operatorType;
          return (
            <g
              key={op.operatorID}
              transform={`translate(${x}, ${y})`}
              style={{ cursor: "pointer" }}
              onClick={() => onSelectOperator?.(op.operatorID)}
            >
              {/* Operator ID label, rendered ABOVE the box per the spec. */}
              <text
                className="dag-id-label"
                x={NODE_W / 2}
                y={-6}
                textAnchor="middle"
              >
                {op.operatorID}
              </text>
              {/* Background rectangle + status color. Diff outline overlays
                 the status color via a thicker stroke of a different hue
                 when `diff` mode is on. */}
              <rect
                className={`dag-node ${stateCls} ${diffCls ? `diff-${diffCls}` : ""} ${
                  isSelected ? "selected" : ""
                }`}
                width={NODE_W}
                height={NODE_H}
                rx={8}
              />
              {/* Operator description inside the box. foreignObject lets us
                 use real HTML for text wrapping rather than rolling our
                 own SVG line-break algorithm. */}
              <foreignObject x={6} y={4} width={NODE_W - 12} height={NODE_H - 8}>
                {/* `xmlns` on the inner div would be ideal per the spec but
                   React's HTML type doesn't accept it. Browsers happily
                   render the HTML namespace anyway because foreignObject's
                   children default to XHTML. */}
                <div className="dag-node-inner">
                  <div className="dag-node-type">{op.operatorType}</div>
                  <div className="dag-node-desc" title={summary}>
                    {summary}
                  </div>
                  <div className="dag-node-footer">
                    {parsed?.outputShape
                      ? `${parsed.outputShape.rows.toLocaleString()} rows · ${parsed.outputShape.columns} cols`
                      : liveResult?.totalRowCount
                      ? `${liveResult.totalRowCount.toLocaleString()} rows`
                      : ""}
                  </div>
                </div>
              </foreignObject>
              {/* Failure marker — red ✕ in the top-right corner. */}
              {failed && (
                <g transform={`translate(${NODE_W - 14}, 8)`}>
                  <circle r={8} fill="var(--error)" />
                  <text
                    x={0}
                    y={3}
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight={700}
                    fill="#0b1220"
                  >
                    ✕
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function polyline(points: number[][]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  return `M ${first[0]} ${first[1]} ` + rest.map(p => `L ${p[0]} ${p[1]}`).join(" ");
}
