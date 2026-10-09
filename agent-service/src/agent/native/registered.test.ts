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
import { compileNativeOp, nativePython, runNativePython } from "./codegen";
import { nativeAssignmentText } from "./catalog";
import { registeredCatalogText, stageRegisteredEdit } from "./registered";

test("registered definitions preserve cell order, settings, helpers, and invocation isolation", async () => {
  const first = await stageRegisteredEdit({
    operators: {},
    python: `import pandas as pd
FACTOR = 2
COUNTER = 0
def _helper(value):
    return value + 1
def load(*, value=FACTOR):
    global COUNTER
    COUNTER += 1
    return pd.DataFrame({'value': [_helper(value)], 'counter': [COUNTER]})
def combine(left, right, *, factor=1):
    return pd.DataFrame({'value': [(left['value'].iloc[0] + right['value'].iloc[0]) * factor]})
`,
    changes: "set a: load()\nset b: load(value=4)\nset c: combine(a, b, factor=3)",
  });
  const second = await stageRegisteredEdit({
    ...first,
    python: "FACTOR = 10\ndef _helper(value):\n    return value + 2",
    changes: "",
  });
  expect(second.namespace.cells).toHaveLength(2);
  expect(second.namespace.functions.load.signature).toContain("value=2");
  const code = Object.fromEntries(
    Object.entries(second.operators).map(([id, view]) => [id, compileNativeOp(view, id).code])
  );
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys
code=json.load(sys.stdin)
scopes={}
for key, source in code.items():
    scopes[key]={}
    exec(source, scopes[key])
a=scopes['a']['load']()
again=scopes['a']['load']()
b=scopes['b']['load']()
c=scopes['c']['process'](a,b)
print(json.dumps([a.to_dict('records'),again.to_dict('records'),b.to_dict('records'),c.to_dict('records')]))`,
    ],
    { input: JSON.stringify(code), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([
    [{ value: 4, counter: 1 }],
    [{ value: 4, counter: 1 }],
    [{ value: 6, counter: 1 }],
    [{ value: 30 }],
  ]);
});

test("edit rejection is atomic and validates the final graph against function signatures", async () => {
  const before = await stageRegisteredEdit({
    operators: {},
    python: "def f(table):\n    return table",
    changes: "set raw: scan(files='data.csv')\nset out: f(raw)",
  });
  const snapshot = JSON.stringify(before);
  await expect(
    stageRegisteredEdit({ ...before, python: "def f(first, second):\n    return first", changes: "" })
  ).rejects.toThrow();
  expect(JSON.stringify(before)).toBe(snapshot);
  await expect(stageRegisteredEdit({ ...before, python: "", changes: "delete raw" })).rejects.toThrow();
  await expect(stageRegisteredEdit({ ...before, python: "", changes: "set raw: f(out)" })).rejects.toThrow();
  await expect(stageRegisteredEdit({ ...before, python: "def scan():\n    pass", changes: "" })).rejects.toThrow();
});

test("invalid declarations identify the changes line and operator without applying earlier edits", async () => {
  const before = await stageRegisteredEdit({ operators: {}, python: "", changes: "set raw: scan(files='data.csv')" });
  const snapshot = JSON.stringify(before);
  for (const [expression, cause] of [
    ["limit(raw, n='one')", "n"],
    ["unknown(raw)", "Unknown operator type unknown"],
    ["limit(raw, n=1, doc=3)", "doc must be a string or None"],
  ]) {
    const error = await stageRegisteredEdit({
      ...before,
      python: "",
      changes: `set first: limit(raw, n=1)\nset invalid: ${expression}`,
    }).then(
      () => undefined,
      error => error as Error
    );
    expect(error!.message).toContain("Changes line 2, operator invalid:");
    expect(error!.message).toContain(cause);
    expect(JSON.stringify(before)).toBe(snapshot);
  }
});

test("missing graph inputs identify the consumer and the declaration that caused the error", async () => {
  const before = await stageRegisteredEdit({
    operators: {},
    python: "",
    changes: "set raw: scan(files='data.csv')\nset result: limit(raw, n=1)",
  });
  await expect(
    stageRegisteredEdit({
      ...before,
      python: "",
      changes: "set first: limit(raw, n=1)\nset result: limit(absent, n=1)",
    })
  ).rejects.toThrow(
    "Changes line 2, operator result: Input operator absent does not exist in the final graph; required by operator result."
  );
  await expect(stageRegisteredEdit({ ...before, python: "", changes: "delete raw" })).rejects.toThrow(
    "Changes line 1, operator raw: Input operator raw does not exist in the final graph; required by operator result."
  );
});

test("graph syntax errors identify their declaration while Python errors retain definition-cell locations", async () => {
  await expect(
    stageRegisteredEdit({
      operators: {},
      python: "",
      changes: "set raw: scan(files='data.csv')\nset invalid: limit(raw, n=)",
    })
  ).rejects.toThrow("Changes line 2, operator invalid:");
  await expect(
    stageRegisteredEdit({ operators: {}, python: "def load(:\n    pass", changes: "set raw: load()" })
  ).rejects.toThrow("<definitions:1>, line 1");
});

test("incomplete graph expressions identify changes and the tokenizer error location", async () => {
  await expect(
    stageRegisteredEdit({
      operators: {},
      python: "",
      changes: "set raw: scan(files='data.csv')\nset invalid: limit(raw, n=1",
    })
  ).rejects.toThrow(/Changes line \d+: .*EOF.*multi-line statement/);
});

test("fixed mappings accept reserved column names and documentation is metadata", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: "",
    changes:
      "set raw: scan(files='data.csv')\nset typed: cast(raw, columns={'doc': float64, 'errors': int64})\nset summary: aggregate(typed, outputs={'by': sum('doc'), 'doc': count()}, doc='Count all records.')\nset unique: distinct(raw, columns=None)",
  });
  expect(state.operators.summary.properties.aggregations).toEqual([
    { fn: "sum", col: "doc", as: "by" },
    { fn: "count", as: "doc" },
  ]);
  expect(state.operators.summary.doc).toBe("Count all records.");
  expect(state.operators.typed.properties.columns).toEqual([
    { column: "doc", dtype: "float64" },
    { column: "errors", dtype: "int64" },
  ]);
  expect(nativeAssignmentText("summary", state.operators.summary)).toStartWith("set summary: aggregate(typed,");
  const changed = await stageRegisteredEdit({
    ...state,
    python: "",
    changes: "set summary: aggregate(typed, outputs={'by': sum('doc'), 'doc': count()}, doc='Updated meaning.')",
  });
  expect(changed.operators.summary.revision).toBe(state.operators.summary.revision);
  expect(compileNativeOp(changed.operators.summary, "summary").code).toBe(
    compileNativeOp(state.operators.summary, "summary").code
  );
  await expect(stageRegisteredEdit({ ...state, python: "", changes: "set x: process(raw, fn=f)" })).rejects.toThrow();
});

test.each([
  ["scan", "scan(files='data.csv', format='xlsx')", "format must be one of"],
  ["project", "project(raw, keep=1)", "keep"],
  ["cast", "cast(raw, columns={'APP_Z_score': 'float'})", 'columns["APP_Z_score"] must be a dtype'],
  ["aggregate", "aggregate(raw, outputs={'mean score': 'mean'})", 'outputs["mean score"]'],
  ["join", "join(raw, raw, on=['x'], how='sideways')", "how"],
  ["union", "union(raw, raw, schema='bad')", "schema"],
  ["distinct", "distinct(raw, keep='bad')", "keep"],
  ["sort", "sort(raw, by=1)", "by"],
  ["limit", "limit(raw, n='one')", "n"],
  ["window", "window(raw, order_by=['x'], outputs={'previous score': 'lag'})", 'outputs["previous score"]'],
  ["unpivot", "unpivot(raw, columns=1)", "columns"],
  ["pivot", "pivot(raw, index=1, columns='x', values='y')", "index"],
])("%s argument failures use the registered reference signature and public fields", async (name, expression, cause) => {
  const error = await stageRegisteredEdit({
    operators: {},
    python: "",
    changes: `set raw: scan(files='data.csv')\nset invalid: ${expression}`,
  }).then(
    () => undefined,
    error => error as Error
  );
  expect(error).toBeInstanceOf(Error);
  expect(error!.message).toContain(cause);
  expect(error!.message).toContain(`Signature: ${registeredCatalogText([name], "full").split("\n")[0]}`);
  expect(error!.message).not.toContain("_registered_output_");
  expect(error!.message).not.toContain("(T,");
});

test("missing scan files uses the registered keyword syntax in its correction", async () => {
  const error = await stageRegisteredEdit({ operators: {}, python: "", changes: "set raw: scan()" }).then(
    () => undefined,
    error => error as Error
  );
  expect(error!.message).toContain('scan(files="data/dir/file.csv")');
  expect(error!.message).not.toContain('scan("data/dir/file.csv")');
  expect(error!.message).toContain("Signature: scan(files=...");
});

test("mapping diagnostics translate correction examples without recursively rewriting real column names", async () => {
  for (const [expression, expected] of [
    ["aggregate(raw, outputs={'mean score': mean()})", 'outputs={"mean score": mean("col")}'],
    ["window(raw, order_by=['x'], outputs={'previous score': lag()})", 'outputs={"previous score": lag("col", 1)}'],
    [
      "cast(raw, columns={'_registered_output_1': 'float', 'actual': float64})",
      'columns["_registered_output_1"] must be a dtype',
    ],
  ]) {
    const error = await stageRegisteredEdit({
      operators: {},
      python: "",
      changes: `set raw: scan(files='data.csv')\nset invalid: ${expression}`,
    }).then(
      () => undefined,
      error => error as Error
    );
    expect(error!.message).toContain(expected);
    expect(error!.message).not.toContain('columns["actual"]');
  }
});

test("graph IDs and function names do not inherit JavaScript object properties", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: "def constructor(table):\n    return table",
    changes: "set __proto__: scan(files='data.csv')\nset result: constructor(__proto__)",
  });
  expect(Object.keys(state.operators)).toEqual(["__proto__", "result"]);
  expect(state.registrations).toEqual([{ name: "constructor", kind: "registered" }]);
  const builtins = await stageRegisteredEdit({
    ...state,
    python: "",
    changes: "set constructor: limit(__proto__, n=1)\nset toString: limit(constructor, n=1)",
  });
  for (const [id, input] of [
    ["constructor", "__proto__"],
    ["toString", "constructor"],
  ])
    expect(builtins.operators[id].inputs).toEqual([input]);
});

test("graph comments and numeric settings retain deterministic meaning", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: "def f(*, value):\n    return value",
    changes: "set scalar: f(value=1e100)",
  });
  expect((state.operators.scalar.properties.registered as any).settings.value).toBe(1e100);
  const empty = await stageRegisteredEdit({
    ...state,
    python: "",
    changes: "delete scalar # remove it\n# trailing explanation",
  });
  expect(Object.keys(empty.operators)).toEqual([]);
  await expect(
    stageRegisteredEdit({ ...state, python: "", changes: "set scalar: f(value=9007199254740993)" })
  ).rejects.toThrow("faithfully representable");
  await expect(stageRegisteredEdit({ ...state, python: "", changes: "set scalar: f(value=1e309)" })).rejects.toThrow(
    "finite"
  );
});

test.each(["names", "delim", "comment", "widths", "sheet", "encoding", "file_column", "preview"])(
  "scan explicit %s=None equals the advertised omitted default",
  async setting => {
    const state = await stageRegisteredEdit({
      operators: {},
      python: "",
      changes: `set omitted: scan(files='data.csv')\nset explicit: scan(files='data.csv', ${setting}=None)`,
    });
    expect(state.operators.explicit.properties).toEqual(state.operators.omitted.properties);
  }
);

test("advertised project, distinct, and cross-join None defaults equal omission", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: "",
    changes: `
set raw: scan(files='data.csv')
set p1: project(raw, rename={'value': 'number'})
set p2: project(raw, keep=None, drop=None, rename={'value': 'number'})
set p3: project(raw, keep=['value'])
set p4: project(raw, keep=['value'], drop=None, rename=None)
set d1: distinct(raw)
set d2: distinct(raw, columns=None)
set j1: join(raw, raw, how='cross')
set j2: join(raw, raw, on=None, how='cross')
`,
  });
  for (const [omitted, explicit] of [
    ["p1", "p2"],
    ["p3", "p4"],
    ["d1", "d2"],
    ["j1", "j2"],
  ]) {
    expect(state.operators[explicit].properties).toEqual(state.operators[omitted].properties);
  }
});

test("scan detailed reference defines rare settings while the index stays compact", () => {
  const index = registeredCatalogText(["scan"]);
  const full = registeredCatalogText(["scan"], "full");
  expect(index).toContain("preview is an integer 1..200");
  for (const option of ["skip_lines=", "widths=", "encoding=", "file_column=", "comment="]) {
    expect(index).not.toContain(option);
    expect(full).toContain(option);
  }
  expect(full).toContain("widths is a list of positive field widths");
  expect(full).toContain("file_column names a new provenance column");
  expect(full).toContain("Format-specific settings:");
});

test("forward and repeated inputs work, and source/default/graph replacements validate together", async () => {
  const first = await stageRegisteredEdit({
    operators: {},
    python: "import pandas as pd\nclass Config:\n    limit=3\ndef f(*tables, options=None):\n    return tables[0]",
    changes: "set both: f(raw, raw, options={'flags': [True, None]})\nset raw: scan(files='data.csv')",
  });
  expect(first.namespace.bindings.pd.kind).toBe("import");
  expect(first.namespace.bindings.Config.kind).toBe("class");
  expect(first.operators.both.inputs).toEqual(["raw", "raw"]);
  const next = await stageRegisteredEdit({
    ...first,
    python: "def f(table, *, limit):\n    return table.head(limit)",
    changes: "set both: f(raw, limit=2)",
  });
  expect(next.registrations).toEqual([{ name: "f", kind: "updated" }]);
  await expect(stageRegisteredEdit({ ...next, python: "", changes: "set both: f(raw, limit=(1,2))" })).rejects.toThrow(
    "literals"
  );
  await expect(
    stageRegisteredEdit({ ...next, python: "", changes: "set both: f(raw, limit=Config.limit)" })
  ).rejects.toThrow();
  await expect(
    stageRegisteredEdit({ ...next, python: "", changes: "set raw: scan(files='a.csv')\nset raw: scan(files='b.csv')" })
  ).rejects.toThrow("more than once");
});

test("definition initialization errors and timeouts are bounded before commit", async () => {
  await expect(stageRegisteredEdit({ operators: {}, python: "VALUE = 1 / 0", changes: "" })).rejects.toThrow(
    "ZeroDivisionError"
  );
  await expect(
    runNativePython({ registered: true, phase: "validate", cells: ["VALUE = 1"], operators: [] }, 1)
  ).rejects.toThrow("timed out");
});

test("definition initialization rejects side effects and reserved binding forms", async () => {
  for (const python of [
    "open('/tmp/registered-definition-write', 'w').write('must not run')",
    "VALUE = open('/tmp/registered-definition-write', 'w')",
    "def f(value=open('/tmp/registered-definition-write', 'w')):\n    return value",
    "@side_effect\ndef f():\n    pass",
    "class Config:\n    value = open('/tmp/registered-definition-write', 'w')",
    "import sys\nsys.path = []",
    "while True: pass",
    "scan = 1",
    "import json as project",
    "class map:\n    pass",
  ])
    await expect(stageRegisteredEdit({ operators: {}, python, changes: "" })).rejects.toThrow();
});

test("registered runtime errors identify the function, definition cell, and source line", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: "def broken():\n    raise ValueError('example failure')",
    changes: "set output: broken()",
  });
  const code = compileNativeOp(state.operators.output, "output").code;
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys\nscope={}\nexec(json.load(sys.stdin),scope)\ntry: scope['load']()\nexcept Exception as error: print(str(error))`,
    ],
    { input: JSON.stringify(code), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  const diagnostic = JSON.parse(run.stdout.trim().replace("NATIVE_ERROR_V2:", ""));
  expect(diagnostic.code).toBe("CALLBACK_RUNTIME");
  expect(diagnostic.source).toEqual({
    entry: "broken",
    line: 2,
    excerpt: "    raise ValueError('example failure')",
    cell: 1,
  });
});

test("registered functions observe bounded reader and empty-filter events across definition cells", async () => {
  const first = await stageRegisteredEdit({
    operators: {},
    python: `import pandas as pd
import io
def _read():
    return pd.read_csv(io.StringIO('value\\n1\\n2\\n'))`,
    changes: "",
  });
  const state = await stageRegisteredEdit({
    ...first,
    python: `def load():
    for _ in range(20):
        table = _read()
        table = table[table['value'] < 0]
    return table`,
    changes: "set output: load()",
  });
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys
scope={}
exec(json.load(sys.stdin),scope)
result=scope['load']()
print(json.dumps(result.attrs['native_v2']['operations']))`,
    ],
    {
      input: JSON.stringify(compileNativeOp(state.operators.output, "output").code),
      encoding: "utf8",
    }
  );
  expect(run.status, run.stderr).toBe(0);
  const observed = JSON.parse(run.stdout).process;
  expect(observed.reads).toHaveLength(16);
  expect(observed.reads[0]).toMatchObject({ cell: 1, line: 4, file: "StringIO", rows: 2 });
  expect(observed.events).toHaveLength(8);
  expect(observed.events[0]).toMatchObject({ cell: 2, line: 4, op: "filter", out: 0 });
  expect(observed.readsOmitted).toBe(4);
  expect(observed.eventsOmitted).toBe(12);
  expect(observed.lineage).toBe("unknown");
});

test.each([
  ["return table['Identity Theft']", ["Identity Theft "], true],
  ["return table.loc[:, 'Identity Theft']", ["Identity Theft "], true],
  ["return {'value': 1}['Identity Theft']", ["Identity Theft "], false],
  ["return table['Identity Theft']", ["Identity Theft ", " Identity Theft"], false],
  ["return table['Identity Theft']", ["Other"], false],
])(
  "registered column hints are grounded only in an unambiguous DataFrame KeyError: %s / %j",
  async (statement, columns, hint) => {
    const state = await stageRegisteredEdit({
      operators: {},
      python: `def broken(table):\n    ${statement}`,
      changes: "set raw: scan(files='data.csv')\nset output: broken(raw)",
    });
    const run = spawnSync(
      nativePython(),
      [
        "-c",
        `import json,sys,pandas as pd
code,columns=json.load(sys.stdin)
scope={}
exec(code,scope)
try: scope['process'](pd.DataFrame({name:[1] for name in columns}))
except Exception as error: print(str(error))`,
      ],
      {
        input: JSON.stringify([compileNativeOp(state.operators.output, "output").code, columns]),
        encoding: "utf8",
      }
    );
    expect(run.status, run.stderr).toBe(0);
    const diagnostic = JSON.parse(run.stdout.trim().replace("NATIVE_ERROR_V2:", ""));
    expect(diagnostic.code).toBe("CALLBACK_RUNTIME");
    expect(diagnostic.message.includes('Exact column name: "Identity Theft "')).toBe(hint);
    expect(diagnostic.source).toMatchObject({ cell: 1, entry: "broken", line: 2 });
  }
);

test("an operator carries the definitions its function reaches; unrelated or re-sent definitions leave it current", async () => {
  const first = await stageRegisteredEdit({
    operators: {},
    python: `import pandas as pd
RATE = 2
def _scale(values):
    return values * RATE
def priced(table):
    return table.assign(value=_scale(table['value']))
def counted(table):
    return pd.DataFrame({'rows': [len(table)]})
`,
    changes: "set raw: scan(files='data.csv')\nset a: priced(raw)\nset b: counted(raw)",
  });
  const cellsOf = (state: typeof first, id: string) =>
    (state.operators[id].properties.registered as { cells: string[] }).cells;
  expect(cellsOf(first, "a")[0]).not.toContain("def counted");
  expect(cellsOf(first, "b")[0]).not.toContain("RATE");
  // A new function, with the import every cell repeats, changes no existing operator.
  const unrelated = await stageRegisteredEdit({
    ...first,
    python: "import pandas as pd\ndef other(table):\n    return table",
    changes: "",
  });
  expect(unrelated.changedIds).toEqual([]);
  expect(unrelated.operators.a.revision).toBe(first.operators.a.revision);
  expect(unrelated.operators.b.revision).toBe(first.operators.b.revision);
  // Redefining a helper changes exactly the operators whose function reaches it.
  const helper = await stageRegisteredEdit({ ...unrelated, python: "RATE = 3", changes: "" });
  expect(helper.changedIds).toEqual(["a"]);
  expect(helper.operators.b.revision).toBe(first.operators.b.revision);
  // Kept statements stay at their cell and line, so errors keep pointing at authored source.
  const cells = cellsOf(helper, "a");
  expect(cells).toEqual([expect.any(String), "", "RATE = 3"]);
  expect(cells[0].split("\n").slice(0, 2)).toEqual(["", "RATE = 2"]);
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys,pandas as pd
scope={}
exec(json.load(sys.stdin),scope)
print(json.dumps(scope['process'](pd.DataFrame({'value':[1,2]}))['value'].tolist()))`,
    ],
    { input: JSON.stringify(compileNativeOp(helper.operators.a, "a").code), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([3, 6]);
});

test("a function that looks definitions up by string keeps the whole namespace", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: "def pick(table):\n    return globals()['_named'](table)\ndef _named(table):\n    return table",
    changes: "set raw: scan(files='data.csv')\nset picked: pick(raw)",
  });
  const next = await stageRegisteredEdit({ ...state, python: "def unrelated(table):\n    return table", changes: "" });
  expect(next.changedIds).toEqual(["picked"]);
  expect((next.operators.picked.properties.registered as { cells: string[] }).cells).toEqual(next.namespace.cells);
});

test("name@N reads the version task N left: the current operator when unchanged, else a read-only copy", async () => {
  const task1 = await stageRegisteredEdit({
    operators: {},
    python: "RATE = 2\ndef priced(table):\n    return table.assign(value=table['value'] * RATE)",
    changes: "set raw: scan(files='data.csv')\nset prices: priced(raw)",
  });
  const saved = structuredClone(task1.operators);
  const at = (task: number) => (task === 1 ? saved : undefined);
  // Unchanged since task 1, so the reference is the current operator itself.
  const same = await stageRegisteredEdit({
    ...task1,
    saved: at,
    python: "",
    changes: "set first: limit(prices@1, n=1)",
  });
  expect(same.operators.first.inputs).toEqual(["prices"]);
  expect(Object.keys(same.operators).filter(id => id.includes("@"))).toEqual([]);
  // After its helper changes, task 1's version is a copy that keeps task 1's definitions.
  const changed = await stageRegisteredEdit({ ...task1, saved: at, python: "RATE = 3", changes: "" });
  const compare = await stageRegisteredEdit({
    ...changed,
    saved: at,
    python: "",
    changes: "set both: union(prices@1, prices)",
  });
  expect(compare.operators.both.inputs).toEqual(["prices@1", "prices"]);
  expect(compare.operators["prices@1"]).toMatchObject({ inputs: ["raw"], savedFrom: { task: 1, id: "prices" } });
  expect(compare.operators["prices@1"].properties.registered).toEqual(saved.prices.properties.registered);
  expect(compare.operators["prices@1"].revision).toBe(saved.prices.revision);
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys,pandas as pd
out=[]
for code in json.load(sys.stdin):
    scope={}
    exec(code,scope)
    out.append(scope['process'](pd.DataFrame({'value':[1,2]}))['value'].tolist())
print(json.dumps(out))`,
    ],
    {
      input: JSON.stringify([
        compileNativeOp(compare.operators["prices@1"], "prices@1").code,
        compileNativeOp(compare.operators.prices, "prices").code,
      ]),
      encoding: "utf8",
    }
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([
    [2, 4],
    [3, 6],
  ]);
  // A version the same edit changes is still read as task 1 left it.
  const together = await stageRegisteredEdit({
    ...task1,
    saved: at,
    python: "RATE = 3",
    changes: "set both: union(prices@1, prices)",
  });
  expect(together.operators.both.inputs).toEqual(["prices@1", "prices"]);
  expect(() => compileNativeOp(together.operators.both, "both")).not.toThrow();
  expect(together.operators["prices@1"].revision).toBe(saved.prices.revision);
  // Once nothing reads the copy, it is gone.
  const cleared = await stageRegisteredEdit({ ...compare, saved: at, python: "", changes: "delete both" });
  expect(cleared.operators["prices@1"]).toBeUndefined();
  await expect(
    stageRegisteredEdit({ ...task1, saved: at, python: "", changes: "set x: limit(prices@4, n=1)" })
  ).rejects.toThrow("prices@4: task 4 has no saved state");
  await expect(
    stageRegisteredEdit({ ...task1, saved: at, python: "", changes: "set x: limit(missing@1, n=1)" })
  ).rejects.toThrow("missing did not exist at the end of task 1");
  await expect(
    stageRegisteredEdit({ ...task1, saved: at, python: "", changes: "set x: limit(prices@0, n=1)" })
  ).rejects.toThrow("name@N");
});

test("aggregate complete=True also emits the observed key combinations that have no rows", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: "",
    changes:
      "set raw: scan(files='data.csv')\n" +
      "set counts: aggregate(raw, by=['region', 'kind'], outputs={'n': count(), 'total': sum('value')}, complete=True)",
  });
  expect(state.operators.counts.properties.complete).toBe(true);
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `import json,sys,pandas as pd
scope={}
exec(json.load(sys.stdin),scope)
out=scope['process'](pd.DataFrame({'region':['a','a','b'],'kind':['x','y','x'],'value':[1,2,3]}))
print(json.dumps(out.astype(object).where(pd.notna(out), None).to_dict('records')))`,
    ],
    { input: JSON.stringify(compileNativeOp(state.operators.counts, "counts").code), encoding: "utf8" }
  );
  expect(run.status, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual([
    { region: "a", kind: "x", n: 1, total: 1 },
    { region: "a", kind: "y", n: 1, total: 2 },
    { region: "b", kind: "x", n: 1, total: 3 },
    { region: "b", kind: "y", n: 0, total: null },
  ]);
});
