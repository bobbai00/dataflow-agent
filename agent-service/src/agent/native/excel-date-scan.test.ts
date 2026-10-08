/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileNativeOp, nativePython } from "./codegen";

const columns = ["Date", "Calendar", "Time", "Invoice Number", "Quantity"];
const expectedRows = [
  {
    Date: "2013-01-01T00:00:00",
    Calendar: "2014-02-03T00:00:00",
    Time: "09:15:30.123000",
    "Invoice Number": 1,
    Quantity: 10.5,
  },
  {
    Date: "2013-01-02T14:05:06.123000",
    Calendar: "2014-02-04T00:00:00",
    Time: "10:00:00",
    "Invoice Number": 2,
    Quantity: 4,
  },
  { Date: null, Calendar: null, Time: null, "Invoice Number": 3, Quantity: 2 },
];
const runPython = `
import json, sys
from datetime import date, datetime, time
import openpyxl
import pyarrow as pa
request = json.load(sys.stdin)
book = openpyxl.Workbook()
sheet = book.active
sheet.title = 'Sheet1'
if not request['headerless']:
    sheet.append(['Date', 'Calendar', 'Time', 'Invoice Number', 'Quantity'])
sheet.append([datetime(2013, 1, 1), date(2014, 2, 3), time(9, 15, 30, 123000), 1, 10.5])
sheet.append([datetime(2013, 1, 2, 14, 5, 6, 123000), date(2014, 2, 4), time(10, 0), 2, 4])
sheet.append([None, None, None, 3, 2])
book.save(request['file'])
namespace = {}
exec(request['code'], namespace)
try:
    result = namespace['load']()
    records = pa.Table.from_pandas(result, preserve_index=False).to_pylist()
    print(json.dumps({'columns': list(result.columns), 'rows': records}))
except Exception as error:
    print(json.dumps({'error': str(error)}))
`;

function scan(properties: Record<string, unknown> = {}, headerless = false) {
  const directory = mkdtempSync(join(tmpdir(), "native-excel-calendar-"));
  try {
    const file = join(directory, "retail.xlsx");
    const code = compileNativeOp({
      type: "Scan",
      properties: { files: file, sheet: "Sheet1", ...properties },
      inputs: [],
    }).code;
    const run = spawnSync(nativePython(), ["-c", runPython], {
      input: JSON.stringify({ code, file, headerless }),
      encoding: "utf8",
      timeout: 30_000,
    });
    if (run.error) throw run.error;
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("default Excel scan preserves timezone-free calendar cells for engine transport", () => {
  expect(scan()).toEqual({ columns, rows: expectedRows });
});

test("Excel calendar normalization applies to headerless scans with explicit names", () => {
  expect(scan({ header: false, names: columns }, true)).toEqual({ columns, rows: expectedRows });
});

test("all-text Excel scans retain their existing string formatting", () => {
  const result = scan({ allText: true });
  expect(result.error).toBeUndefined();
  expect(result.rows[0]).toEqual({
    Date: "2013-01-01 00:00:00",
    Calendar: "2014-02-03 00:00:00",
    Time: "09:15:30.123000",
    "Invoice Number": "1",
    Quantity: "10.5",
  });
  expect(result.rows[2]).toEqual({ Date: null, Calendar: null, Time: null, "Invoice Number": "3", Quantity: "2" });
});

test("raw Excel previews retain sheet rows and calendar text formatting", () => {
  expect(scan({ preview: 1, skipLines: 1 })).toEqual({
    columns: ["sheet", "row_no", "line"],
    rows: [
      { sheet: "Sheet1", row_no: 1, line: "2013-01-01 00:00:00 | 2014-02-03 00:00:00 | 09:15:30.123000 | 1 | 10.5" },
    ],
  });
});

test("Excel source normalization does not admit naive datetime outputs from Process", () => {
  const code = compileNativeOp({
    type: "Process",
    inputs: [],
    properties: { entry: "load", code: "def load():\n    return pd.DataFrame({'Date': [pd.Timestamp('2013-01-01')]})" },
  }).code;
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `
import json, sys
namespace = {}
exec(json.load(sys.stdin), namespace)
try:
    namespace['load']()
    raise AssertionError('accepted a timezone-naive callback output')
except namespace['_native_scope']['NativeError'] as error:
    print(error.diagnostic['code'])
`,
    ],
    { input: JSON.stringify(code), encoding: "utf8", timeout: 30_000 }
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe("OUTPUT_VALUE_TYPE");
});
