/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { test, expect } from "bun:test";
import { taskModePrompt } from "./task-prompt";
import { nativeViewOf } from "../tools/native-typed-tools";
import { createHash } from "node:crypto";
import Ajv from "ajv";
import { nativeBatchSchema } from "../tools/native-batch-tools";
test("compact wire schema still constrains the public operator names", () => {
  const validate = new Ajv({ strict: false }).compile(nativeBatchSchema("v2", { compact: true }));
  const filter = {
    op: "filter",
    id: "subset",
    input: "source",
    columns: ["value"],
    func: "def apply(row):\n    return row['value'] > 0",
  };
  expect(validate({ operators: [filter] })).toBe(true);
  expect(validate({ operators: [{ ...filter, op: "Filter" }] })).toBe(false);
  expect(validate({ operators: [{ ...filter, columns: [{ func: "wrong shape" }] }] })).toBe(false);
});
test("compact catalog preserves object fields alongside anyOf requirements", () => {
  const schema = nativeBatchSchema("v2", { compact: true }) as any;
  const project = schema.properties.operators.items.anyOf.find((item: any) => item.properties.op.const === "project");
  expect(project.properties.keep.items.type).toBe("string");
  expect(project.properties.rename.type).toBe("object");
  expect(project.anyOf).toEqual([{ required: ["keep"] }, { required: ["drop"] }, { required: ["rename"] }]);
  expect(JSON.stringify(schema)).not.toContain('"description"');
  expect(taskModePrompt(true, true)).toContain("Project selects keep");
});
test("historical attempt and resolved execution have the same definition identity", () => {
  const ref = { operator: "total", atTask: 1 };
  const id = "task_archive_" + createHash("sha256").update(JSON.stringify(ref)).digest("hex").slice(0, 20);
  expect(nativeViewOf("project", { id: "old", input: ref, keep: ["x"] }, "v2")?.revision).toBe(
    nativeViewOf("project", { id: "old", input: id, keep: ["x"] }, "v2")?.revision
  );
});
