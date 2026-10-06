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

"""Private oracle, one-attempt upstream judging and trace metrics for Lite.

Oracle tables never enter a solver manifest, kernel, graph or message. Explicit
table/column adapters are an audit artifact; unmapped state remains unknown.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import statistics

from dotenv import load_dotenv
from openai import OpenAI
import pandas as pd

from _paths import DATAMIND
from context_state_pilot import job_key
from judge_longds import judge_one, load_judge_prompt
from numeric_gate import AutoImportNS, PRELUDE, TURN_MARKER, reference_source, json_blobs, diff
from state_comparison import ROOT, cost_of, digest, save
from state_oracle import annotated_closure, dependency_agreement, native_answer_references, script_answer_references
from state_pilot_score import state_anchor, answer_components

JUDGE_RATES = {'gpt-5.2': {'input': 1.75, 'cached': .175, 'write': 1.75, 'output': 14.}}


def judge_client():
    """The judge endpoint is chosen by environment, like judge_longds.py."""
    return OpenAI(base_url=os.environ.get('JUDGE_BASE_URL', 'http://localhost:4000/v1'),
                  api_key=os.environ.get('JUDGE_API_KEY') or os.environ['LITELLM_MASTER_KEY'],
                  max_retries=0, timeout=300)


def build_oracles(root):
    directory = root / 'private-oracle'
    directory.mkdir(exist_ok=False)
    protocol = json.loads((root / 'pilot' / 'protocol.json').read_text())
    for task, spec in protocol['cases'].items():
        taskdir = DATAMIND / 'task/longds_v1.1' / task
        source = reference_source(taskdir).replace('../../../../../data/longds', str(ROOT / 'data/longds'))
        marks = list(TURN_MARKER.finditer(source))
        namespace = AutoImportNS(__name__='__private_oracle__')
        with redirect_stdout(io.StringIO()):
            exec(compile(PRELUDE + source[:marks[0].start()], 'oracle-setup', 'exec'), namespace)
        gold = json.loads((root / 'prepared' / task.replace('/', '__') / 'gold.json').read_text())
        turns = []
        target = directory / task.replace('/', '__')
        for index, mark in enumerate(marks[:spec['turns']]):
            code = source[mark.start():marks[index+1].start() if index+1 < len(marks) else len(source)]
            output = io.StringIO()
            with redirect_stdout(output):
                exec(compile(code, f'oracle-turn-{index+1}', 'exec'), namespace)
            blobs = json_blobs(output.getvalue())
            if not blobs or list(diff(gold['turns'][index]['answer'], blobs[-1])):
                raise RuntimeError(f'Reference numeric gate failed: {task} Q{index+1}')
            frames = []
            for name, value in namespace.items():
                if isinstance(value, pd.DataFrame):
                    path = target / f't{index+1:02d}' / (name + '.parquet')
                    path.parent.mkdir(parents=True, exist_ok=True)
                    value.to_parquet(path, index=False)
                    frames.append({'name': name, 'file': str(path), 'digest': digest(path),
                                   'rows': len(value), 'columns': list(value.columns)})
            turns.append({'turn_id': index+1, 'reference_gate': 'pass', 'frames': frames})
        save(target / 'manifest.json', {'task': task, 'source_sha256': hashlib.sha256(source.encode()).hexdigest(),
                                        'turns': turns, 'visibility': 'evaluator only'})
        print(f'ORACLE_PASS {task} Q1–Q{spec["turns"]}', flush=True)


def judge_record(folder, directory, record, gold, protocol, prompt):
    destination = directory / 'judge.json'
    if destination.exists():
        return json.loads(destination.read_text())
    expected = gold['turns'][record['turn_id']-1]
    turn = {'context': expected['context'], 'question': expected['question'],
            'ground_truth': expected['answer'], 'solution': record['answer']}
    model = protocol['judge']['model']
    key = hashlib.sha256(json.dumps([model, prompt, turn], sort_keys=True).encode()).hexdigest()
    cache = folder / 'judge-cache'
    cache.mkdir(exist_ok=True)
    target = cache / (key + '.json')
    if target.exists():
        result = json.loads(target.read_text())
        save(destination, {**result, 'cache_reused': True})
        return result
    try:
        with (cache / (key + '.started.json')).open('x') as out:
            json.dump({'record_sha256': digest(directory / 'record.json')}, out)
    except FileExistsError:
        # A duplicate may be in flight, but a crash is never resubmitted.
        return {'score': None, 'error_detail': 'Judge intent exists; wait for cache result without resubmission'}
    result = judge_one(judge_client(), model, prompt, turn, retries=1, max_tokens=8192)
    amount = 0. if model in JUDGE_RATES else None
    for usage in result.get('usage', []) if amount is not None else []:
        details = usage.get('prompt_tokens_details') or {}
        stats = {'input_tokens': usage.get('prompt_tokens'), 'output_tokens': usage.get('completion_tokens'),
                 'cached_tokens': details.get('cached_tokens', 0), 'cache_write_tokens': 0}
        cost = cost_of(stats, JUDGE_RATES[model])
        if cost is None:
            amount = None
            break
        amount += cost
    result['cost_usd'] = amount
    save(target, result)
    save(destination, {**result, 'cache_reused': False})
    return result


def load_tables(directory, agent):
    tables = {}
    if agent == 'dataflow':
        capture = json.loads(gzip.open(directory / 'observer/capture.json.gz', 'rt').read())
        for name, item in capture.get('observerTables', {}).items():
            tables[name] = {'records': item.get('rows', []), 'complete': item['complete'],
                            'rows': item.get('totalRows'), 'version': item.get('version')}
        return tables, capture
    bindings = json.loads((directory / 'observer/bindings.json').read_text())
    for name, item in bindings.items():
        if item.get('file'):
            tables[name] = {'file': str(directory / 'observer' / Path(item['file']).name),
                            'complete': True, 'rows': item['rows'], 'version': item['version']}
    return tables, bindings


def structural_metrics(record, directory, agent):
    if agent == 'python':
        scripts = record.get('scripts', [])
        overwritten = [name for s in scripts for name, b in s.get('written_bindings', {}).items()
                       if any(p['name'] == name and p.get('task_id', record['turn_id']) < record['turn_id']
                              for p in b.get('parents', []))]
        return {'executions': len(scripts), 'execution_errors': sum(not s['success'] for s in scripts),
                'script_retrievals': len(record.get('inspections', [])), 'overwritten_read_bindings': overwritten,
                'largest_code_chars': max((len(s['source']) for s in scripts), default=0)}
    batches = record.get('native_actions', [])
    actions = [a for batch in batches for a in batch.get('actions', [])]
    saved_reads = [op for a in actions if a['type'] == 'read' and a.get('view') is not None
                   for op in a['operator_ids'] if '@' in op]
    saved_answer_sources = [op for a in actions if a['type'] == 'answer'
                            for op in (a.get('operator_ids') or []) + re.findall(r'\b([A-Za-z_]\w*@\d+)', a.get('from', ''))
                            if '@' in op]
    changes = '\n'.join(a.get('changes', '') for a in actions if a['type'] == 'edit')
    trace = json.loads(gzip.open(directory / 'react_steps.json.gz', 'rt').read())['steps']
    counts = {'executed': 0, 'cached': 0}
    historical_cached, completed_saved_reads, failed_actions = [], [], 0
    tool_errors, retention_warnings, unavailable_results, legacy_rejections = 0, 0, 0, 0
    for step in trace:
        for receipt in step.get('toolResults', []):
            output = receipt.get('output')
            tool_errors += bool(receipt.get('isError') or isinstance(output, dict) and output.get('status') == 'error')
            text = json.dumps(output) if output is not None else ''
            retention_warnings += text.count('RETENTION_')
            unavailable_results += text.count('HISTORICAL_RESULT_UNAVAILABLE')
            legacy_rejections += text.count('Forks are not available') + text.count('to make the definition saved at the end of task')
            if not isinstance(output, dict):
                continue
            for action in output.get('actions', []):
                failed_actions += action.get('status') == 'error'
                requested = action.get('action', {})
                if requested.get('type') == 'read' and requested.get('view') is not None and action.get('status') == 'ok':
                    completed_saved_reads.extend(op for op in requested.get('operator_ids', []) if '@' in op)
                if action.get('action', {}).get('type') != 'execute':
                    continue
                result = action.get('output') or {}
                if not isinstance(result, dict):
                    continue
                for outcome in result.get('operators', []):
                    if outcome.get('status') == 'ok' and outcome.get('state') in counts:
                        counts[outcome['state']] += 1
                        if outcome['state'] == 'cached' and '@' in outcome['id']:
                            historical_cached.append(outcome['id'])
    return {'execution_actions': sum(a['type'] == 'execute' for a in actions),
            'read_actions': sum(a['type'] == 'read' for a in actions), 'saved_reads_requested': saved_reads,
            'saved_edges_requested': re.findall(r'create edge ([^\s]+@\d+)\.out', changes),
            'definition_variants_requested': re.findall(r'create operator (\S+) from (\S+@\d+)', changes),
            'definition_updates_requested': re.findall(r'update operator (\S+) from (\S+@\d+)', changes),
            'saved_answer_sources': saved_answer_sources,
            'operator_outcomes': counts, 'tool_error_calls': tool_errors,
            'failed_actions': failed_actions, 'completed_saved_reads': completed_saved_reads,
            'historical_cached_inputs': historical_cached,
            'retention_warnings': retention_warnings, 'unavailable_results': unavailable_results,
            'legacy_command_rejections': legacy_rejections,
            'largest_code_chars': max((len(a.get('changes', '')) for a in actions), default=0)}


def evaluate(root, adapters=None, judge=True):
    folder = root / 'pilot'
    protocol = json.loads((folder / 'protocol.json').read_text())
    prompt = load_judge_prompt()
    audit = json.loads(adapters.read_text()) if adapters else {}
    items = []
    for job in protocol['jobs']:
        run = folder / 'runs' / job_key(job)
        records = json.loads((run / 'records.json').read_text()) if (run / 'records.json').exists() else []
        gold = json.loads((Path(protocol['cases'][job['task']]['prepared']) / 'gold.json').read_text())
        for record in records:
            items.append((job, run, run / f"t{record['turn_id']:02d}", record, records, gold))
    if judge:
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda item: judge_record(folder, item[2], item[3], item[5], protocol, prompt), items))
    # Resolve completed duplicate intents after the in-flight call has finished.
    for job, run, directory, record, _, gold in items:
        if judge and not (directory / 'judge.json').exists():
            judge_record(folder, directory, record, gold, protocol, prompt)
    rows = []
    for job, run, directory, record, records, gold in items:
        number = record['turn_id']
        tables, observation = load_tables(directory, job['agent'])
        references = (native_answer_references(observation, number) if job['agent'] == 'dataflow'
                      else script_answer_references(records, record))
        lineage = dependency_agreement(references, annotated_closure(gold['turns'], number))
        lineage['references'] = references
        definitions = None
        if job['agent'] == 'dataflow':
            definition_refs = [{**r, 'task_id': r.get('definition_task', r.get('task_id'))} for r in references]
            definitions = dependency_agreement(definition_refs, annotated_closure(gold['turns'], number))
            definitions['granularity'] = 'declared graph closure, definition-introducing tasks; checkpoint reads reported separately'
        specs = audit.get(run.name, {}).get(str(number), [])
        oracle = json.loads((root / 'private-oracle' / job['task'].replace('/', '__') / 'manifest.json').read_text())
        anchors = [state_anchor(oracle, tables, spec) for spec in specs]
        verdict = json.loads((directory / 'judge.json').read_text()) if (directory / 'judge.json').exists() else {}
        rows.append({**job, 'run': run.name, 'turn_id': number, 'completed': record['completed'],
                     'stats': record['stats'], 'judge': verdict,
                     'answer_components': answer_components(gold['turns'][number-1]['answer'], record['answer']),
                     'state_anchors': anchors, 'state_anchor_coverage': sum(a['coverage'] for a in anchors)/len(anchors) if anchors else None,
                     'lineage': lineage, 'definition_lineage': definitions,
                     'structure': structural_metrics(record, directory, job['agent']),
                     'exported_tables': len(tables), 'state_types': gold['turns'][number-1].get('state_type', []),
                     'artifact': str(directory)})
    save(folder / 'metrics.json', rows)
    summaries = []
    labels = ('Initial', 'Update', 'Rollback', 'Counterfactual')
    for model in protocol['models']:
        for agent in protocol['agents']:
            for context in protocol['contexts']:
                selected = [r for r in rows if (r['model'], r['agent'], r['context']) == (model, agent, context)]
                judged = [r for r in selected if r['judge'].get('score') is not None]
                expected = sum(c['turns'] for c in protocol['cases'].values())
                structure = [r['structure'] for r in selected if r['agent'] == 'dataflow']
                saved_uses = {key: sum(len(s.get(key, [])) for s in structure) for key in
                              ('saved_reads_requested', 'saved_edges_requested', 'definition_variants_requested',
                               'definition_updates_requested', 'saved_answer_sources', 'completed_saved_reads')}
                summaries.append({'model': model, 'agent': agent, 'context': context,
                    'expected': expected, 'attempted': len(selected), 'judged': len(judged),
                    'correct': sum(r['judge']['score'] == 1 for r in judged),
                    'accuracy': statistics.mean(r['judge']['score'] for r in judged) if len(judged) == expected else None,
                    'by_label': {label: {'judged': sum(label in r['state_types'] for r in judged),
                                         'correct': sum(label in r['state_types'] and r['judge']['score'] == 1 for r in judged)}
                                 for label in labels},
                    'turns_with_saved_reference': sum(bool(s.get('saved_reads_requested') or s.get('saved_edges_requested')
                                                           or s.get('definition_variants_requested') or s.get('definition_updates_requested')
                                                           or s.get('saved_answer_sources')) for s in structure),
                    'saved_version_uses': saved_uses,
                    'retention_warnings': sum(s.get('retention_warnings', 0) for s in structure),
                    'unavailable_results': sum(s.get('unavailable_results', 0) for s in structure),
                    'legacy_command_rejections': sum(s.get('legacy_command_rejections', 0) for s in structure),
                    'incomplete_turns': sum(not r['completed'] for r in selected),
                    'cost_usd': sum(r['stats']['cost_usd'] or 0 for r in selected),
                    'llm_calls': sum(r['stats']['llm_calls'] for r in selected),
                    'input_tokens': sum(r['stats']['input_tokens'] or 0 for r in selected),
                    'cached_tokens': sum(r['stats']['cached_tokens'] or 0 for r in selected),
                    'output_tokens': sum(r['stats']['output_tokens'] or 0 for r in selected),
                    'elapsed_seconds': sum(r['stats']['elapsed_seconds'] for r in selected)})
    verdicts = [json.loads(p.read_text()) for p in (folder / 'judge-cache').glob('*.json')
                if not p.name.endswith('.started.json')] if (folder / 'judge-cache').exists() else []
    judge_cost = sum(v.get('cost_usd') or 0 for v in verdicts)
    save(folder / 'summary.json', {'arms': summaries, 'judge_cost_usd': judge_cost,
                                 'judge_cost_estimated': all(v.get('cost_usd') is not None for v in verdicts),
                                 'judge_model': protocol['judge']['model'],
                                 'solver_cost_usd': sum(a['cost_usd'] for a in summaries)})
    for row in summaries:
        print(json.dumps(row), flush=True)


if __name__ == '__main__':
    load_dotenv(ROOT / '.env', override=False)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['oracle', 'evaluate'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--adapters', type=Path)
    parser.add_argument('--no-judge', action='store_true')
    args = parser.parse_args()
    if args.action == 'oracle':
        build_oracles(args.root.resolve())
    else:
        evaluate(args.root.resolve(), args.adapters, not args.no_judge)
