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
import { fileURLToPath } from "node:url";

test("input contract errors name the producer/port; output errors remain output errors", () => {
  const run = Bun.spawnSync([
    fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url)),
    "-c",
    `
import importlib.util, json, sys
import pandas as pd
loader = importlib.util.spec_from_file_location('native_runtime', sys.argv[1])
r = importlib.util.module_from_spec(loader)
loader.loader.exec_module(r)
spec = dict(id='consumer', revision='0123456789abcdef', type='Process', inputs=['producer'], properties={'code': "def process(producer):\\n    raise RuntimeError('CALLBACK_MUST_NOT_RUN')", 'entry': 'process'})
diagnostics = []
for frame in [pd.DataFrame({'geometry': [{'nested': 1}]}), pd.DataFrame({'x': [float('inf')]}), pd.DataFrame([[1]], columns=[7])]:
    try:
        r.execute_native(spec, [frame])
    except r.NativeError as error:
        diagnostics.append(error.diagnostic)
source = dict(spec, id='source', inputs=[], properties={'code': "def load():\\n    import pandas as pd\\n    return pd.DataFrame({'geometry': [{'nested': 1}]})", 'entry': 'load'})
try:
    r.execute_native(source, [])
except r.NativeError as error:
    diagnostics.append(error.diagnostic)
print(json.dumps(diagnostics))
`,
    fileURLToPath(new URL("./python/runtime.py", import.meta.url)),
  ]);
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  const errors = JSON.parse(run.stdout.toString());
  expect(errors).toHaveLength(4);
  for (const error of errors.slice(0, 3)) {
    expect(error.code).toMatch(/^INPUT_/);
    expect(error.field).toBe("inputs[0]");
    expect(error.message).toContain("producer");
    expect(error.message).toContain("has not run");
    expect(error.message).not.toContain("CALLBACK_MUST_NOT_RUN");
    expect(error.source).toBeUndefined();
  }
  expect(errors[3].code).toBe("OUTPUT_VALUE_TYPE");
});
