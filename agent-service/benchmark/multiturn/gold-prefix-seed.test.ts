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
import { expect, test } from "bun:test";
import { directFileReadOperators, registeredSeedFiles, seededRetrievalIds } from "./gold-prefix-seed";

test("registered seed file extraction decodes every JSON-quoted literal path", () => {
  const paths = ['data/a "quoted".parquet', "data/slash\\name.parquet", "data/space name.parquet"];
  const seed = paths
    .map((path, index) => `set source_${index}: scan(files=${JSON.stringify(path)}, format="parquet")`)
    .join("\n");
  expect(registeredSeedFiles(seed)).toEqual(paths);
});

test("historical syntax is rejected with a regeneration instruction before provisioning", () => {
  expect(() => registeredSeedFiles('records = scan("data/example.parquet", format="parquet")')).toThrow(
    "historical expression-mode"
  );
  expect(() =>
    registeredSeedFiles('set records: scan(files="a.parquet", format="parquet")\nold = scan("b.parquet")')
  ).toThrow("regenerate");
});

test("unsupported seed syntax never silently omits an input from file checks", () => {
  expect(() => registeredSeedFiles("set records: custom_loader(path='missing')")).toThrow("seed.changes line 1");
  expect(() => registeredSeedFiles('set records: scan(files="bad\\q.parquet", format="parquet")')).toThrow();
});

test("seed-use metrics count batch reads and retain recorded singular reads", () => {
  expect(
    seededRetrievalIds(
      [
        { type: "retrieve", operator_ids: ["seed_a", "derived", "seed_b"] },
        { type: "retrieve", operator_id: "seed_a" },
        { type: "execute", operator_ids: ["never_read"] },
      ],
      ["seed_a", "seed_b", "never_read"]
    )
  ).toEqual(["seed_a", "seed_b"]);
});

test("direct reload detection inspects the registered entry, not every shared function", () => {
  const functions = {
    load: { source: "def load():\n    return pd.read_csv('data.csv')" },
    transform: { source: "def transform(table):\n    return table.copy()" },
  };
  const operators = [
    { operatorID: "scan", nativeOp: { type: "Scan" } },
    { operatorID: "loader", nativeOp: { type: "Process", registeredName: "load" } },
    { operatorID: "derived", nativeOp: { type: "Process", registeredName: "transform" } },
    {
      operatorID: "historical",
      nativeOp: { type: "Process", functions: { load: "pd.read_parquet('saved.parquet')" } },
    },
  ];
  expect(directFileReadOperators(operators, { functions })).toEqual(["scan", "loader", "historical"]);
});
