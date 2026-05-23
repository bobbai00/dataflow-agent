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

import { useEffect, useRef } from "react";
import type { ReActStep } from "../types";

function preview(s: ReActStep): string {
  const text = (s.content || "").trim();
  if (text) return text.replace(/\s+/g, " ").slice(0, 80);
  const first = s.toolCalls?.[0];
  if (first) {
    const args = first.input ? JSON.stringify(first.input).slice(0, 60) : "";
    return `${first.toolName}(${args})`;
  }
  return s.role === "user" ? "(user task)" : "(empty)";
}

export function StepTimeline({
  steps,
  selectedStepId,
  onSelect,
}: {
  steps: ReActStep[];
  selectedStepId: string | null;
  onSelect: (id: string) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedStepId]);

  if (steps.length === 0) {
    return <div className="muted" style={{ padding: "1rem" }}>No steps yet.</div>;
  }

  return (
    <>
      {steps.map((s, idx) => {
        const isActive = s.id === selectedStepId;
        return (
          <div
            key={s.id}
            ref={isActive ? activeRef : undefined}
            className={`step-row ${isActive ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="step-num mono">{idx}</span>
            <span className="step-role">{s.role}</span>
            <div className="step-body">
              <div className="step-preview">{preview(s)}</div>
              {s.toolCalls && s.toolCalls.length > 0 && (
                <div className="step-tools">
                  {s.toolCalls.map(tc => (
                    <span key={tc.toolCallId} className="tool-chip">
                      {tc.toolName}
                    </span>
                  ))}
                </div>
              )}
              {s.usage && (
                <div className="step-tokens">
                  in {s.usage.inputTokens ?? 0} · out {s.usage.outputTokens ?? 0}
                  {s.usage.cachedInputTokens ? ` · cached ${s.usage.cachedInputTokens}` : ""}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
