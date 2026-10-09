# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Private evaluator for the small catalog-context state pilot.

State adapters explicitly map independently implemented tables to analytical
roles. Unknown mappings/observations remain unknown, never automatic failures
or passes. The same engine also scores original natural-session updates.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import gzip
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from openai import OpenAI

from state_comparison import ROOT, save
from state_oracle import (compare_state_table, classify_update, dependency_agreement,
                          annotated_closure, script_answer_references, native_answer_references)
from partial_score import compare_table, compare_scalars
from judge_longds import judge_one, load_judge_prompt

JUDGE_MODEL = 'deepseek/deepseek-v4-pro'


def actual_tables(directory, policy, observer='observer'):
    tables = {}
    if policy == 'dataflow':
        path = directory / observer / 'capture.json.gz'
        if not path.exists():
            return tables, None
        capture = json.loads(gzip.open(path, 'rt').read())
        for name, result in capture['snapshot']['results'].items():
            records = result.get('sampleRecords')
            if records is not None:
                tables[name] = {'records': records,
                                'complete': not result.get('truncated', True),
                                'rows': result.get('totalRowCount'), 'version': result.get('resultVersion'),
                                'observer_bytes': len(json.dumps(records).encode())}
        return tables, capture
    path = directory / observer / 'bindings.json'
    if not path.exists():
        return tables, None
    bindings = json.loads(path.read_text())
    for name, info in bindings.items():
        if info.get('file'):
            # Observer bundles may move after isolated-kernel cleanup. Resolve
            # within that bundle, never through a stale absolute export path.
            path = directory / observer / Path(info['file']).name
            if not path.exists():
                continue
            tables[name] = {'file': str(path), 'complete': True, 'rows': info['rows'],
                            'version': info['version'], 'observer_bytes': path.stat().st_size}
    return tables, bindings


def branch_preservation(run, directory, policy, tables, observation):
    """Changes to pre-existing tables/graph, not a claim about all hidden state.

    Native result identities can change during execution. Compare complete
    retained observations, not those identities. Operator definitions include
    incoming edges; layout and engine materialization metadata are excluded.
    """
    if (directory / 'seed-observer').exists():
        seed_parent, folder = directory, 'seed-observer'
    else:
        seed_parent, folder = run, 'seed-observer-' + directory.name
    before_tables, before = actual_tables(seed_parent, policy, folder)
    if before is None or observation is None:
        return None
    values = {'preserved': [], 'changed': [], 'deleted': [], 'unknown': []}
    for name, previous in before_tables.items():
        current = tables.get(name)
        if current is None:
            # Native absence can mean unexecuted, rather than deleted state.
            values['unknown' if policy == 'dataflow' else 'deleted'].append(name)
        elif not previous['complete'] or not current['complete']:
            values['unknown'].append(name)
        else:
            same = previous['version'] == current['version'] if policy != 'dataflow' else (
                previous['records'] == current['records'])
            values['preserved' if same else 'changed'].append(name)
    result = {'values': values, 'value_scope': 'pre-existing exported tables' if policy != 'dataflow'
              else 'pre-existing complete retained observations, including row order'}
    if policy == 'dataflow':
        def definitions(capture):
            workflow = capture['snapshot']['workflow']
            return {op['operatorID']: {'definition': op.get('nativeOp'),
                'inputs': sorted((link for link in workflow.get('links', [])
                                  if link['target']['operatorID'] == op['operatorID']),
                                 key=lambda link: json.dumps(link, sort_keys=True))}
                    for op in workflow['operators']}
        previous, current = definitions(before), definitions(observation)
        result['definitions'] = {
            'preserved': sorted(name for name in previous if previous[name] == current.get(name)),
            'changed': sorted(name for name in previous if name in current and previous[name] != current[name]),
            'deleted': sorted(set(previous) - set(current)),
            'added': sorted(set(current) - set(previous))}
    for names in values.values():
        names.sort()
    return result


def replay_elapsed(run, directory, policy):
    """Approximate setup/replay wall time from frozen artifact timestamps."""
    if policy == 'dataflow':
        start = run / ('resources-' + directory.name) / 'resource.json'
        end = run / ('seed-observer-' + directory.name) / 'capture.json.gz'
    else:
        start, end = directory / 'protocol.json', directory / 'replay-verification.json'
    return max(0, end.stat().st_mtime - start.stat().st_mtime) if start.exists() and end.exists() else None


def state_anchor(oracle, tables, spec):
    turn = oracle['turns'][spec['oracle_turn'] - 1]
    expected_info = next(f for f in turn['frames'] if f['name'] == spec['oracle_name'])
    expected = pd.read_parquet(expected_info['file'])
    base = {'adapter': spec, 'expected_digest': expected_info['digest']}
    item = tables.get(spec['actual_name'])
    if item is None:
        return {**base, 'match': None, 'coverage': 0, 'reason': 'unmapped_or_unavailable'}
    frame = pd.read_pickle(item['file']) if 'file' in item else pd.DataFrame(item['records'])
    for predicate in spec.get('where', []):
        name = predicate['column']
        if name not in frame:
            return {**base, 'match': None, 'coverage': 0, 'reason': 'missing_population_column'}
        if 'equals' in predicate:
            frame = frame.loc[frame[name].eq(predicate['equals'])]
        elif predicate.get('nonempty'):
            frame = frame.loc[frame[name].notna() & frame[name].astype(str).str.strip().ne('')]
        else:
            raise ValueError('Unknown explicit population predicate')
    needed = list(dict.fromkeys(spec['keys'] + spec['columns']))
    actual = pd.DataFrame(index=frame.index)
    for target in needed:
        sources = [source for source, destination in spec.get('rename', {}).items()
                   if destination == target and source in frame]
        if len(sources) > 1:
            raise ValueError(f'Ambiguous state adapter for {target}: {sources}')
        source = sources[0] if sources else target
        if source in frame:
            # Explicit mapping takes precedence over an unrelated historical
            # column already carrying the target name.
            actual[target] = frame[source]
    for name, mapping in spec.get('value_maps', {}).items():
        if name in actual:
            actual[name] = actual[name].map(lambda x: mapping.get(x, x))
    for name, kind in spec.get('types', {}).items():
        if name not in actual:
            continue
        if kind == 'datetime':
            actual[name] = pd.to_datetime(actual[name])
        elif kind == 'datetime_wall':
            # Explicit adapter for a question specified in local clock labels,
            # rather than instants: compare those labels without a timezone.
            values = pd.to_datetime(actual[name])
            zone = spec.get('timezones', {}).get(name)
            if zone:
                values = values.dt.tz_convert(zone)
            actual[name] = values.dt.tz_localize(None)
        elif kind == 'numeric':
            actual[name] = pd.to_numeric(actual[name])
        else:
            raise ValueError(f'Unknown explicit state-adapter type: {kind}')
    if not item['complete']:
        # A bounded observation cannot certify a complete working table.
        return {**base, 'match': None, 'coverage': 0, 'reason': 'incomplete_observation',
                'observed_rows': len(actual), 'total_rows': item['rows']}
    result = compare_state_table(expected, actual, spec['keys'], spec['columns'],
                                 atol=spec.get('atol', 1e-8), rtol=spec.get('rtol', 1e-8))
    return {**base, **result,
            'actual_version': item['version'], 'checked_columns': needed}


def answer_components(expected, text, adapter=None):
    """Deterministic components only for recognized, explicitly keyed shapes."""
    try:
        actual = json.loads(text)
    except (ValueError, TypeError):
        return {'json_valid': False, 'reference_exact': False, 'partial_score': None, 'reason': 'invalid_json'}
    result = {'json_valid': True, 'reference_exact': actual == expected}
    if adapter:
        pieces, unknown = {}, []
        for name, spec in adapter.items():
            if name not in expected:
                raise ValueError(f'Answer adapter names unknown reference component: {name}')
            found = actual
            try:
                for segment in spec['path']:
                    found = found[segment]
            except (KeyError, IndexError, TypeError):
                unknown.append(name)
                continue
            if 'keys' in spec:
                if not isinstance(found, list):
                    unknown.append(name)
                    continue
                rows = []
                for position, row in enumerate(found, 1):
                    if isinstance(row, str) and spec.get('string_key'):
                        row = {spec['string_key']: row}
                    if not isinstance(row, dict):
                        rows = None
                        break
                    row = {spec.get('rename', {}).get(k, k): v for k, v in row.items()}
                    for column, mapping in spec.get('value_maps', {}).items():
                        if column in row:
                            row[column] = mapping.get(row[column], row[column])
                    if spec.get('rank_from_order'):
                        row.setdefault(spec['rank_from_order'], position)
                    rows.append(row)
                if rows is None:
                    unknown.append(name)
                    continue
                pieces[name] = compare_table(expected[name], rows, spec['keys'], spec['value_fields'],
                    ordered=spec.get('ordered', False), decimals=4,
                    extra_fields=spec.get('extra_fields', []))
            else:
                if spec.get('transform') == 'positive_is_true':
                    found = found > 0
                pieces[name] = compare_scalars({name: expected[name]}, {name: found}, decimals=4)
        scores = [p['partial_score'] for p in pieces.values()]
        return {**result, 'partial_score': sum(scores) / len(scores) if scores else None,
                'components': pieces, 'unknown_components': unknown,
                'adapter_coverage': len(pieces) / len(adapter),
                'selected_reference_components': sorted(adapter),
                'reference_component_selection': len(adapter) / len(expected),
                'metric': 'question_selected_deterministic_components'}
    if not isinstance(expected, dict) or not isinstance(actual, dict) or not any(k in actual for k in expected):
        return {**result, 'partial_score': None, 'reason': 'unrecognized_shape'}
    pieces = {}
    for name, value in expected.items():
        if isinstance(value, list) and value and all(isinstance(r, dict) for r in value):
            keys = ['country'] if all('country' in r for r in value) else []
            supplied = actual.get(name)
            if not keys or supplied is not None and (not isinstance(supplied, list) or any(not isinstance(r, dict) for r in supplied)):
                continue
            columns = [k for k in value[0] if k not in keys]
            pieces[name] = compare_table(value, supplied, keys, columns, ordered=True, decimals=4)
        elif not isinstance(value, dict):
            pieces[name] = compare_scalars({name: value}, actual, decimals=4)
    scores = [p['partial_score'] for p in pieces.values()]
    return {**result, 'partial_score': sum(scores) / len(scores) if scores else None, 'components': pieces}


@lru_cache(maxsize=None)
def run_records(run):
    return json.loads((run / 'records.json').read_text())


def score_turn(campaign, run, directory, record, oracle, gold, adapters, answer_adapters=None):
    number = record['turn_id']
    tables, observation = actual_tables(directory, record['policy'])
    records = run_records(directory if (directory / 'records.json').exists() else run)
    if not any(r['turn_id'] == number for r in records):
        records.append(record)
    if record['policy'] == 'dataflow':
        refs = native_answer_references(observation, number) if observation else [{'kind':'read','task_id':None}]
    else:
        refs = script_answer_references(records, record)
    annotation = annotated_closure(gold['turns'], number)
    lineage = dependency_agreement(refs, annotation)
    lineage['references'] = refs
    lineage['granularity'] = 'declared answer-root operator graph' if record['policy'] == 'dataflow' else 'observed answer-binding script-block parents'
    specs = adapters.get(run.name, {}).get(str(number), [])
    anchors = [state_anchor(oracle, tables, spec) for spec in specs]
    updates = []
    for spec, current in zip(specs, anchors):
        if 'previous_oracle_turn' in spec:
            prior = state_anchor(oracle, tables, {**spec, 'oracle_turn': spec['previous_oracle_turn']})
            updates.append({'role': spec['oracle_name'], 'classification': classify_update(
                current['expected_digest'] != prior.get('expected_digest'), current['match'], prior['match']),
                'current': current, 'previous': prior})
    actions = record.get('native_actions', [])
    native_actions = [a for batch in actions for a in batch.get('actions', [])]
    scripts = record.get('scripts', [])
    structural = {'python_executions': len(scripts), 'python_execution_errors': sum(not s['success'] for s in scripts),
                  'script_chars': sum(len(s['source']) for s in scripts),
                  'largest_script_chars': max((len(s['source']) for s in scripts), default=0),
                  'script_retrievals': len(record.get('inspections', [])),
                  'native_execution_actions_requested': sum(a['type'] == 'execute' for a in native_actions),
                  'native_retrieval_actions_requested': sum(a['type'] == 'retrieve' for a in native_actions),
                  'native_task_inspections': sum(a['type'] == 'inspect' and a.get('target') == 'task' for a in native_actions),
                  'native_historical_result_reads_requested': sum(a['type'] == 'inspect' and a.get('view') is not None
                      and a.get('target') in {'task', 'state'} for a in native_actions),
                  'native_fork_commands_requested': sum(line.strip().startswith('fork operator ')
                      for a in native_actions if a['type'] == 'edit' for line in a['changes'].splitlines()),
                  'native_edit_chars': sum(len(a.get('changes', '')) for a in native_actions if a['type'] == 'edit'),
                  'observation_available': observation is not None,
                  'retained_table_count': len(tables) if observation is not None else None,
                  'observer_table_bytes': sum(t['observer_bytes'] for t in tables.values()) if observation is not None else None}
    if record['policy'] == 'dataflow' and observation:
        structural['operator_count'] = len(observation['snapshot']['workflow']['operators'])
        structural['cloned_operator_count'] = sum(bool(o.get('stateOrigin')) for o in observation['snapshot']['workflow']['operators'])
        trace_path = directory / 'react_steps.json.gz'
        if trace_path.exists():
            trace = json.loads(gzip.open(trace_path, 'rt').read())['steps']
            receipts = [result for step in trace for result in step.get('toolResults', [])]
            completed_actions = [action['action']['type'] for result in receipts
                                 for action in result.get('output', {}).get('actions', [])
                                 if action['status'] == 'ok']
            structural['native_execution_actions_completed'] = completed_actions.count('execute')
            structural['native_tool_error_calls'] = sum(result.get('isError', False) for result in receipts)
    preservation = branch_preservation(run, directory, record['policy'], tables, observation)
    judge_path = directory / 'judge.json'
    verdict = json.loads(judge_path.read_text()) if judge_path.exists() else None
    return {'run': run.name, 'turn_id': number, 'model': record['model'], 'policy': record['policy'],
            'completed': record['completed'], 'stats': record['stats'], 'judge': verdict,
            'answer': answer_components(gold['turns'][number - 1]['answer'], record['answer'],
                (answer_adapters or {}).get(run.name, {}).get(str(number))),
            'state_anchors': anchors, 'state_anchor_coverage': sum(a['coverage'] for a in anchors) / len(anchors) if anchors else None,
            'updates': updates, 'lineage': lineage, 'structure': structural,
            'branch_preservation': preservation,
            'replay_elapsed_seconds_approx': replay_elapsed(run, directory, record['policy'])}


def judge_record(campaign, directory, record, gold, prompt):
    destination = directory / 'judge.json'
    if destination.exists():
        return json.loads(destination.read_text())
    expected = gold['turns'][record['turn_id'] - 1]
    row = {'context': expected['context'], 'question': expected['question'],
           'ground_truth': expected['answer'], 'solution': record['answer']}
    key = hashlib.sha256(json.dumps([JUDGE_MODEL, prompt, row], sort_keys=True).encode()).hexdigest()
    cache = campaign / 'judge-cache'; cache.mkdir(exist_ok=True)
    target = cache / (key + '.json')
    if target.exists():
        result = json.loads(target.read_text())
        save(destination, {**result, 'cache_reused': True})
        return result
    intent = cache / (key + '.started.json')
    with intent.open('x') as out:
        json.dump({'model': JUDGE_MODEL, 'prompt_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
                   'record_sha256': hashlib.sha256((directory / 'record.json').read_bytes()).hexdigest()}, out)
    client = OpenAI(base_url='https://openrouter.ai/api/v1', api_key=os.environ['OPENROUTER_API_KEY'],
                    max_retries=0, timeout=180)
    result = judge_one(client, JUDGE_MODEL, prompt, row, retries=1, max_tokens=8192)
    save(target, result)
    save(destination, {**result, 'cache_reused': False})
    return result


def main():
    load_dotenv(ROOT / '.env', override=False)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('campaign', type=Path)
    ap.add_argument('--adapters', type=Path)
    ap.add_argument('--answer-adapters', type=Path)
    ap.add_argument('--judge', action='store_true')
    ap.add_argument('--prefix-only', action='store_true')
    args = ap.parse_args()
    root = args.campaign.resolve()
    oracle = json.loads((root / 'private-oracle/manifest.json').read_text())
    gold = json.loads((root / 'prepared/business__netflix_movies_and_tv_shows__task3/gold.json').read_text())
    adapters = json.loads(args.adapters.read_text()) if args.adapters else {}
    answer_adapters = json.loads(args.answer_adapters.read_text()) if args.answer_adapters else {}
    paths = sorted(root.glob('prefix-*/t*/record.json'))
    if not args.prefix_only:
        paths += sorted(root.glob('probes-*/t*/record.json'))
    jobs = [(p.parent.parent, p.parent, json.loads(p.read_text())) for p in paths]
    if args.judge:
        prompt = load_judge_prompt()
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda job: judge_record(root, job[1], job[2], gold, prompt), jobs))
    rows = [score_turn(root, run, directory, record, oracle, gold, adapters, answer_adapters)
            for run, directory, record in jobs]
    save(root / 'state-metrics.json', rows)
    for run in sorted({r['run'] for r in rows}):
        selected = [r for r in rows if r['run'] == run]
        judged = [r for r in selected if r['judge'] and r['judge'].get('score') is not None]
        print(json.dumps({'run': run, 'observed': len(selected), 'judged': len(judged),
                          'correct': sum(r['judge']['score'] == 1 for r in judged),
                          'completed': sum(r['completed'] for r in selected),
                          'cost_usd': sum(r['stats']['cost_usd'] or 0 for r in selected)}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
