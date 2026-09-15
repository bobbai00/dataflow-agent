# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Score every completed artifact directory and retain run-level comparisons."""
import json
import sys
from pathlib import Path
from study import score

root = Path(sys.argv[1])
rows = []
for run in sorted((root / 'runs').iterdir()):
    if not (run / 'config.json').exists():
        continue
    config = json.loads((run / 'config.json').read_text())
    seed = config['session']['seed']
    score(root / f'seed{seed}', run)
    summary = json.loads((run / 'summary.json').read_text())
    items = summary['results']
    inp, out, cached = [sum(t.get(k, 0) for t in items) for k in ['input_tokens', 'output_tokens', 'cached_tokens']]
    row = dict(run=run.name, arm=config['arm'], seed=seed, turns=summary['turns'], passed=summary['passed'],
               cost_usd=summary['cost_usd'], llm_calls=summary['llm_calls'], input_tokens=inp,
               output_tokens=out, cached_tokens=cached, cache_fraction=cached/inp if inp else 0,
               cost_without_input_cache_usd=(inp*.2+out*1.2)/1e6,
               reuse_calls=sum(t.get('reuse_calls', 0) for t in items),
               elapsed_seconds=sum(t.get('elapsed_seconds', 0) for t in items))
    rows.append(row)
(root / 'comparison.json').write_text(json.dumps(rows, indent=2))
lines = ['| Run | Correct | Model calls | Reuse calls | Cost | Input cached | No input-cache cost |',
         '|---|---:|---:|---:|---:|---:|---:|']
for r in rows:
    lines.append(f"| {r['run']} | {r['passed']}/{r['turns']} | {r['llm_calls']} | {r['reuse_calls']} | ${r['cost_usd']:.6f} | {r['cache_fraction']:.1%} | ${r['cost_without_input_cache_usd']:.6f} |")
(root / 'comparison.md').write_text('\n'.join(lines)+'\n')
print(root / 'comparison.md')
