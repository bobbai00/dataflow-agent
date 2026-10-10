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
import { compileNativeOp, nativePython } from "./codegen";

test("generated native consumers restore UTC after timestamp transport", () => {
  const cast = compileNativeOp(
    {
      type: "Cast",
      inputs: ["source"],
      properties: {
        columns: [{ column: "when", dtype: "datetime", timezone: "America/Los_Angeles" }],
      },
    },
    "dates"
  );
  const consumer = compileNativeOp(
    {
      type: "Project",
      inputs: ["dates"],
      properties: { keep: ["when"] },
      graph: { inputPorts: ["in"] },
    },
    "result"
  );
  const engine = fileURLToPath(new URL("../../../../amber/src/main/python", import.meta.url));
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `
import json, sys
sys.path.insert(0, sys.argv[1])
import pandas as pd
import pyarrow as pa
from core.models.table import Table
from core.runnables.data_processor import DataProcessor
cast_code, consumer_code = json.load(sys.stdin)
cast, consumer = {}, {}
exec(cast_code, cast)
exec(consumer_code, consumer)
runtime = consumer['_native_scope']
processor = DataProcessor.__new__(DataProcessor)
for empty in (False, True):
    source = pd.DataFrame({'when': ['2025-01-01 00:00:00', None]})
    if empty:
        source = source.iloc[:0]
    expected = cast['process'](source)
    schema = processor._infer_schema_from_dataframe(expected)
    arrow = pa.Table.from_pandas(expected, schema=schema.as_arrow_schema(), preserve_index=False)
    transported = Table.from_tuple_likes(iter(arrow.to_pylist()), schema=schema)
    assert transported['when'].dt.tz is None
    actual = consumer['process'](transported)
    assert str(actual['when'].dt.tz) == 'UTC'
    assert actual['when'].tolist() == expected['when'].tolist()
    assert transported['when'].dt.tz is None, 'adapter mutated a shared input'
    # Direct runtime calls still enforce the producer contract. Arbitrary
    # timezone-naive callback outputs must not become implicitly valid.
    try:
        runtime['execute_native'](consumer['_native_spec'], [transported])
        raise AssertionError('direct call accepted a naive timestamp')
    except runtime['NativeError'] as error:
        assert error.diagnostic['code'] == 'INPUT_VALUE_TYPE'
print('ok')
`,
      engine,
    ],
    { input: JSON.stringify([cast.code, consumer.code]), encoding: "utf8", timeout: 60_000 }
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe("ok");
});
