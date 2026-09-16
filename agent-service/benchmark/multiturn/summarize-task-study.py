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
"""Summarize recorded sessions without choosing retries or invoking a judge.

Inputs are coordinator manifests (or an individual scored session directory).
Use primary runs for comparison; recoveries remain a separate sensitivity check.
"""
import argparse
import json
import math
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def family_name(path):
    spec = read(path / 'config.json')['session']
    return spec.get('family') or Path(spec['files'][0]).parent.name


def sessions(path):
    if path.is_dir():
        return [(path, read(path / 'summary.json'))], []
    manifest = read(path)
    return tuple(
        [(path.parent / row['label'], read(path.parent / row['label'] / 'summary.json'))
         for row in manifest[group]]
        for group in ['primary', 'recoveries']
    )


def summarize(entries):
    rows = []
    for path, summary in entries:
        assert summary['completed'] == summary['tasks'], f'Incomplete session: {path}'
        tasks = summary['results']
        assert len(tasks) == summary['tasks']
        sums = {key: sum(task.get(key, 0) for task in tasks) for key in [
            'input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_tokens',
            'llm_calls', 'cost_usd', 'elapsed_seconds', 'historical_inputs', 'direct_returns',
        ]}
        sums['uncached_tokens'] = sums['input_tokens'] - sums['cached_tokens']
        sums['uncached_input_usd'] = sums['uncached_tokens'] * 0.20 / 1e6
        sums['cached_input_usd'] = sums['cached_tokens'] * 0.02 / 1e6
        sums['output_usd'] = sums['output_tokens'] * 1.20 / 1e6
        assert math.isclose(sums['cost_usd'], summary['cost_usd'], abs_tol=1e-10)
        assert math.isclose(sums['cost_usd'], sum(sums[k] for k in [
            'uncached_input_usd', 'cached_input_usd', 'output_usd']), abs_tol=1e-10)
        answer_errors = []
        for task in tasks:
            answer = read(path / f"t{task['task']:02}" / 'answer.json')
            text = str(answer.get('answer', ''))
            if answer.get('error') or text.startswith('Error:'):
                answer_errors.append(dict(task=task['task'], error=answer.get('error') or text))
        rows.append(dict(
            artifact=f'{path.parent.name}/{path.name}',
            family=family_name(path),
            tasks=summary['tasks'], passed=summary['passed'],
            failed_tasks=[t['task'] for t in tasks if not t['passed']],
            answer_errors=answer_errors,
            **sums,
        ))
    keys = ['tasks', 'passed', 'input_tokens', 'cached_tokens', 'uncached_tokens',
            'output_tokens', 'reasoning_tokens', 'llm_calls', 'cost_usd',
            'uncached_input_usd', 'cached_input_usd', 'output_usd', 'elapsed_seconds',
            'historical_inputs', 'direct_returns']
    return dict(sessions=rows, totals={key: sum(row[key] for row in rows) for key in keys})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code', type=Path, required=True)
    parser.add_argument('--dataflow', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    c, cr = sessions(args.code)
    d, dr = sessions(args.dataflow)
    result = dict(
        cost_basis='Recorded token usage, repository Luna accounting rates; excludes infrastructure. '
                   'Calls without returned usage may be missing, so failures can make costs lower bounds.',
        rates_usd_per_million=dict(uncached_input=0.20, cached_input=0.02, output=1.20),
        code=dict(primary=summarize(c), recoveries=summarize(cr)),
        dataflow=dict(primary=summarize(d), recoveries=summarize(dr)),
    )
    by_family = lambda entries: {family_name(path): (path, summary)
                                 for path, summary in entries}
    cm, dm = by_family(c), by_family(d)
    assert set(cm) == set(dm), (list(cm), list(dm))
    pairs = []
    for family in sorted(cm):
        cp, cs = cm[family]
        dp, ds = dm[family]
        assert cs['tasks'] == ds['tasks']
        for ct, dt in zip(cs['results'], ds['results']):
            assert ct['task'] == dt['task']
            task = ct['task']
            assert read(cp / f't{task:02}' / 'prompt.json')['prompt'] == read(
                dp / f't{task:02}' / 'prompt.json')['prompt'], (family, task, 'prompt mismatch')
            if ct['passed'] and dt['passed']:
                category = 'both_pass_code_cheaper' if ct['cost_usd'] < dt['cost_usd'] else 'both_pass_dataflow_cheaper'
            elif ct['passed']:
                category = 'code_only'
            elif dt['passed']:
                category = 'dataflow_only'
            else:
                category = 'both_fail'
            pairs.append(dict(family=family, task=task, category=category,
                              code_cost_usd=ct['cost_usd'], dataflow_cost_usd=dt['cost_usd']))
    result['pairs'] = pairs
    result['categories'] = {category: sum(p['category'] == category for p in pairs)
                            for category in sorted({p['category'] for p in pairs})}
    result['dataflow_cost_ratio'] = result['dataflow']['primary']['totals']['cost_usd'] / result['code']['primary']['totals']['cost_usd']
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['categories', 'dataflow_cost_ratio']}))


if __name__ == '__main__':
    main()
