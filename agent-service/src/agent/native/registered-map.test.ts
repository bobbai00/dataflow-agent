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
import { spawnSync } from "node:child_process";
import { compileNativeOp, inlineNativeRuntime, nativePython } from "./codegen";
import { stageRegisteredEdit } from "./registered";

async function mapped(fn: string, python = "") {
  return stageRegisteredEdit({
    operators: {},
    python,
    changes: `set raw: scan(files='unused.csv')\nset out: map(raw, ${fn})`,
    profileCollection: true,
  });
}
function execute(state: Awaited<ReturnType<typeof mapped>>, rows: string) {
  const code = inlineNativeRuntime(compileNativeOp(state.operators.out, "out").code);
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys,pandas as pd
scope={}
exec(json.load(sys.stdin),scope)
try:
    output=scope['process'](${rows})
    print(json.dumps({'rows':output.to_dict('records'),'columns':list(output.columns),'native':output.attrs['native_v2']}))
except Exception as error:
    print(json.dumps({'error':str(error)}))`,
    ],
    { input: JSON.stringify(code), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

test("map returns each row's new row as a dict and measures what it read, added and dropped", async () => {
  const state = await mapped(
    "lambda row: {**row, 'unit': None if row['qty'] in (None, 0) else row['amount'] / row['qty']}"
  );
  const result = execute(state, "pd.DataFrame({'amount':[10.0,6.0,5.0], 'qty':[2,0,None], 'label':['a','b','c']})");
  expect(result.rows.map((row: any) => row.unit)).toEqual([5, null, null]);
  expect(result.columns).toEqual(["amount", "qty", "label", "unit"]);
  expect(result.native.operations).toMatchObject({
    readColumns: ["amount", "qty"],
    addedColumns: ["unit"],
    droppedColumns: [],
  });
  const narrowed = execute(
    await mapped("lambda row: {'label': row['label'].upper()}"),
    "pd.DataFrame({'label':['a'], 'x':[1]})"
  );
  expect(narrowed.rows).toEqual([{ label: "A" }]);
  expect(narrowed.native.operations.droppedColumns).toEqual(["x"]);
});

test("a map's lambda calls registered helpers, and only a change to a helper it uses re-runs it", async () => {
  const helper = "def flag(value):\n    return 1 if str(value).strip().lower() == 'yes' else 0";
  const state = await mapped("lambda row: {**row, 'is_viol': flag(row['v'])}", helper);
  expect(execute(state, "pd.DataFrame({'v':[' Yes','no']})").rows).toEqual([
    { v: " Yes", is_viol: 1 },
    { v: "no", is_viol: 0 },
  ]);
  const unrelated = await stageRegisteredEdit({ ...state, python: "def other(df):\n    return df", changes: "" });
  expect(unrelated.changedIds).not.toContain("out");
  const changed = await stageRegisteredEdit({
    ...unrelated,
    python: "def flag(value):\n    return 1 if value == 'yes' else 0",
    changes: "",
  });
  expect(changed.changedIds).toContain("out");
});

test("map contracts are checked before execution and fail at the lambda", async () => {
  for (const [fn, message] of [
    ["lambda row, other: {}", "one parameter"],
    ["lambda row: {**row}, doc_note=1", "one lambda that returns the new row"],
  ])
    await expect(mapped(fn)).rejects.toThrow(message);
  await expect(
    stageRegisteredEdit({ operators: {}, python: "", changes: "set raw: scan(files='u.csv')\nset out: map(raw)" })
  ).rejects.toThrow("one lambda that returns the new row");
  const notDict = execute(await mapped("lambda row: row['x'] * 2"), "pd.DataFrame({'x':[1]})").error;
  expect(notDict).toContain("CALLBACK_RETURN_TYPE");
  expect(notDict).toContain('"entry":"lambda"');
  const keys = execute(
    await mapped("lambda row: {'a': 1} if row['x'] else {'b': 2}"),
    "pd.DataFrame({'x':[1, 0]})"
  ).error;
  expect(keys).toContain("MAP_SCHEMA");
  const failing = execute(await mapped("lambda row: {'y': row['missing']}"), "pd.DataFrame({'x':[1]})").error;
  expect(failing).toContain("CALLBACK_RUNTIME");
  expect(failing).toContain("row['missing']");
});

test("join tables bind positionally or as left= and right=, like Python arguments", async () => {
  const python =
    "import pandas as pd\ndef a_rows():\n    return pd.DataFrame({'g': [1]})\ndef b_rows():\n    return pd.DataFrame({'g': [1]})";
  const base = "set a: a_rows()\nset b: b_rows()\n";
  const positional = await stageRegisteredEdit({ operators: {}, python, changes: `${base}set j: join(a, b, on='g')` });
  for (const form of ["join(left=a, right=b, on='g')", "join(a, right=b, on='g')", "join(right=b, left=a, on='g')"]) {
    const named = await stageRegisteredEdit({ operators: {}, python, changes: `${base}set j: ${form}` });
    expect(named.operators.j.inputs).toEqual(["a", "b"]);
    expect(named.operators.j.properties).toEqual(positional.operators.j.properties);
  }
  for (const [form, message] of [
    ["join(b, left=a, on='g')", "two values for its left table"],
    ["join(a, b, left='g', on='g')", "two values for its left table"],
    ["join(left=a, on='g')", "a left and a right table"],
    ["join(a, right='g', on='g')", "name the input tables by operator ID"],
  ])
    await expect(stageRegisteredEdit({ operators: {}, python, changes: `${base}set j: ${form}` })).rejects.toThrow(
      message
    );
});

test("scan lines accepts header=False and its own column names, and rejects any option that would change it", async () => {
  const plain = await stageRegisteredEdit({
    operators: {},
    python: "",
    changes: "set t: scan(files='u.txt', format='lines')",
  });
  for (const options of ["header=False", "header=False, names=['line']", "names=['line_no', 'line']"])
    await stageRegisteredEdit({
      operators: {},
      python: "",
      changes: `set t: scan(files='u.txt', format='lines', ${options})`,
    });
  for (const options of ["header=True", "names=['text']", "delim=','"])
    await expect(
      stageRegisteredEdit({
        operators: {},
        python: "",
        changes: `set t: scan(files='u.txt', format='lines', ${options})`,
      })
    ).rejects.toThrow("SCAN_OPTIONS");
  expect(plain.operators.t.type).toBe("Scan");
});
