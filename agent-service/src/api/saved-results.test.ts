/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { afterEach, expect, spyOn, test } from "bun:test";
import type { OperatorInfo } from "../types/execution";
import type { OperatorPredicate } from "../types/workflow";
import { readMaterializedResult, resultReference, retainSnapshotResults } from "./saved-results";

afterEach(() => { fetchMock?.mockRestore(); fetchMock = undefined; });
let fetchMock: ReturnType<typeof spyOn> | undefined;
const client = { token: "test-token", workflowId: 7 };
const op = { operatorID: "scores" } as OperatorPredicate;
const info = {
  state: "Completed", result: [{id: "a"}], totalRowCount: 3, outputTuples: 3, inputTuples:3, resultMode:"schema",
  materialization: { executionId: "41", outputPort: 0, cached:false },
} as OperatorInfo;
function page(rows: unknown[], offset: number, total = 3, identity = "immutable-41") {
  return { materializationId: identity, totalRows: total, schema: [{name:"id",type:"string"}],
    rows, nextOffset: offset + rows.length, complete: offset + rows.length === total };
}
function mockPages(pages: (object | Response)[]) {
  fetchMock = spyOn(globalThis, "fetch").mockImplementation((async () => {
    const value = pages.shift();
    if (!value) throw new Error("Unexpected extra request");
    return value instanceof Response ? value : Response.json(value);
  }) as unknown as typeof fetch);
  return fetchMock;
}
test("historical pages pin one producer and materialization without mutating the snapshot", async () => {
  const mock = mockPages([page([{id:"a"},{id:"b"}],0), page([{id:"c"}],2)]);
  const before = JSON.stringify(info);
  const result = await readMaterializedResult(client, op, info, { requireComplete:true });
  expect(result.result).toEqual([{id:"a"},{id:"b"},{id:"c"}]);
  expect(JSON.stringify(info)).toBe(before);
  const requests = mock.mock.calls.map((call: any[]) => JSON.parse(String(call[1]?.body)));
  expect(requests[0].reference).toEqual({ executionId:"41",operatorId:"scores",outputPort:0 });
  expect(requests[1].materializationId).toBe("immutable-41");
  expect(requests[1].offset).toBe(2);
});
test("paging refuses a different version, changed count, or incomplete progress", async () => {
  for (const second of [page([{id:"c"}],2,3,"latest-42"), page([{id:"c"}],2,4), page([],2)]) {
    mockPages([page([{id:"a"},{id:"b"}],0), second]);
    await expect(readMaterializedResult(client,op,info,{requireComplete:true})).rejects.toThrow("saved materialization");
    fetchMock!.mockRestore();
  }
});
test("empty results still verify that the historical materialization exists", async () => {
  const empty = {...info,result:[],totalRowCount:0,outputTuples:0};
  const mock = mockPages([page([],0,0)]);
  expect((await readMaterializedResult(client,op,empty)).result).toEqual([]);
  expect(mock).toHaveBeenCalledTimes(1);
  mock.mockRestore();
  mockPages([Response.json({message:"HISTORICAL_RESULT_UNAVAILABLE: exact materialization was not retained"}, {status:400})]);
  await expect(readMaterializedResult(client,op,empty)).rejects.toThrow("HISTORICAL_RESULT_UNAVAILABLE");
});
test("invalid projections and service failures do not claim the historical result was lost", async () => {
  mockPages([Response.json({message:"requirement failed: Result projection contains an unknown or duplicate column"}, {status:400})]);
  await expect(readMaterializedResult(client,op,info,{columns:["unknown"]})).rejects.toThrow("INVALID_RESULT_REQUEST");
  fetchMock!.mockRestore();
  mockPages([new Response("storage temporarily unavailable", {status:503})]);
  await expect(readMaterializedResult(client,op,info)).rejects.toThrow("RESULT_SERVICE_ERROR");
});
test("answer paging refuses row and byte ceilings; bounded reads remain labelled partial", async () => {
  const mock = mockPages([page([{id:"a"},{id:"b"},{id:"c"}],0)]);
  await expect(readMaterializedResult(client,op,info,{maxRows:2,requireComplete:true})).rejects.toThrow("sort and limit");
  expect(mock).toHaveBeenCalledTimes(0);
  const partial = await readMaterializedResult(client,op,info,{maxBytes:10});
  expect(partial.truncated).toBe(true);
  expect(partial.result).toHaveLength(1);
});
test("saved handles retain their original producer and reject invalid output ports", async () => {
  const saved = {...op,savedResult:{taskId:2,stepId:"s2",operatorId:"old_scores",executionId:"12",outputPort:1}};
  expect(resultReference(saved,info)).toEqual({executionId:"12",operatorId:"old_scores",outputPort:1});
  expect(resultReference({...saved,savedResult:{...saved.savedResult,outputPort:-1}},info)).toBeUndefined();
});
test("retention de-duplicates shared materializations and excludes failed tables", async () => {
  const mock = mockPages([{retained:1}]);
  const saved = {...op,operatorID:"saved_scores",savedResult:{taskId:2,stepId:"s2",operatorId:"scores",executionId:"41",outputPort:0}};
  await retainSnapshotResults(client,{operators:[op,saved,{...op,operatorID:"failed"}],links:[]} as any,
    id => id==="failed" ? {...info,state:"Failed"} as any : info);
  expect(JSON.parse(String(mock.mock.calls[0][1]?.body)).references).toHaveLength(1);
});
