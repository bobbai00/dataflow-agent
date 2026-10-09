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
"""Freeze a matched context-policy ablation against one immutable runtime.

Both arms use identical prompts, tools, data, limits and code. Only taskContext
differs. Reuse the registered job runner and official evaluators; no selective
solver retry or answer-dependent rubric. Run from the repository Python venv.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess

from state_comparison import ROOT, HERE, MODEL, RATES, digest, save, make_jobs
from scope_verification import KB, prepare_krama, settings as scope_settings, source_hashes
from task_context_metrics import component_rubric

COHORT = ['business/my_uber_drivers/task2', 'community/kaggle-survey-2019/task2']
KB_TASKS = ['wildfire-easy-1']
POLICIES = ['trajectory', 'dependencies']


def settings(benchmark, policy):
    if policy not in POLICIES:
        raise ValueError('Unknown context policy')
    # History tools and their prompt are shared even in the single-task check.
    # A first task must be identical under the two assembly policies.
    return {**scope_settings(benchmark), 'stateHistory': True, 'taskContext': policy}


def freeze(args):
    output, runtime = args.output.resolve(), args.runtime.resolve()
    if (output / 'protocol.json').exists():
        raise FileExistsError('Study already frozen')
    if args.reps < 1:
        raise ValueError('Positive repetitions required')
    commit = subprocess.check_output(['git', '-C', str(runtime), 'rev-parse', 'HEAD'], text=True).strip()
    if subprocess.check_output(['git', '-C', str(runtime), 'status', '--porcelain', '--untracked-files=no'], text=True):
        raise ValueError('Evaluation runtime must be a clean saved revision')
    gates = {r['task']: r for r in json.loads((args.previous / 'gates-engine.json').read_text())}
    for task in COHORT:
        if gates.get(task, {}).get('exit_code') != 0:
            raise ValueError(f'Reference preflight failed: {task}')
        source = args.previous / 'prepared' / task.replace('/', '__')
        target = output / 'prepared' / task.replace('/', '__')
        shutil.copytree(source, target)
    krama = [prepare_krama(output, task) for task in KB_TASKS]
    rubrics = {task: {str(t['turn_id']): component_rubric(t['answer'])
                     for t in json.loads((output / 'prepared' / task.replace('/', '__') / 'gold.json').read_text())['turns']}
               for task in COHORT}
    save(output / 'partial-rubrics.json', rubrics)
    files = {f for task in [*COHORT, *krama]
             for f in json.loads((output / 'prepared' / task.replace('/', '__') / 'manifest.json').read_text())['files']}
    inputs = {name: {'bytes': (ROOT / name).stat().st_size, 'mtime_ns': (ROOT / name).stat().st_mtime_ns,
                     'sha256': digest(ROOT / name)} for name in sorted(files)}
    harness = [HERE / n for n in ['task_context_verification.py', 'task_context_metrics.py',
                'state_comparison.py', 'comparison_campaign.py', 'comparison_job.py', 'comparison_report.py',
                'comparison_cost.py', 'comparison_adjudicate.py', 'scope_verification.py', 'judge_longds.py', 'numeric_gate.py']]
    harness += [ROOT / 'agent-service/benchmark/multiturn/run-comparison-session.ts',
                HERE / 'DataMind/longds/runners/DSGym/scripts/prompt.py']
    harness += list((KB / 'benchmark').rglob('*.py'))
    harness += [KB / 'utils/answer_parser.py', KB / 'systems/dataflow_system.py', KB / 'systems/data_source_utils.py']
    harness += list((KB / 'benchmark/fixtures').glob('*_fixtures.json'))
    harness += [KB / f'workload/{task.split("-")[0]}.json' for task in KB_TASKS]
    sources = {str(p): digest(p) for p in harness}
    sources.update({str(runtime / name): sha for name, sha in source_hashes(runtime).items()})
    for name, sha in sources.items():
        path = Path(name)
        label = 'harness/' + str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else 'runtime/' + str(path.relative_to(runtime))
        archive = output / 'source' / label
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(path.read_bytes())
        if digest(archive) != sha:
            raise RuntimeError('Source changed while freezing')
    manifests = {}
    for benchmark, tasks in [('longds', COHORT), ('krama', krama)]:
        prepared_hashes = {task: {name: digest(output / 'prepared' / task.replace('/', '__') / name)
                                  for name in ['manifest.json', 'gold.json', 'prompts.json']} for task in tasks}
        jobs = make_jobs(tasks, POLICIES, args.reps, benchmark)
        for job in jobs:
            job.update({'benchmark': benchmark, 'settings': settings(benchmark, job['arm']),
                        'turns_total': len(json.loads((output / 'prepared' / job['task'].replace('/', '__') / 'manifest.json').read_text())['turns'])})
        protocol = {'phase': benchmark, 'created_at': datetime.now(timezone.utc).isoformat(),
            'runtime_commit': commit, 'model': MODEL, 'reasoning_effort': 'medium',
            'max_model_calls_per_turn': 40, 'max_output_tokens_per_call': 8192,
            'full_input_policy': {'budget_tokens': 0, 'scale': 1}, 'context_budget': 0,
            'endpoint': args.endpoint, 'rates_usd_per_million': RATES,
            'pricing_source': 'Shared repository fallback prices; cache-aware estimates, not invoices',
            'judge': 'deepseek/deepseek-v4-pro', 'repetitions': args.reps,
            'solver_attempt_policy': 'Independent full repetitions retained; no best-of or selective solver replay',
            'source_hashes': sources, 'input_files': inputs, 'prepared_hashes': prepared_hashes,
            'prompt_hashes': {task: h['prompts.json'] for task, h in prepared_hashes.items()}, 'jobs': jobs,
            'partial_rubric_sha256': digest(output / 'partial-rubrics.json')}
        path = output / benchmark / 'manifest.json'
        save(path, protocol)
        manifests[benchmark] = digest(path)
    save(output / 'protocol.json', {'created_at': datetime.now(timezone.utc).isoformat(),
        'runtime': str(runtime), 'runtime_commit': commit, 'manifests': manifests,
        'longds_sessions': COHORT, 'krama_tasks': KB_TASKS, 'repetitions': args.reps,
        'arms': POLICIES, 'difference': 'taskContext only; shared system prompt and tool definitions',
        'solver_cost_review_threshold_usd': 20,
        'scope': 'Exploratory ablation on two previously studied sessions; no benchmark-wide or DSGym superiority claim',
        'partial_metric': 'Strict reference-JSON leaf agreement, schema-sensitive diagnostic; not semantic accuracy',
        'partial_rubric_sha256': digest(output / 'partial-rubrics.json'),
        'error_policy': 'Mechanical runtime errors for all turns; causal state/semantic/cascade labels require manual trace evidence',
        'excluded': ['ledger', 'semantic-check tool', 'automatic summarization', 'new statistics exposure']})
    print(f'Frozen {len(COHORT)} full sessions and {len(KB_TASKS)} single-task case, {args.reps} repetitions per policy')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--previous', type=Path, default=Path('/var/tmp/dataflow-state-comparison-20261003'))
    parser.add_argument('--endpoint', default='http://localhost:3067')
    parser.add_argument('--reps', type=int, default=3)
    freeze(parser.parse_args())
