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

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileNativeOp, inlineNativeRuntime, nativePython } from "./codegen";

const runtime = fileURLToPath(new URL("./python/runtime.py", import.meta.url));
const engine = fileURLToPath(new URL("../../../../amber/src/main/python", import.meta.url));

function runPython(source: string, code = "") {
  const result = spawnSync(nativePython(), ["-c", source, runtime, engine], {
    input: code,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

for (const method of ["pivot", "unstack"] as const) {
  test(`generated process supports ${method} with float fill and complete integer inputs`, () => {
    const reshape =
      method === "pivot"
        ? 'r.pivot_table(index="book_id", columns="user_id", values="rating", aggfunc="first", fill_value=0.0)'
        : 'r.set_index(["book_id", "user_id"])["rating"].unstack(fill_value=0.0).fillna(0.0)';
    const compiled = compileNativeOp(
      {
        type: "Process",
        inputs: ["ratings"],
        source: "wide = process(ratings, fn=process)",
        properties: {
          entry: "process",
          code: `def process(ratings):
    r = ratings.copy()
    for name in ["book_id", "user_id", "rating"]:
        r[name] = pd.to_numeric(r[name], errors="coerce")
    wide = ${reshape}
    wide.columns = ["user_" + str(value) for value in wide.columns]
    return wide.reset_index()`,
        },
      },
      "wide"
    );
    const output = runPython(
      `import json, sys
sys.path.insert(0, sys.argv[2])
import pandas as pd
import pyarrow as pa
from core.models.table import Table
from core.runnables.data_processor import DataProcessor
frame = pd.DataFrame({
    "book_id": pd.Series([1, 1, 2, 2], dtype="Int64"),
    "user_id": pd.Series([1, 2, 2, 3], dtype="Int64"),
    "rating": pd.Series([5, 4, 3, 2], dtype="Int64"),
})
processor = DataProcessor.__new__(DataProcessor)
schema = processor._infer_schema_from_dataframe(frame)
arrow = pa.Table.from_pandas(frame, schema=schema.as_arrow_schema(), preserve_index=False)
frame = Table.from_tuple_likes(iter(arrow.to_pylist()), schema=schema)
before = frame.copy(deep=True)
scope = {}
exec(sys.stdin.read(), scope)
output = scope["process"](frame)
pd.testing.assert_frame_equal(frame, before)
print(output.to_json(orient="records"))`,
      inlineNativeRuntime(compiled.code)
    );
    expect(JSON.parse(output)).toEqual([
      { book_id: 1, user_1: 5, user_2: 4, user_3: 0 },
      { book_id: 2, user_1: 0, user_2: 3, user_3: 2 },
    ]);
  });
}

const loadRuntime = `import importlib.util, sys
import pandas as pd
import numpy as np
spec = importlib.util.spec_from_file_location("native_runtime", sys.argv[1])
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
runtime.pd, runtime.np = pd, np
`;

test("complete integers remain exact above 2**53 and at signed int64 bounds", () => {
  runPython(`${loadRuntime}
values = [2**53 + 1, -(2**63), 2**63 - 1]
frame = pd.DataFrame({"id": pd.Series(values, dtype="Int64")}, index=[2, 0, 1])
before = frame.copy(deep=True)
output = runtime._process_input(frame)
assert str(output.id.dtype) == "int64"
assert output.id.tolist() == frame.id.tolist()
assert set(output.id.tolist()) == set(values)
assert output.index.equals(frame.index)
pd.testing.assert_frame_equal(frame, before)
`);
});

test("missing integers retain their masks and exact values, including all-null columns", () => {
  runPython(`${loadRuntime}
frame = pd.DataFrame({
    "id": pd.Series([2**53 + 1, None, 2**63 - 1], dtype="Int64"),
    "missing": pd.Series([None, None, None], dtype="Int64"),
})
before = frame.copy(deep=True)
output = runtime._process_input(frame)
pd.testing.assert_frame_equal(output, before)
output.loc[0, "id"] = 42
pd.testing.assert_frame_equal(frame, before)
`);
});

test("empty complete integer columns keep their schema without a float conversion", () => {
  runPython(`${loadRuntime}
frame = pd.DataFrame({"id": pd.Series([], dtype="Int64")})
output = runtime._process_input(frame)
assert output.empty and list(output.columns) == ["id"]
assert str(output.id.dtype) == "int64"
assert str(frame.id.dtype) == "Int64"
`);
});

test("float masks and other scalar types retain their existing process behavior", () => {
  runPython(`${loadRuntime}
frame = pd.DataFrame({
    "amount": pd.Series([1.5, None, 2.5], dtype="Float64"),
    "flag": pd.Series([True, None, False], dtype="boolean"),
    "name": pd.Series(["a", None, "b"], dtype="string"),
    "time": pd.to_datetime(["2026-10-03", None, "2026-10-04"], utc=True),
})
before = frame.copy(deep=True)
output = runtime._process_input(frame)
assert str(output.amount.dtype) == "float64"
assert output.amount.isna().tolist() == [False, True, False]
assert output.amount.dropna().tolist() == [1.5, 2.5]
pd.testing.assert_frame_equal(output[["flag", "name", "time"]], before[["flag", "name", "time"]])
pd.testing.assert_frame_equal(frame, before)
`);
});
