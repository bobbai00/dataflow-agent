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
import { formatAddOperatorResult, formatModifyOperatorResult } from "./tools/tools-utility";

const call = (toolName: string, toolCallId: string, input: any) => ({ toolName, toolCallId, input });
const result = (toolCallId: string, output: any, isError = false) => ({ toolCallId, output, isError });

describe("computeOperatorAccess", () => {
  test("returns undefined for steps without tool calls", () => {
    expect(computeOperatorAccess(undefined, undefined)).toBeUndefined();
    expect(computeOperatorAccess([], [])).toBeUndefined();
  });

  test("code mode: createOrModifyOperator add → addedOperatorIds", () => {
    const access = computeOperatorAccess(
      [call("createOrModifyOperator", "t1", { operatorId: "load_csv", code: "..." })],
      [result("t1", formatAddOperatorResult("load_csv", 0, 1))]
    );
    expect(access).toEqual({
      0: { viewedOperatorIds: [], addedOperatorIds: ["load_csv"], modifiedOperatorIds: [] },
    });
  });

  test("code mode: createOrModifyOperator modify → modifiedOperatorIds", () => {
    const access = computeOperatorAccess(
      [call("createOrModifyOperator", "t1", { operatorId: "load_csv", code: "..." })],
      [result("t1", formatModifyOperatorResult("load_csv", [{ source: "a", target: "load_csv" }]))]
    );
    expect(access![0].modifiedOperatorIds).toEqual(["load_csv"]);
    expect(access![0].addedOperatorIds).toEqual([]);
  });

  test("general mode: addOperator / modifyOperator / deleteOperator / executeOperator", () => {
    const access = computeOperatorAccess(
      [
        call("addOperator", "a", { operatorId: "filter1", operatorType: "Filter" }),
        call("modifyOperator", "m", { operatorId: "filter1" }),
        call("deleteOperator", "d", { operatorId: "old_op" }),
        call("executeOperator", "e", { operatorId: "filter1" }),
      ],
      [
        result("a", formatAddOperatorResult("filter1", 1, 1)),
        result("m", formatModifyOperatorResult("filter1")),
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
    const batch = (operators: Array<{ id: string; status: string }>, observe: string[]) => ({
      kind: "native-batch",
      operators: operators.map(o => ({ ...o, op: "filter", message: "" })),
      observe,
      observationErrors: [],
    });
    const access = computeOperatorAccess(
      [
        call("dataflow", "a", {
          edits: "web_fraud = filter(contributors, lambda row: row['amount'] > 1, doc='amount above 1')",
          observe: ["web_fraud"],
        }),
        call("dataflow", "m", {
          edits: "web_fraud = filter(contributors, lambda row: row['amount'] > 2, doc='amount above 2')",
          observe: [],
        }),
        call("deleteOperator", "d", { id: "probe" }),
      ],
      [
        result("a", batch([{ id: "web_fraud", status: "added" }], ["web_fraud"])),
        result(
          "m",
          batch(
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
      [
        call("createOrModifyOperator", "t1", { operatorId: "bad" }),
        call("executeOperator", "t2", { operatorId: "bad" }),
      ],
      [result("t1", "[ERROR] syntax error", true), result("t2", "[ERROR] boom", true)]
    );
    expect(access![0]).toEqual({ viewedOperatorIds: [], addedOperatorIds: [], modifiedOperatorIds: [] });
    expect(access![1].viewedOperatorIds).toEqual(["bad"]);
  });

  test("is keyed by tool-call index even when results arrive out of order", () => {
    const access = computeOperatorAccess(
      [call("addOperator", "a", { operatorId: "x" }), call("addOperator", "b", { operatorId: "y" })],
      [result("b", formatAddOperatorResult("y", 0, 1)), result("a", formatAddOperatorResult("x", 0, 1))]
    );
    expect(access![0].addedOperatorIds).toEqual(["x"]);
    expect(access![1].addedOperatorIds).toEqual(["y"]);
  });
});
