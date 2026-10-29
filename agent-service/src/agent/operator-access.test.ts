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

import { describe, expect, test } from "bun:test";
import { computeOperatorAccess } from "./texera-agent";

const call = (toolName: string, toolCallId: string, input: any) => ({ toolName, toolCallId, input });
const result = (toolCallId: string, output: any, isError = false) => ({ toolCallId, output, isError });

describe("computeOperatorAccess", () => {
  test("returns undefined for steps without tool calls", () => {
    expect(computeOperatorAccess(undefined, undefined)).toBeUndefined();
    expect(computeOperatorAccess([], [])).toBeUndefined();
  });

  test("older operator tools: addOperator / modifyOperator / deleteOperator / executeOperator", () => {
    const access = computeOperatorAccess(
      [
        call("addOperator", "a", { operatorId: "filter1", operatorType: "Filter" }),
        call("modifyOperator", "m", { operatorId: "filter1" }),
        call("deleteOperator", "d", { operatorId: "old_op" }),
        call("executeOperator", "e", { operatorId: "filter1" }),
      ],
      [
        result("a", "Added operator filter1, input ports: 1, output ports: 1"),
        result("m", "Operator filter1 modified"),
        result("d", "Deleted operator: old_op"),
        result("e", "Operator filter1:\nrows..."),
      ]
    );
    expect(access![0].addedOperatorIds).toEqual(["filter1"]);
    expect(access![1].modifiedOperatorIds).toEqual(["filter1"]);
    expect(access![2].modifiedOperatorIds).toEqual(["old_op"]);
    // execute output is a result table, not a known summary → falls back to the input id as "viewed"
    expect(access![3].viewedOperatorIds).toEqual(["filter1"]);
  });

  test("native mode: the dataflow receipt names what landed and what was observed", () => {
    const receipt = (operators: Array<{ id: string; status: string }>, observe: string[]) => ({
      kind: "dataflow-actions",
      protocol: "registered-python-v1",
      status: "completed",
      actions: [],
      operators: operators.map(o => ({ ...o, op: "filter", message: "" })),
      observe,
      observationErrors: [],
    });
    const access = computeOperatorAccess(
      [
        call("dataflow", "a", {
          python: "",
          statements: "set web_fraud: filter(contributors, predicate='large')\nshow result web_fraud",
        }),
        call("dataflow", "m", {
          python: "",
          statements: "set web_fraud: filter(contributors, predicate='larger')",
        }),
        call("deleteOperator", "d", { id: "probe" }),
      ],
      [
        result("a", receipt([{ id: "web_fraud", status: "added" }], ["web_fraud"])),
        result(
          "m",
          receipt(
            [
              { id: "web_fraud", status: "modified" },
              { id: "bad", status: "error" },
            ],
            []
          )
        ),
        result("d", "deleted operator `probe`"),
      ]
    );
    expect(access![0].addedOperatorIds).toEqual(["web_fraud"]);
    expect(access![0].viewedOperatorIds).toEqual(["web_fraud"]);
    expect(access![1].modifiedOperatorIds).toEqual(["web_fraud"]);
    expect(access![1].addedOperatorIds).toEqual([]);
    expect(access![2].modifiedOperatorIds).toEqual(["probe"]);
  });

  test("errored tool calls record nothing except the viewed operator of a failed read", () => {
    const access = computeOperatorAccess(
      [call("addOperator", "t1", { operatorId: "bad" }), call("executeOperator", "t2", { operatorId: "bad" })],
      [result("t1", "[ERROR] syntax error", true), result("t2", "[ERROR] boom", true)]
    );
    expect(access![0]).toEqual({ viewedOperatorIds: [], addedOperatorIds: [], modifiedOperatorIds: [] });
    expect(access![1].viewedOperatorIds).toEqual(["bad"]);
  });

  test("is keyed by tool-call index even when results arrive out of order", () => {
    const access = computeOperatorAccess(
      [call("addOperator", "a", { operatorId: "x" }), call("addOperator", "b", { operatorId: "y" })],
      [
        result("b", "Added operator y, input ports: 0, output ports: 1"),
        result("a", "Added operator x, input ports: 0, output ports: 1"),
      ]
    );
    expect(access![0].addedOperatorIds).toEqual(["x"]);
    expect(access![1].addedOperatorIds).toEqual(["y"]);
  });
});
