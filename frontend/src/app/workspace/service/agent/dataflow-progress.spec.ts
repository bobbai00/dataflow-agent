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

import { WorkflowContent } from "../../../common/type/workflow";
import { OperatorPredicate } from "../../types/workflow-common.interface";
import { applyDataflowChange, ProgressPlayer } from "./dataflow-progress";

const op = (operatorID: string, doc = "") => ({ operatorID, nativeOp: { doc } }) as unknown as OperatorPredicate;
const content = (operators: OperatorPredicate[]): WorkflowContent =>
  ({ operators, links: [], operatorPositions: {}, commentBoxes: [], settings: {} }) as unknown as WorkflowContent;

describe("applyDataflowChange", () => {
  it("adds and replaces the operators an edit sent, drops the removed ones, and takes its links and positions", () => {
    const link = { linkID: "l", source: { operatorID: "a", portID: "o" }, target: { operatorID: "c", portID: "i" } };
    const next = applyDataflowChange(content([op("a"), op("b"), op("c")]), {
      operators: [op("c", "changed"), op("d")],
      removed: ["b"],
      links: [link],
      operatorPositions: { a: { x: 1, y: 1 }, c: { x: 2, y: 2 }, d: { x: 3, y: 3 } },
    });
    expect(next.operators.map(o => [o.operatorID, o.nativeOp?.doc])).toEqual([
      ["a", ""],
      ["c", "changed"],
      ["d", ""],
    ]);
    expect(next.links).toEqual([link]);
    expect(next.operatorPositions["d"]).toEqual({ x: 3, y: 3 });
    expect(next.commentBoxes).toEqual([]);
  });
});

describe("ProgressPlayer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays a paced frame at once and holds the next back; unpaced frames follow without a pause", () => {
    const played: string[] = [];
    const idle = vi.fn();
    const player = new ProgressPlayer(100, idle);
    player.push(() => played.push("v1"), true);
    player.push(() => played.push("v2"), true);
    player.push(() => played.push("snapshot"), false);
    player.push(() => played.push("complete"), false);
    expect(played).toEqual(["v1"]);
    expect(player.playing).toBe(true);
    vi.advanceTimersByTime(100);
    expect(played).toEqual(["v1", "v2"]);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(played).toEqual(["v1", "v2", "snapshot", "complete"]);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(player.playing).toBe(false);
  });

  it("plays an unpaced frame at once when nothing waits", () => {
    const played: string[] = [];
    const player = new ProgressPlayer(100);
    player.push(() => played.push("complete"), false);
    expect(played).toEqual(["complete"]);
    expect(player.playing).toBe(false);
  });

  it("plays everything waiting at once when flushed", () => {
    const played: string[] = [];
    const idle = vi.fn();
    const player = new ProgressPlayer(100, idle);
    player.push(() => played.push("v1"), true);
    player.push(() => played.push("v2"), true);
    player.push(() => played.push("v3"), true);
    player.flush();
    expect(played).toEqual(["v1", "v2", "v3"]);
    expect(idle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(played).toEqual(["v1", "v2", "v3"]);
  });
});
