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

import type { ReActStep } from "../types";

export function ReplayControls({
  steps,
  selectedStepId,
  onSeek,
  playing,
  onPlayingChange,
  speed,
  onSpeedChange,
}: {
  steps: ReActStep[];
  selectedStepId: string | null;
  onSeek: (id: string) => void;
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
  speed: number;
  onSpeedChange: (s: number) => void;
}) {
  const idx = selectedStepId ? steps.findIndex(s => s.id === selectedStepId) : -1;
  const atStart = idx <= 0;
  const atEnd = idx < 0 || idx >= steps.length - 1;

  const seekTo = (i: number) => {
    if (i < 0 || i >= steps.length) return;
    onSeek(steps[i].id);
  };

  return (
    <div className="replay">
      <button disabled={steps.length === 0 || atStart} onClick={() => seekTo(0)} title="First (Home)">
        ⏮
      </button>
      <button disabled={atStart} onClick={() => seekTo(idx - 1)} title="Previous (←)">
        ◀
      </button>
      <button disabled={atEnd} onClick={() => seekTo(idx + 1)} title="Next (→)">
        ▶
      </button>
      <button disabled={atEnd} onClick={() => seekTo(steps.length - 1)} title="Last (End)">
        ⏭
      </button>
      <button onClick={() => onPlayingChange(!playing)} title="Play / pause (Space)">
        {playing ? "❚❚ Pause" : "▶ Play"}
      </button>
      <select value={speed} onChange={e => onSpeedChange(Number(e.target.value))}>
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
        <option value={4}>4×</option>
      </select>
      <span className="muted mono">
        {idx >= 0 ? `${idx + 1}/${steps.length}` : `–/${steps.length}`}
      </span>
    </div>
  );
}
