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
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { persistOperatorResults } from "../tools/workflow-execution-tools";
import { collectNativeEvidence, selectNativeObservation } from "./evidence";
import { prepareStructuredExecutionResult } from "./execution-transport";
import { workflowExecutionPlan } from "./result-versions";

test("actual Python operators and collector feed version-bound data/flow evidence", () => {
  const python = fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
  const amber = fileURLToPath(new URL("../../../../amber/src/main/python", import.meta.url));
  const runtime = fileURLToPath(new URL("./python/runtime.py", import.meta.url));
  const run = Bun.spawnSync(
    [
      python,
      "-c",
      `
import importlib.util, json, sys, tempfile
from pathlib import Path
from core.util.table_profile import ProfileAccumulator
loader = importlib.util.spec_from_file_location('native_runtime', sys.argv[1])
r = importlib.util.module_from_spec(loader)
loader.loader.exec_module(r)
records, frames = [], {}
def transport(value):
    value = r._scalar(value)
    return str(value) if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 9007199254740991 else value
def execute(id, kind, inputs, **properties):
    spec = dict(version='v2', id=id, revision='0123456789abcdef', type=kind, inputs=inputs, properties=properties, profileCollection=True)
    frame = r.execute_native(spec, [frames[name] for name in inputs])
    frames[id] = frame
    accumulator = ProfileAccumulator('w', frame.attrs['native_v2'])
    accumulator.add(frame)
    accumulator.finish()
    payload = accumulator.encode()
    profile = json.loads(payload)
    rows = [{name: transport(value) for name, value in row.items()} for row in frame.head(1).to_dict('records')]
    records.append(dict(spec=spec, rows=rows, profile=payload))
with tempfile.TemporaryDirectory(prefix='native-evidence-unit-') as directory:
    path = Path(directory) / 'values.csv'
    path.write_text('x\\n1\\nbad\\n""\\n', encoding='utf8')
    execute('source', 'Scan', [], files=str(path), allText=True)
    execute('typed', 'Cast', ['source'], columns=[dict(column='x', dtype='int64')], errors='null')
    execute('filled', 'Map', ['typed'], func="def apply(row):\\n    return {**row, 'x': 0 if row['x'] is None else row['x']}", entry='apply')
    execute('transformed', 'Map', ['filled'], func="def apply(row):\\n    return {**row, 'x': row['x'] * 2}", entry='apply')
    execute('derived', 'Map', ['transformed'], func="def apply(row):\\n    return {**row, 'y': row['x'] + 1}", entry='apply')
    execute('projected', 'Project', ['derived'], keep=['y'], rename={'y': 'value'})
    execute('filtered', 'Filter', ['typed'], func="def apply(row):\\n    return row['x'] is not None", entry='apply')
    execute('aggregate', 'Aggregate', ['typed'], aggregations=[dict(fn='mean', col='x', **{'as': 'mean'})])
    execute('joined', 'Join', ['typed', 'typed'], on='x', type='full', nullsEqual=True)
    execute('crossed', 'Join', ['filtered', 'typed'], type='cross')
    execute('unioned', 'Union', ['typed', 'filled'], schema='strict')
    execute('distinct', 'Distinct', ['unioned'])
    execute('sorted', 'Sort', ['unioned'], by=[dict(col='x', desc=True)])
    execute('limited', 'Limit', ['sorted'], n=1, offset=1)
    execute('empty', 'Filter', ['typed'], func='def apply(row):\\n    return False', entry='apply')
    execute('empty_groups', 'Aggregate', ['empty'], groupBy=['x'], aggregations=[dict(fn='count', **{'as': 'n'})])
    execute('empty_global', 'Aggregate', ['empty'], aggregations=[dict(fn='count', **{'as': 'n'})])
    execute('udf', 'Process', ['typed'], code='def process(typed):\\n    return typed', entry='process')
    execute('shape_source', 'Process', [], entry='load', code="def load():\\n    import pandas as pd\\n    return pd.DataFrame({'id':['a','a','a'], 'tags':[1,2,3], 'y1':[10,10,10], 'y2':[15,15,15]})")
    execute('unpivot', 'Unpivot', ['shape_source'], columns=['y1','y2'])
    execute('window', 'Window', ['unpivot'], partitionBy=['id','tags'], orderBy=[dict(col='variable')], columns=[dict(fn='lag', col='value', **{'as': 'previous'})])
    execute('pivot', 'Pivot', ['window'], index=['id','tags'], columns='variable', values='previous')
    execute('shape_empty', 'Filter', ['shape_source'], func='def apply(row):\\n    return False', entry='apply')
    execute('empty_unpivot', 'Unpivot', ['shape_empty'], columns=['y1','y2'])
    execute('empty_window', 'Window', ['empty_unpivot'], partitionBy=['id','tags'], orderBy=[dict(col='variable')], columns=[dict(fn='lag', col='value', **{'as': 'previous'})])
    execute('empty_pivot', 'Pivot', ['empty_window'], index=['id','tags'], columns='variable', values='previous')
    execute('formatted', 'Process', [], entry='load', code="def load():\\n    import pandas as pd\\n    return pd.DataFrame({'x':['1,299','1,299','$5','NA','bad','other',None,'2']})")
    execute('formatted_cast', 'Cast', ['formatted'], columns=[dict(column='x', dtype='int64')], errors='null')
    execute('long_values', 'Process', [], entry='load', code="def load():\\n    import pandas as pd\\n    return pd.DataFrame({'x':['a'*400, 'a'*96+'b'*304]})")
    execute('long_cast', 'Cast', ['long_values'], columns=[dict(column='x', dtype='int64')], errors='null')
    execute('left_keys', 'Process', [], entry='load', code="def load():\\n    import pandas as pd\\n    return pd.DataFrame({'key':['item A','shared','shared',None]})")
    execute('right_keys', 'Process', [], entry='load', code="def load():\\n    import pandas as pd\\n    return pd.DataFrame({'key':['item_A','shared','shared','shared',None]})")
    execute('key_join', 'Join', ['left_keys','right_keys'], on='key', type='full')
    execute('key_join_equal', 'Join', ['left_keys','right_keys'], on='key', type='full', nullsEqual=True)
    execute('key_result', 'Aggregate', ['key_join'], aggregations=[dict(fn='count',**{'as':'n'})])
    execute('typed_keys', 'Process', [], entry='load', code="def load():\\n    import pandas as pd\\n    return pd.DataFrame({'id':pd.Series([9007199254740993,9007199254740993,None],dtype='Int64'), 'when':pd.to_datetime(['2024-01-01','2024-01-01','2024-01-02'],utc=True)})")
    execute('empty_typed_keys', 'Filter', ['typed_keys'], func='def apply(row):\\n    return False', entry='apply')
    execute('typed_key_join', 'Join', ['typed_keys','empty_typed_keys'], on=['id','when'], type='left', nullsEqual=True)
    execute('monthly', 'Process', [], entry='load', code="def load():\\n    import pandas as pd\\n    return pd.DataFrame({'month':[1,2,3,4], 'acres':[1,2,3,4]})")
    execute('monthly_lags', 'Window', ['monthly'], orderBy=[dict(col='month')], columns=[dict(fn='lag',col='acres',**{'as':'prev1'}),dict(fn='lag',col='acres',offset=2,**{'as':'prev2'})])
    execute('monthly_projected', 'Project', ['monthly_lags'], keep=['month','prev1','prev2'])
    execute('monthly_result', 'Aggregate', ['monthly_projected'], aggregations=[dict(fn='count',**{'as':'n'})])
    disabled = dict(version='v2', id='disabled', revision='0123456789abcdef', type='Cast', inputs=['formatted'], properties=dict(columns=[dict(column='x',dtype='int64')],errors='null'))
    assert 'conversionFailureExamples' not in r.execute_native(disabled,[frames['formatted']]).attrs['native_v2']['operations']
    disabled.update(type='Join', inputs=['left_keys','right_keys'],properties=dict(on='key',type='full'))
    assert 'unmatchedExamples' not in r.execute_native(disabled,[frames['left_keys'],frames['right_keys']]).attrs['native_v2']['operations']['join']['left']
    # A display protocol that cannot represent a scalar must omit its example,
    # rather than relabel bytes as text or change a successful operation.
    assert r._witness([b'raw'],1) is None
    assert r._witness([1<<64],1) is None
    assert r._witness([float('inf')],1) is None
    import pandas as pd
    byte_frame = pd.DataFrame({'key':[b'raw',b'raw']})
    unsupported = dict(version='v2',id='unsupported',revision='0123456789abcdef',type='Cast',inputs=['input'],profileCollection=True,properties=dict(columns=[dict(column='key',dtype='int64')],errors='null'))
    metadata = r.execute_native(unsupported,[byte_frame]).attrs['native_v2']['operations']
    assert metadata['conversionFailures']['key'] == 2 and 'conversionFailureExamples' not in metadata
    unsupported.update(type='Join',inputs=['left','right'],properties=dict(on='key',type='full'))
    metadata = r.execute_native(unsupported,[byte_frame,byte_frame.iloc[:0]]).attrs['native_v2']['operations']['join']
    assert metadata['left']['unmatchedRows'] == 2 and metadata['left']['unmatchedExamples'] == []
print(json.dumps(records, default=str))
`,
      runtime,
    ],
    { env: { ...process.env, PYTHONPATH: amber } }
  );
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  const records: Array<{ spec: any; rows: any[]; profile: string }> = JSON.parse(run.stdout.toString());
  const operators: OperatorPredicate[] = records.map(({ spec: s }) => ({
    operatorID: s.id,
    operatorType: s.inputs.length ? "DataProcessing" : "DataLoading",
    operatorVersion: "1",
    operatorProperties: { code: JSON.stringify(s), workers: 1 },
    inputPorts: [...new Set(s.inputs)].map((_, i) => ({ portID: `${s.id}-in-${i}` })),
    outputPorts: [{ portID: `${s.id}-out` }],
    showAdvanced: false,
    nativeOp: {
      type: s.type,
      revision: s.revision,
      inputs: s.inputs,
      properties: s.properties,
      profileCollection: true,
    },
  }));
  const workflow: WorkflowContent = {
    operators,
    operatorPositions: {},
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
    links: operators.flatMap(op =>
      [...new Set(op.nativeOp!.inputs)].map((id, i) => ({
        linkID: `${op.operatorID}-${i}`,
        source: { operatorID: id, portID: `${id}-out` },
        target: { operatorID: op.operatorID, portID: `${op.operatorID}-in-${i}` },
      }))
    ),
  };
  const raw: Record<string, OperatorInfo> = Object.fromEntries(
    records
      .map(({ spec, rows, profile: payload }) => {
        const profile = JSON.parse(payload);
        return [
          spec.id,
          {
            state: "Completed",
            inputTuples: 0,
            outputTuples: profile.rowCount,
            resultMode: "table",
            result: rows,
            totalRowCount: profile.rowCount,
            truncated: profile.rowCount > rows.length,
            numWorkers: 1,
            resultSchema: profile.schema.map((c: any) => ({
              name: c.name,
              type: c.type,
              encoding: c.type === "int64" ? "number-or-decimal-string" : "string",
            })),
            materialization: { outputPort: 0, executionId: "500", cached: false },
            resultMetadata: { w: payload },
          },
        ];
      })
      .reverse()
  );
  const response = prepareStructuredExecutionResult(
    {
      success: true,
      state: "Completed",
      executionId: "500",
      capabilities: ["typed-scalar-v1", "schema-fields-only-v1"],
      operators: raw,
    },
    17,
    workflowExecutionPlan(workflow)
  );
  const storage = new WorkflowSnapshotStorage(
    () => ["A"],
    () => 17
  );
  storage.createSnapshot("A", workflow);
  persistOperatorResults(response.operators, (id, info) => storage.setOperatorResult("A", id, info));
  const facts = new Map<string, string>();
  for (const op of operators) {
    const info = storage.getOperatorResult("A", op.operatorID)!;
    expect(info.resultVersion?.complete).toBe(true);
    expect({
      id: op.operatorID,
      status: info.tableProfile?.status,
      omissions: info.tableProfile?.omissions,
    }).toMatchObject({ status: "available" });
    const context = { op, info, workflow, resolveInput: (id: string) => storage.getOperatorResult("A", id) };
    const collected = collectNativeEvidence(context);
    expect({
      id: op.operatorID,
      omissions: collected.omissions.filter(x => x.startsWith("invalid_") || x.endsWith("_unavailable")),
    }).toMatchObject({ omissions: op.operatorID === "long_values" ? ["row_values_unavailable"] : [] });
    facts.set(op.operatorID, collected.facts.map(f => f.text).join("\n"));
    for (const data of [true, false])
      for (const flow of [true, false]) {
        const observation = selectNativeObservation({ ...context, data, flow, maxChars: 600 });
        expect(observation.text.length).toBeLessThanOrEqual((1 + Number(data) + Number(flow)) * 600 + 2);
      }
  }
  expect(facts.get("typed")).toContain("conversion failures=1/3");
  expect(facts.get("typed")).toContain('failed-value examples (not exhaustive): "bad" × 1');
  expect(facts.get("formatted_cast")).toContain('"1,299" × 2');
  expect(facts.get("formatted_cast")).toContain('"$5" × 1');
  expect(facts.get("formatted_cast")).toContain('"NA" × 1');
  expect(facts.get("formatted_cast")).toContain("other failures=2");
  const longExamples = JSON.parse(records.find(r => r.spec.id === "long_cast")!.profile).native.operations
    .conversionFailureExamples.x.examples;
  expect(longExamples).toHaveLength(2);
  expect(longExamples.every((x: any) => x.truncated && x.values[0].value.length === 96 && x.count === 1)).toBe(true);
  expect(facts.get("key_join")).toContain('left eligible unmatched-key examples (not exhaustive): ["item A"] × 1');
  expect(facts.get("key_join")).toContain('right eligible unmatched-key examples (not exhaustive): ["item_A"] × 1');
  expect(facts.get("key_join")).toContain('left duplicate-key examples (not exhaustive): ["shared"] × 2');
  expect(facts.get("key_join")).toContain('right duplicate-key examples (not exhaustive): ["shared"] × 3');
  expect(facts.get("key_join")).not.toContain("[null] ×");
  expect(facts.get("key_result")).toContain("Flow upstream key_join:");
  expect(facts.get("key_result")).toContain('left eligible unmatched-key examples (not exhaustive): ["item A"] × 1');
  expect(facts.get("key_join_equal")).toContain("null-key rows=1");
  expect(facts.get("typed_key_join")).toContain("9007199254740993");
  expect(facts.get("typed_key_join")).toContain("[null,");
  expect(facts.get("typed_key_join")).toContain("2024-01-01T00:00:00.000000000+00:00");
  expect(facts.get("monthly_result")).toContain("Flow upstream monthly_lags:");
  expect(facts.get("monthly_result")).toContain('"prev1" boundary nulls=1/4');
  expect(facts.get("monthly_result")).toContain('"prev2" boundary nulls=2/4');
  expect(facts.get("monthly_result")).toContain('lag("acres", offset=2)');
  expect(facts.get("filled")).toContain("nulls before=2/3, after=0/3");
  expect(facts.get("filtered")).toContain("kept=1/3");
  expect(facts.get("aggregate")).toContain('"mean" nonnull=1/3');
  expect(facts.get("joined")).toContain("matched contribution=5");
  expect(facts.get("joined")).toContain("left matched rows=3/3");
  expect(facts.get("crossed")).toContain("1*3=3");
  expect(facts.get("unioned")).toContain("sum=6, output=6");
  expect(facts.get("limited")).toContain("retained=1/6, removed=5");
  expect(facts.get("empty_groups")).toContain("groups=0 from 0 rows");
  expect(facts.get("empty_global")).toContain("groups=1 from 0 rows");
  expect(facts.get("udf")).toContain("row/column mapping unknown");
  expect(facts.get("unpivot")).toContain("Unpivot output=3*2=6");
  expect(facts.get("window")).toContain("partitions=3, ties beyond first=0");
  expect(facts.get("window")).toContain('"previous" boundary nulls=3/6, total nulls=3/6');
  expect(facts.get("pivot")).toContain("Pivot unique pairs=6, index groups=3, generated columns=2, absent cells=0");
  expect(facts.get("empty_unpivot")).toContain("output=0*2=0");
  expect(facts.get("empty_window")).toContain("partitions=0");
  expect(facts.get("empty_pivot")).toContain("unique pairs=0, index groups=0, generated columns=0");
});
