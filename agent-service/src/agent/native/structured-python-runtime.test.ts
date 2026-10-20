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
import { readFileSync } from "node:fs";
import { nativePython } from "./codegen";

test("JSON callbacks accept normal Python signatures and preserve naive calendar times", () => {
  const runtime = readFileSync(new URL("./python/runtime.py", import.meta.url), "utf8");
  const run = spawnSync(
    nativePython(),
    [
      "-c",
      `
import json,sys,datetime
import pandas as pd
scope={'__name__':'native_runtime_test'}
exec(json.load(sys.stdin),scope)
code="def compute(frame, optional=3, *extra, **kwargs):\\n    out = frame.copy()\\n    out['when'] = pd.to_datetime(out['when'])\\n    return out"
spec={'id':'out','type':'Process','inputs':['source'],'properties':{'code':code,'entry':'compute','doc':'Parse dates'},'functionValidation':'callable','datetimePolicy':'preserve'}
source=pd.DataFrame({'when':['2024-01-01 12:30:00',None]})
result=scope['execute_native'](spec,[source])
assert result['when'][0]=='2024-01-01T12:30:00'
assert pd.isna(result['when'][1])
assert source['when'][0]=='2024-01-01 12:30:00','shared input mutated'
legacy={**spec};legacy.pop('functionValidation');legacy.pop('datetimePolicy')
try:scope['validate_native'](legacy);raise AssertionError('legacy signature changed')
except scope['NativeError'] as e:assert e.diagnostic['code']=='CALLBACK_SIGNATURE'
cast={'id':'cast','type':'Cast','inputs':['source'],'properties':{'columns':[{'column':'when','dtype':'datetime'}]},'datetimePolicy':'preserve'}
result=scope['execute_native'](cast,[source])
assert result['when'][0]=='2024-01-01T12:30:00'
mapper={'id':'mapped','type':'Map','inputs':['source'],'properties':{'func':"def apply(row):\\n    import datetime\\n    return {'day':datetime.datetime(2024,1,1,12,30)}",'entry':'apply','doc':'Calendar'},'functionValidation':'callable','datetimePolicy':'preserve'}
result=scope['execute_native'](mapper,[source])
assert result['day'][0]=='2024-01-01T12:30:00'
# Validation compiles code, never evaluates imports, decorators or function bodies.
side_effect={**spec,'properties':{**spec['properties'],'code':"raise RuntimeError('must not execute')\\ndef compute(frame, optional=3):\\n    return frame"}}
scope['validate_native'](side_effect)
print('ok')
`,
    ],
    { input: JSON.stringify(runtime), encoding: "utf8", timeout: 60_000 }
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.stdout.trim()).toBe("ok");
});
