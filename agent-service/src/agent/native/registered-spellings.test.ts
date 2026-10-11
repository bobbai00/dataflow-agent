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
import { stageRegisteredEdit } from "./registered";

const keep = "def keep(row, *, minimum=0):\n    \"\"\"Keep rows at or above the minimum.\"\"\"\n    return row['value'] >= minimum\n";

test("descriptor spellings models produce are accepted: quoted dtypes, bare predicate names, preview=True", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python: keep,
    changes: [
      "set raw: scan(files='data.csv', preview=True)",
      "set typed: cast(raw, columns={'value': 'float64', 'when': 'datetime'})",
      "set kept: filter(typed, predicate=keep, settings={'minimum': 1})",
      "set quoted: filter(typed, predicate='keep')",
    ].join("\n"),
  });
  expect(state.operators.raw.properties.preview).toBe(1);
  const columns = JSON.stringify(state.operators.typed.properties.columns);
  expect(columns).toContain("float64");
  expect(columns).toContain("datetime");
  expect((state.operators.kept.properties.registered as any).entry).toBe("keep");
  expect((state.operators.quoted.properties.registered as any).entry).toBe("keep");
  // The documented spellings produce the same definitions.
  const documented = await stageRegisteredEdit({
    operators: {},
    python: keep,
    changes: [
      "set raw: scan(files='data.csv', preview=1)",
      "set typed: cast(raw, columns={'value': float64, 'when': datetime})",
      "set kept: filter(typed, predicate='keep', settings={'minimum': 1})",
    ].join("\n"),
  });
  for (const id of ["raw", "typed", "kept"])
    expect(state.operators[id].revision).toBe(documented.operators[id].revision);
  // Unknown dtype names remain errors, as text or as names.
  await expect(
    stageRegisteredEdit({ ...state, python: "", changes: "set bad: cast(raw, columns={'value': 'float'})" })
  ).rejects.toThrow("must be a dtype");
  await expect(
    stageRegisteredEdit({ ...state, python: "", changes: "set bad: filter(typed, predicate=missing)" })
  ).rejects.toThrow("not a registered public function");
});

test("a nested operator call is rejected with the repair it needs", async () => {
  await expect(
    stageRegisteredEdit({ operators: {}, python: "", changes: "set top: sort(scan(files='d.csv'), by=['a'])" })
  ).rejects.toThrow("Declare a nested call as its own set statement");
});

test("a definition cell identical to the last one is neither appended nor a definition change", async () => {
  const source = "def f(t):\n    return t\n";
  const first = await stageRegisteredEdit({
    operators: {},
    python: source,
    changes: "set raw: scan(files='d.csv')\nset out: f(raw)",
  });
  expect(first.registrations).toEqual([{ name: "f", kind: "registered" }]);
  const again = await stageRegisteredEdit({ ...first, python: source, changes: "" });
  expect(again.namespace.cells).toEqual(first.namespace.cells);
  expect(again.namespace.revision).toBe(first.namespace.revision);
  expect(again.pythonChanged).toBe(false);
  expect(again.changedIds).toEqual([]);
  expect(again.registrations).toEqual([]);
  expect(again.operators.out.revision).toBe(first.operators.out.revision);
  // A changed cell is still appended and invalidates the custom operator.
  const changed = await stageRegisteredEdit({ ...first, python: "def f(t):\n    return t.head(1)\n", changes: "" });
  expect(changed.namespace.cells).toHaveLength(2);
  expect(changed.pythonChanged).toBe(true);
  expect(changed.changedIds).toEqual(["out"]);
  expect(changed.registrations).toEqual([{ name: "f", kind: "updated" }]);
  // Resending the first source after a change is a new cell: it changes the binding back.
  const back = await stageRegisteredEdit({ ...changed, python: source, changes: "" });
  expect(back.namespace.cells).toHaveLength(3);
  expect(back.changedIds).toEqual(["out"]);
});

test("a rejected edit names the public functions it did not register", async () => {
  const python = "def classify(table):\n    return table\ndef _helper(x):\n    return x\n";
  const nested = await stageRegisteredEdit({
    operators: {},
    python,
    changes: "set top: sort(scan(files='d.csv'), by=['a'])",
  }).then(
    () => undefined,
    error => error as Error
  );
  expect(nested!.message).toContain("Declare a nested call as its own set statement");
  expect(nested!.message).toContain("Nothing from this edit was registered, including classify;");
  expect(nested!.message).not.toContain("_helper");
  const unknown = await stageRegisteredEdit({
    operators: {},
    python,
    changes: "set raw: scan(files='d.csv')\nset x: missing(raw)",
  }).then(
    () => undefined,
    error => error as Error
  );
  expect(unknown!.message).toContain("Unknown operator type missing");
  expect(unknown!.message).toContain("including classify");
  // Graph-only edits and successful edits carry no such note.
  const graphOnly = await stageRegisteredEdit({ operators: {}, python: "", changes: "set x: missing()" }).then(
    () => undefined,
    error => error as Error
  );
  expect(graphOnly!.message).not.toContain("Nothing from this edit was registered");
  const accepted = await stageRegisteredEdit({ operators: {}, python, changes: "set raw: scan(files='d.csv')\nset c: classify(raw)" });
  expect(accepted.registrations).toEqual([{ name: "classify", kind: "registered" }]);
});

test("a trailing bare * in a definition means no settings, as written", async () => {
  const state = await stageRegisteredEdit({
    operators: {},
    python:
      "import pandas as pd\n\ndef load_all(*):\n    return pd.DataFrame({'x': [1]})\n\ndef summarize(df, *):\n    return df\n\ndef scaled(df, *, factor=2):\n    return df",
    changes: "set raw: load_all()\nset same: summarize(raw)\nset big: scaled(raw, factor=3)",
  });
  expect(state.namespace.functions.load_all.signature).toBe("()");
  expect(state.namespace.functions.summarize.signature).toBe("(df)");
  expect(state.namespace.functions.scaled.signature).toBe("(df, *, factor=2)");
});
