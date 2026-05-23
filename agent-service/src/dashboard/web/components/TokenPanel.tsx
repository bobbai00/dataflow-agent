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
import type { ReActStep } from "../types";

export function TokenPanel({
  steps,
  selectedStepId,
  onSelect,
}: {
  steps: ReActStep[];
  selectedStepId: string | null;
  onSelect: (id: string) => void;
}) {
  const stats = useMemo(() => {
    let input = 0;
    let output = 0;
    let total = 0;
    let cached = 0;
    let max = 1;
    for (const s of steps) {
      const u = s.usage;
      if (!u) continue;
      input += u.inputTokens ?? 0;
      output += u.outputTokens ?? 0;
      total += u.totalTokens ?? 0;
      cached += u.cachedInputTokens ?? 0;
      if ((u.totalTokens ?? 0) > max) max = u.totalTokens ?? 0;
    }
    const hotspots = [...steps]
      .filter(s => s.usage?.totalTokens)
      .sort((a, b) => (b.usage?.totalTokens ?? 0) - (a.usage?.totalTokens ?? 0))
      .slice(0, 5);
    return { input, output, total, cached, max, hotspots };
  }, [steps]);

  if (steps.length === 0) return null;

  return (
    <div className="token-panel">
      <div className="summary">
        <span>
          <strong>{stats.total.toLocaleString()}</strong> total tokens
        </span>
        <span>
          input <strong>{stats.input.toLocaleString()}</strong>
        </span>
        <span>
          output <strong>{stats.output.toLocaleString()}</strong>
        </span>
        {stats.cached > 0 && (
          <span>
            cached <strong>{stats.cached.toLocaleString()}</strong>
          </span>
        )}
        <span className="spacer" />
        {stats.hotspots.length > 0 && (
          <span className="muted">
            hotspots:{" "}
            {stats.hotspots.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ", "}
                <a
                  href="#"
                  onClick={e => {
                    e.preventDefault();
                    onSelect(s.id);
                  }}
                >
                  #{s.stepId} ({s.usage?.totalTokens?.toLocaleString()})
                </a>
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="token-bars" title="Per-step total tokens — click to seek">
        {steps.map(s => {
          const tt = s.usage?.totalTokens ?? 0;
          const cached = s.usage?.cachedInputTokens ?? 0;
          const height = `${Math.max(2, (tt / stats.max) * 100)}%`;
          const isActive = s.id === selectedStepId;
          return (
            <div
              key={s.id}
              className={`token-bar ${cached > 0 ? "cached" : ""} ${isActive ? "active" : ""}`}
              style={{ height }}
              title={`step ${s.stepId}: ${tt.toLocaleString()} tokens`}
              onClick={() => onSelect(s.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
