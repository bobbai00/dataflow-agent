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
import { compileNativeOp, nativePython } from "./codegen";
import { registeredCatalogText, stageRegisteredEdit } from "./registered";

async function fixture(python: string, settings = "", profileCollection = true) {
  return stageRegisteredEdit({
    operators: {},
    python,
    changes: `set raw: scan(files='unused.csv')\nset kept: filter(raw, predicate="keep", ${settings})`,
    profileCollection,
  });
}
function execute(state: Awaited<ReturnType<typeof fixture>>, rows: string, twice = false) {
  const code = compileNativeOp(state.operators.kept, "kept").code;
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys,pandas as pd
scope={}
exec(json.load(sys.stdin),scope)
frame=${rows}
try:
    output=scope['process'](frame)
    result={'rows':output.to_dict('records'),'columns':list(output.columns),'native':output.attrs['native_v2']}
    if ${twice ? "True" : "False"}:
        result['again']=scope['process'](frame).to_dict('records')
    print(json.dumps(result))
except Exception as error:
    print(json.dumps({'error':str(error)}))`,
    ],
    { input: JSON.stringify(code), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

test("registered predicate keeps stable rows and measures rejected values, including null verdicts", async () => {
  const state = await fixture(
    `def keep(row, *, minimum):
    """Keep nonmissing values at or above the requested threshold."""
    value = row['x']
    return None if value is None else value >= minimum`,
    `settings={"minimum": 2}`
  );
  const result = execute(state, "pd.DataFrame({'x':[3,1,None,1,2], 'label':['a','b','c','d','e']})");
  expect(result.rows).toEqual([
    { x: 3, label: "a" },
    { x: 2, label: "e" },
  ]);
  expect(result.native.operations).toMatchObject({
    keptRows: 2,
    rejectedRows: 3,
    nullPredicates: 1,
    predicateColumns: ["x"],
  });
  // Numbers below a threshold are what the condition was written to reject: no near miss, no line.
  expect(result.native.operations.filterNearMisses).toBeUndefined();
  expect(result.native.operations.filterNoMatch).toBeUndefined();
  expect(result.native.rowEffect).toBe("drop");
  expect(registeredCatalogText(["filter"], "full")).toContain('predicate="name"');
});

test("predicate namespace and mutable settings reset between invocations, but share across rows", async () => {
  const state = await fixture(
    `COUNTER = 0
def keep(row, *, seen=[]):
    global COUNTER
    COUNTER += 1
    seen.append(row['x'])
    return COUNTER <= 2 and len(seen) <= 2`,
    'settings={"seen": []}'
  );
  const result = execute(state, "pd.DataFrame({'x':[3,1,2]})", true);
  expect(result.rows).toEqual([{ x: 3 }, { x: 1 }]);
  expect(result.again).toEqual(result.rows);
});

test("predicate replacement invalidates existing filters and checks their settings atomically", async () => {
  const state = await fixture("def keep(row, *, minimum=1):\n    return row['x'] >= minimum");
  const next = await stageRegisteredEdit({
    ...state,
    python: "def keep(row, *, minimum=1):\n    return row['x'] > minimum",
    changes: "",
  });
  expect(next.changedIds).toContain("kept");
  expect(next.operators.kept.revision).not.toBe(state.operators.kept.revision);
  expect(execute(next, "pd.DataFrame({'x':[1,2]})").rows).toEqual([{ x: 2 }]);
  const before = JSON.stringify(next);
  await expect(
    stageRegisteredEdit({ ...next, python: "def keep(row, required):\n    return True", changes: "" })
  ).rejects.toThrow("invalid inputs/settings");
  expect(JSON.stringify(next)).toBe(before);
});

test.each(["True", "False", "None", "pd.NA", "float('nan')", "np.bool_(True)"])(
  "predicate accepts only boolean or null scalar verdicts: %s",
  async verdict => {
    const state = await fixture(`import pandas as pd
import numpy as np
def keep(row):
    return ${verdict}`);
    const result = execute(state, "pd.DataFrame({'x':[1]})");
    expect(result.error).toBeUndefined();
    expect(result.rows).toHaveLength(["True", "np.bool_(True)"].includes(verdict) ? 1 : 0);
  }
);

test.each(["1", "0", "'yes'", "[True]", "pd.Series([True])"])(
  "predicate rejects truthy/non-scalar verdicts: %s",
  async verdict => {
    const state = await fixture(`import pandas as pd
def keep(row):
    return ${verdict}`);
    expect(execute(state, "pd.DataFrame({'x':[1]})").error).toContain("CALLBACK_RETURN_TYPE");
  }
);

test("registered filter diagnostics identify user definitions and reject invalid bindings before execution", async () => {
  const state = await fixture("def keep(row):\n    return row['missing'] > 0");
  const message = execute(state, "pd.DataFrame({'x':[1]})").error;
  expect(message).toContain("CALLBACK_RUNTIME");
  expect(message).toContain('"cell":1');
  expect(message).toContain("missing");
  // A bare `predicate=keep` is accepted (see registered-spellings.test.ts).
  for (const expression of [
    "filter(raw)",
    "filter(raw, predicate=missing)",
    "filter(raw, predicate='missing')",
    "filter(raw, predicate='keep', settings=[])",
    "filter(raw, predicate='keep', settings={'extra':1})",
    "filter(raw, predicate='keep', fn='keep')",
    "filter(raw, predicate='_private')",
  ]) {
    await expect(
      stageRegisteredEdit({
        operators: {},
        python: "def keep(row):\n    return True\ndef _private(row):\n    return True",
        changes: `set raw: scan(files='unused.csv')\nset kept: ${expression}`,
      })
    ).rejects.toThrow();
  }
});

test("values written like the literal are near misses, clipped like witnesses, and absent when collection is off", async () => {
  const code = "def keep(row):\n    return row['x'] == 'keep'";
  const state = await fixture(code);
  const long = "'Keep' + 'p'*200";
  const result = execute(state, `pd.DataFrame({'x':['Keep', ' keep ', 'Keep', 'c', 'd', 'keep', ${long}]})`);
  expect(result.native.operations.filterNearMisses).toEqual([
    {
      column: "x",
      rows: 3,
      values: [
        { value: "Keep", rows: 2, counterpart: "keep", how: "literal" },
        { value: " keep ", rows: 1, counterpart: "keep", how: "literal" },
      ],
    },
  ]);
  const clipped = execute(
    await fixture("def keep(row):\n    return row['x'] == 'k'*120"),
    "pd.DataFrame({'x':['K'*120, 'k'*120]})"
  ).native.operations.filterNearMisses[0].values[0];
  // A computed literal ('k'*120) is not in the source; the kept value is the reference.
  expect(clipped).toMatchObject({ rows: 1, how: "kept", valueClipped: true, counterpartClipped: true });
  expect(clipped.value).toHaveLength(96);
  const off = execute(await fixture(code, "", false), "pd.DataFrame({'x':['Keep','keep']})");
  expect(off.native.operations.filterNearMisses).toBeUndefined();
  expect(off.native.operations.rejectedRows).toBe(1);
});

test("empty input retains schema without invoking a predicate or inventing reads", async () => {
  const state = await fixture("def keep(row):\n    raise ValueError('must not run')");
  const result = execute(state, "pd.DataFrame({'x':pd.Series([], dtype='Int64')})");
  expect(result.rows).toEqual([]);
  expect(result.columns).toEqual(["x"]);
  expect(result.native.operations).toMatchObject({
    keptRows: 0,
    rejectedRows: 0,
    nullPredicates: 0,
    predicateColumns: [],
  });
});

test("a rejected row is blamed on the part of the condition that failed", async () => {
  // Row 0 fails `a > 0` and never reads b; only row 3 fails `b == 'keep'` with a value written like it.
  const state = await fixture("def keep(row):\n    return row['a'] > 0 and row['b'] == 'keep'");
  const result = execute(state, "pd.DataFrame({'a':[0,1,1,1], 'b':['Keep','B','keep','KEEP']})");
  expect(result.native.operations.filterNearMisses).toEqual([
    { column: "b", rows: 1, values: [{ value: "KEEP", rows: 1, counterpart: "keep", how: "literal" }] },
  ]);
  expect(result.native.operations.timing.operatorBodyMs).toBeGreaterThanOrEqual(0);
  expect(result.native.operations.timing.filterFlowMs).toBeGreaterThanOrEqual(0);
});

test("a numeric comparison reports no near miss: its boundary values are what it rejects", async () => {
  const state = await fixture("def keep(row):\n    return row['x'] > 10");
  const result = execute(state, "pd.DataFrame({'x':[-5, 3, 10, 20, 10, 20]})");
  expect(result.native.operations.filterNearMisses).toBeUndefined();
  expect(result.native.operations.filterNoMatch).toBeUndefined();
});

test("a code written with a stray space is a near miss; other codes are what `in` excludes", async () => {
  const state = await fixture("def keep(row):\n    return row['state'] in ('CT', 'MA')");
  const result = execute(state, "pd.DataFrame({'state':['AL','AK','CT','MA','AZ','MA-NH','CT ']})");
  expect(result.native.operations.filterNearMisses).toEqual([
    { column: "state", rows: 1, values: [{ value: "CT ", rows: 1, counterpart: "CT", how: "literal" }] },
  ]);
});

test("nothing passed a test for literals: the values the condition saw are reported", async () => {
  // wildfire-easy-15: months are not zero-padded, so no date splits to '07'.
  const state = await fixture(
    "def keep(row):\n    return row['d'] is not None and str(row['d']).split('/')[0] == '07'"
  );
  const result = execute(state, "pd.DataFrame({'d':['9/22/2002','8/25/2002','8/25/2002',None]})");
  expect(result.native.operations.filterNoMatch).toEqual({
    column: "d",
    literals: ["07"],
    seen: [
      { values: [{ type: "str", value: "9/22/2002" }], count: 1, truncated: false },
      { values: [{ type: "str", value: "8/25/2002" }], count: 2, truncated: false },
      { values: [null], count: 1, truncated: false },
    ],
  });
});

test("a condition over many columns records every read and predicates cannot mutate the input row", async () => {
  const state = await fixture("def keep(row):\n    return sum(row['c'+str(i)] for i in range(12)) < 0");
  const result = execute(state, "pd.DataFrame({'c'+str(i):[i] for i in range(12)})");
  expect(result.native.operations.predicateColumns).toHaveLength(12);
  expect(result.native.operations.filterNearMisses).toBeUndefined();
  const mutation = await fixture("def keep(row):\n    row['x'] = 2\n    return True");
  expect(execute(mutation, "pd.DataFrame({'x':[1]})").error).toContain("TypeError");
});

test.each([
  "dict(row)['x'] > 0",
  "any(value > 0 for value in row.values())",
  "any(value > 0 for key, value in row.items())",
])("filter records values read through mapping operations: %s", async predicate => {
  const state = await fixture(`def keep(row):\n    return ${predicate}`);
  const result = execute(state, "pd.DataFrame({'x':[0,1]})");
  expect(result.rows).toEqual([{ x: 1 }]);
  expect(result.native.operations.predicateColumns).toEqual(["x"]);
});

async function inline(condition: string, python = "", profileCollection = true) {
  return stageRegisteredEdit({
    operators: {},
    python,
    changes: `set raw: scan(files='unused.csv')\nset kept: filter(raw, ${condition})`,
    profileCollection,
  });
}

test("an inline lambda filters and measures exactly like a registered predicate", async () => {
  const rows = "pd.DataFrame({'x':[3,1,None,1,2], 'label':['a','b','c','d','e']})";
  const named = execute(await fixture("def keep(row):\n    return None if row['x'] is None else row['x'] >= 2"), rows);
  const lambda = execute(await inline("lambda row: None if row['x'] is None else row['x'] >= 2"), rows);
  expect(lambda.rows).toEqual(named.rows);
  for (const key of ["keptRows", "rejectedRows", "nullPredicates", "predicateColumns", "filterRejectedValues"])
    expect(lambda.native.operations[key]).toEqual(named.native.operations[key]);
  expect(lambda.native.operations.predicateColumns).toEqual(["x"]);
});

test("a lambda calls registered helpers, and only a change to a helper it uses re-runs it", async () => {
  const state = await inline(
    "lambda row: norm(row['x']) == 'keep'",
    "def norm(value):\n    return str(value).strip().lower()"
  );
  expect(execute(state, "pd.DataFrame({'x':[' Keep','drop','KEEP']})").rows).toEqual([{ x: " Keep" }, { x: "KEEP" }]);
  const unrelated = await stageRegisteredEdit({ ...state, python: "def other(df):\n    return df", changes: "" });
  expect(unrelated.changedIds).not.toContain("kept");
  const changed = await stageRegisteredEdit({
    ...unrelated,
    python: "def norm(value):\n    return str(value).lower()",
    changes: "",
  });
  expect(changed.changedIds).toContain("kept");
  expect(execute(changed, "pd.DataFrame({'x':[' Keep','keep']})").rows).toEqual([{ x: "keep" }]);
  // predicate= spells the same condition.
  const keyword = await inline(
    "predicate=lambda row: norm(row['x']) == 'keep'",
    "def norm(value):\n    return str(value).strip().lower()"
  );
  expect(keyword.operators.kept.revision).toBe(state.operators.kept.revision);
});

test("lambda conditions are checked before execution and fail at their own source", async () => {
  for (const [condition, message] of [
    ["lambda row, other: True", "one parameter"],
    ["lambda row: True, settings={'x': 1}", "settings belong to a registered predicate"],
    ["lambda row: True, predicate='keep'", "one lambda, not also predicate="],
  ])
    await expect(inline(condition, "def keep(row):\n    return True")).rejects.toThrow(message);
  await expect(
    stageRegisteredEdit({
      operators: {},
      python: "",
      changes: "set raw: scan(files='u.csv')\nset s: sort(raw, by=lambda row: 1)",
    })
  ).rejects.toThrow("a lambda is only a filter's condition");
  await expect(
    stageRegisteredEdit({
      operators: {},
      python: "",
      changes: "set raw: scan(files='u.csv')\nset p: project(raw, lambda row: True)",
    })
  ).rejects.toThrow("a lambda is only a filter's condition");
  await expect(
    stageRegisteredEdit({
      operators: {},
      python: "",
      changes:
        "set raw: scan(files='u.csv')\nset n: aggregate(raw, by=['g'], outputs={'yes': sum(lambda row: row['v'] == 'yes')})",
    })
  ).rejects.toThrow("filter them first and aggregate the kept rows");
  const failing = execute(await inline("lambda row: row['missing'] > 0"), "pd.DataFrame({'x':[1]})").error;
  expect(failing).toContain("CALLBACK_RUNTIME");
  expect(failing).toContain('"entry":"lambda"');
  expect(failing).toContain("row['missing'] > 0");
});

test("a named predicate that was never defined points to the inline form", async () => {
  await expect(
    stageRegisteredEdit({
      operators: {},
      python: "",
      changes: "set raw: scan(files='u.csv')\nset kept: filter(raw, predicate='is_marine')",
    })
  ).rejects.toThrow("filter(t, lambda row: ...)");
});
