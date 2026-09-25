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

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { nativeTestSession } from "../e2e/native-test-session";

assert.ok(process.env.LONGDS_NATIVE_ISOLATION, "Use the isolated benchmark engine");
const out = resolve(process.argv[2] ?? `/tmp/texera-isolation-smoke-${Date.now()}`);
mkdirSync(out, { recursive: true });
const fixture = resolve(`data/longds/.isolation-smoke-${Date.now()}`);
mkdirSync(fixture);
const source = `${fixture}/source.csv`;
writeFileSync(source, "value\n10\n20\n");
const forbidden = [
  `${realpathSync("benchmark/longds/prepared")}/education__bi__task2/gold.json`,
  realpathSync("benchmark/longds/system_scratch"),
  `${process.cwd()}/docs/analysis-state-implementation.md`,
];
assert.ok(forbidden.every(path => existsSync(path)));
const session = await nativeTestSession({ nativeAnalysisState: true });
try {
  const code = `def isolation_probe():
    import os, pandas as pd
    from pathlib import Path
    for path in ${JSON.stringify(forbidden)}:
        assert not Path(path).exists(), "host reference or run directory was exposed"
    assert not os.environ.get("OPENAI_API_KEY"), "provider key reached worker"
    assert not os.environ.get("LITELLM_MASTER_KEY"), "provider key reached worker"
    source = Path(${JSON.stringify(source)})
    data = pd.read_csv(source)
    try:
        with source.open("a"):
            pass
    except OSError:
        pass
    else:
        raise AssertionError("source was writable")
    Path("/workspace/marker.txt").write_text("private persistent state")
    return pd.DataFrame({"total": [int(data.value.sum())]})
probe = process(fn=isolation_probe, doc="Checks benchmark filesystem isolation")`;
  const first = await session.debug({ edits: code, observe: ["probe"] });
  await Bun.write(`${out}/first.json`, JSON.stringify(first, null, 2));
  assert.deepEqual((first.snapshot.results.probe as { sampleRecords?: unknown[] })?.sampleRecords, [{ total: 30 }]);
  const second = await session.debug({
    edits: `def read_private_state():
    import pandas as pd
    from pathlib import Path
    assert Path("/workspace/marker.txt").read_text() == "private persistent state"
    return pd.DataFrame({"retained": [True]})
retained = process(fn=read_private_state, doc="Checks private state across worker executions")`,
    observe: ["retained"],
  });
  await Bun.write(`${out}/second.json`, JSON.stringify(second, null, 2));
  assert.deepEqual((second.snapshot.results.retained as { sampleRecords?: unknown[] })?.sampleRecords, [
    { retained: true },
  ]);
  await Bun.write(`${out}/summary.json`, JSON.stringify({ passed: true, workflowId: session.workflowId }));
  console.log(JSON.stringify({ passed: true, out }));
} finally {
  await session.close();
  rmSync(fixture, { recursive: true });
}
