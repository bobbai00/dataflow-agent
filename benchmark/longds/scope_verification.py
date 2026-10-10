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
"""Freeze the ordinary-ReAct scope pilot; reuse the native runner and official evaluators."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from state_comparison import ROOT, HERE, MODEL, RATES, COMMON_SETTINGS, digest, save, make_jobs
from comparison_iteration import COHORT

KB = ROOT / 'benchmark/Kramabench'
KB_TASKS = ['environment-easy-1', 'environment-easy-2', 'biomedical-easy-2',
            'biomedical-hard-1', 'wildfire-easy-1', 'legal-easy-3',
            'archeology-hard-2', 'astronomy-easy-1']
CHANGES = {
    'agent-service/src/agent/native/action-observations.ts',
    'agent-service/src/agent/native/observation-format.ts',
    'agent-service/src/agent/native/result-scope.ts',
    'agent-service/src/agent/tools/dataflow-action-runtime.ts',
    'agent-service/src/agent/util/context-utils.ts',
    'agent-service/src/agent/prompts/native-flow-statistics.md',
    'agent-service/src/agent/prompts/native-mode.md',
    'agent-service/src/agent/prompts/native-example-tasks.md',
    'agent-service/src/agent/prompts/native-multi-task.md',
}


def settings(benchmark):
    if benchmark not in ['krama', 'longds']:
        raise ValueError('Unknown benchmark')
    return {**COMMON_SETTINGS, 'dataEvidence': False, 'flowEvidence': False,
            'retrievalViews': ['sample', 'full'], 'stateLedger': False,
            'multiTask': benchmark == 'longds', 'stateHistory': benchmark == 'longds'}


def source_hashes(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted((root / 'agent-service/src').rglob('*'))
            if p.is_file() and p.suffix in ['.ts', '.py', '.md'] and not p.name.endswith('.test.ts')}


def compare_sources(before, after):
    a, b = source_hashes(before), source_hashes(after)
    differences = sorted(k for k in a.keys() | b.keys() if a.get(k) != b.get(k))
    unrelated = set(differences) - CHANGES
    if unrelated:
        raise ValueError(f'Unrelated runtime differences: {sorted(unrelated)}')
    return {'before': a, 'after': b, 'differences': differences}


def canonical_score(answer_type, evaluation):
    metric = {'numeric_exact': 'success', 'string_exact': 'success',
              'numeric_approximate': 'rae_score', 'list_exact': 'f1'}[answer_type]
    value = evaluation.get(metric)
    return None if value is None else int(value >= 1.0)


def kb_imports():
    if str(KB) not in sys.path:
        sys.path.insert(0, str(KB))
    from systems.dataflow_system import DataflowSystem
    from benchmark.benchmark import Evaluator
    from utils.answer_parser import parse_answer
    return DataflowSystem, Evaluator, parse_answer


def prepare_krama(output, task_id):
    interpreter = KB / '.venv/bin/python'
    if Path(sys.executable).resolve() != interpreter.resolve():
        result = subprocess.check_output([str(interpreter), str(Path(__file__).resolve()),
                                         'prepare-krama', str(output), task_id], cwd=ROOT, text=True)
        return result.strip().splitlines()[-1]
    DataflowSystem, _, _ = kb_imports()
    workload = task_id.split('-')[0]
    matches = [t for t in json.loads((KB / f'workload/{workload}.json').read_text()) if t['id'] == task_id]
    if len(matches) != 1:
        raise ValueError(f'Unknown or ambiguous task: {task_id}')
    task = matches[0]
    system = DataflowSystem(name='ScopePreparation')
    system._prepare_dataset(str(KB / f'data/{workload}/input'))
    expanded = system._expand_data_sources(task['data_sources'])
    files = sorted(str(Path(os.path.abspath(p)).relative_to(KB)) for p in expanded)
    if not files or any(not (ROOT / p).is_file() for p in files):
        raise ValueError(f'Missing exact input file for {task_id}')
    key = f'krama/{task_id}/task1'
    folder = output / 'prepared' / key.replace('/', '__')
    prompt = system._build_prompt(task['query'], files, system.format_hints.get(task_id, ''))
    manifest = {'key': key, 'benchmark': 'krama', 'task_id': task_id, 'workload': workload,
                'files': files, 'turns': [{'turn_id': 1, 'context': '', 'question': task['query']}]}
    save(folder / 'manifest.json', manifest)
    save(folder / 'prompts.json', [{'turn_id': 1, 'prompt': prompt}])
    save(folder / 'gold.json', {'key': key, 'task': task,
         'turns': [{'turn_id': 1, 'answer': task['answer'], 'state_type': ['SingleTask'],
                    'depends_tasks': [], 'depends_span': []}]})
    return key


def score_krama(protocol, prepared, output, rows):
    interpreter = KB / '.venv/bin/python'
    if Path(sys.executable).resolve() != interpreter.resolve():
        with (output / 'metric-runner.log').open('x') as stream:
            subprocess.run([str(interpreter), str(Path(__file__).resolve()), 'score-krama',
                            str(prepared), str(output)], cwd=ROOT, check=True,
                           stdout=stream, stderr=subprocess.STDOUT)
        return json.loads((output / 'results_eval.json').read_text())
    _, Evaluator, parse_answer = kb_imports()
    manifest = json.loads((prepared / 'manifest.json').read_text())
    task = json.loads((prepared / 'gold.json').read_text())['task']
    evaluator = Evaluator(str(KB / f"workload/{manifest['workload']}.json"),
                          str(KB / 'benchmark/fixtures'), str(output),
                          evaluate_pipeline=False, task_id_filter=[task['id']])
    judged = []
    for row in rows:
        parsed = parse_answer(row['solution'])
        response = {'task_id': task['id'], 'model_output': {'id': 'main-task', 'answer': parsed}, 'code': ''}
        evaluation = evaluator._evaluate_result_for_task(response, task, evaluate_pipeline=False)[0]
        save(output / 't01/evaluation.json', evaluation)
        judged.append({**row, 'judge': {'score': canonical_score(task['answer_type'], evaluation),
             'source': 'KramaBench official evaluator', 'answer_type': task['answer_type'],
             'policy': 'Full pass >=1.0; raw official partial metrics retained separately',
             'evaluation': evaluation}})
    save(output / 'results_eval.json', judged)
    return judged


def freeze(args):
    output = args.output.resolve()
    if (output / 'protocol.json').exists():
        raise FileExistsError('Study is already frozen')
    if args.reps < 1:
        raise ValueError('Positive repetition count required')
    conditions = {'before': args.before.resolve(), 'after': args.after.resolve()}
    compared = compare_sources(**conditions)
    save(output / 'source-comparison.json', compared)
    gates = {r['task']: r for r in json.loads((args.previous / 'gates-engine.json').read_text())}
    for task in COHORT:
        if gates.get(task, {}).get('exit_code') != 0:
            raise ValueError(f'Reference preflight failed: {task}')
        source = args.previous / 'prepared' / task.replace('/', '__')
        target = output / 'prepared' / task.replace('/', '__')
        if target.exists():
            if any(digest(target / name) != digest(source / name) for name in ['manifest.json', 'gold.json', 'prompts.json']):
                raise ValueError(f'Prepared inputs changed before freezing: {task}')
        else:
            shutil.copytree(source, target)
    krama_tasks = [prepare_krama(output, task) for task in KB_TASKS]
    files = {name for task in [*COHORT, *krama_tasks]
             for name in json.loads((output / 'prepared' / task.replace('/', '__') / 'manifest.json').read_text())['files']}
    inputs = {name: {'bytes': (ROOT / name).stat().st_size, 'mtime_ns': (ROOT / name).stat().st_mtime_ns,
                     'sha256': digest(ROOT / name)} for name in sorted(files)}
    harness = [HERE / name for name in ['state_comparison.py', 'comparison_campaign.py', 'comparison_job.py',
               'comparison_report.py', 'comparison_adjudicate.py', 'scope_verification.py',
               'judge_longds.py', 'numeric_gate.py']]
    harness += [ROOT / 'agent-service/benchmark/multiturn/run-comparison-session.ts']
    harness += list((KB / 'benchmark').rglob('*.py'))
    harness += [KB / 'utils/answer_parser.py', KB / 'systems/dataflow_system.py',
                KB / 'systems/data_source_utils.py']
    harness += list((KB / 'benchmark/fixtures').glob('*_fixtures.json'))
    harness += [KB / f'workload/{t.split("-")[0]}.json' for t in KB_TASKS]
    harness += [HERE / 'DataMind/longds/runners/DSGym/scripts/prompt.py']
    sources = {str(p): digest(p) for p in harness}
    for arm, root in conditions.items():
        sources.update({str(root / name): sha for name, sha in compared[arm].items()})
    for path, sha in sources.items():
        label = str(Path(path).relative_to(ROOT)) if Path(path).is_relative_to(ROOT) else str(Path(path).relative_to(output))
        archive = output / 'source' / label
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(Path(path).read_bytes())
        if digest(archive) != sha:
            raise RuntimeError('Source changed during freezing')
    manifests = {}
    for benchmark, tasks in [('longds', COHORT), ('krama', krama_tasks)]:
        prepared_hashes = {task: {name: digest(output / 'prepared' / task.replace('/', '__') / name)
                                  for name in ['manifest.json', 'gold.json', 'prompts.json']} for task in tasks}
        for arm, endpoint in [('before', args.before_endpoint), ('after', args.after_endpoint)]:
            phase = f'{benchmark}-{arm}'
            jobs = make_jobs(tasks, [arm], args.reps, phase)
            for job in jobs:
                job.update({'benchmark': benchmark, 'settings': settings(benchmark),
                            'turns_total': len(json.loads((output / 'prepared' / job['task'].replace('/', '__') / 'manifest.json').read_text())['turns'])})
            protocol = {'phase': phase, 'created_at': datetime.now(timezone.utc).isoformat(),
                'model': MODEL, 'reasoning_effort': 'medium', 'max_model_calls_per_turn': 40,
                'max_output_tokens_per_call': 8192, 'full_input_policy': {'budget_tokens': 0, 'scale': 1},
                'context_budget': 0, 'endpoint': endpoint, 'rates_usd_per_million': RATES,
                'pricing_source': 'Same repository fallback token prices; estimates, not invoices',
                'judge': 'deepseek/deepseek-v4-pro', 'repetitions': args.reps,
                'solver_attempt_policy': 'Three independent full repetitions retained; no best-of or selective solver replay',
                'source_hashes': sources, 'input_files': inputs, 'prepared_hashes': prepared_hashes,
                'prompt_hashes': {task: hashes['prompts.json'] for task, hashes in prepared_hashes.items()}, 'jobs': jobs}
            path = output / phase / 'manifest.json'
            save(path, protocol)
            manifests[phase] = digest(path)
    save(output / 'protocol.json', {'created_at': datetime.now(timezone.utc).isoformat(),
         'conditions': {arm: str(root) for arm, root in conditions.items()}, 'manifests': manifests,
         'longds_sessions': COHORT, 'krama_tasks': KB_TASKS, 'repetitions': args.reps,
         'smoke': {'longds': COHORT[2], 'krama': 'wildfire-easy-1', 'reuse_policy': 'Smoke is repetition one of the predeclared pilot'},
         'solver_cost_review_threshold_usd': 20, 'scope': 'Pilot is exploratory, previously studied LongDS cohort; broader claims require unseen sessions',
         'excluded': ['ledger', 'new check interface', 'context compaction changes']})
    print(f'Frozen: {len(COHORT)} LongDS sessions, {len(KB_TASKS)} KramaBench tasks, {args.reps} repetitions per condition')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'prepare-krama':
        print(prepare_krama(Path(sys.argv[2]), sys.argv[3]))
        raise SystemExit(0)
    if len(sys.argv) > 1 and sys.argv[1] == 'score-krama':
        prepared, output = Path(sys.argv[2]), Path(sys.argv[3])
        score_krama({}, prepared, output, json.loads((output / 'results_with_ground_truth.json').read_text()))
        raise SystemExit(0)
    from dotenv import load_dotenv
    load_dotenv(ROOT / '.env', override=False)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--previous', type=Path, default=Path('/var/tmp/dataflow-state-comparison-20261003'))
    parser.add_argument('--before-endpoint', default='http://localhost:3063')
    parser.add_argument('--after-endpoint', default='http://localhost:3064')
    parser.add_argument('--reps', type=int, default=3)
    freeze(parser.parse_args())
