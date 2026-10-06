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

"""One-attempt, no-input-cap Lite pilot of saved state and context policy.

Freeze before running. Every arm solves every question in each selected prefix;
there is no oracle injection, reference replay, score-selected retry or scaling.
The Python control uses the repository's persistent DSGym-style executor, not
an unmodified upstream DSGym runner. Judge outputs are evaluated separately.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import subprocess
import threading
import zipfile

from dotenv import load_dotenv
from openai import OpenAI

from _paths import DATAMIND, UPSTREAM_PROMPT
from bounded_pilot import pilot_rates
from catalog_pilot import Kernel, solve
from native_catalog_pilot import Native, SETTINGS
from prepare import resolve_task_selection
from state_comparison import ROOT, HERE, build_prompts, digest, save

CASES = {
    'geoscience/marmara-region-earthquakes-apr-2324-2025/task1': {
        'turns': 5, 'rationale': 'Cleaning updates the working set; Q4 and Q5 compare with pre-cleaning events.'},
    'education/world_university_rankings/task3': {
        'turns': 3, 'rationale': 'Q2 asks for the original score after Q1 replaces it; Q3 must keep the recomputed rule.'},
}
MODELS = ('gpt-5.6-terra', 'gpt-5.6-luna')
CONTEXTS = ('catalog', 'trajectory')
AGENTS = ('dataflow', 'python')


def native_settings(context):
    if context not in CONTEXTS:
        raise ValueError('Unknown context policy')
    return {**SETTINGS, 'taskContext': 'dependencies' if context == 'catalog' else 'trajectory',
            'catalogStatistics': False, 'catalogRecords': 0, 'stateLedger': False,
            'contextWindowTokens': 0, 'thoughtReplay': False, 'maxSteps': 40}


def validate_case(manifest, allowed, limit):
    if manifest.get('longds_version') != 'v1.1' or manifest.get('split') != 'lite':
        raise ValueError('Explicit v1.1 Lite inputs are required')
    task = '/'.join(manifest[f] for f in ('domain', 'dataset_name', 'task_id'))
    if task not in allowed:
        raise ValueError('Task is outside the Lite split')
    if len(manifest['turns']) != limit:
        raise ValueError('Prepared prefix differs from the predeclared length')
    for number, turn in enumerate(manifest['turns'], 1):
        if set(turn) != {'turn_id', 'context', 'question'} or turn['turn_id'] != number:
            raise ValueError('Solver turns must be contiguous and contain no evaluator fields')
    if not manifest['files'] or any(not isinstance(name, str) for name in manifest['files']):
        raise ValueError('File inventory must contain paths only')
    return task


def source_files():
    # Snapshot actual dirty source, rather than misleadingly pinning only HEAD.
    files = [p for p in (ROOT / 'agent-service/src').rglob('*')
             if p.is_file() and p.suffix in {'.ts', '.md', '.py'}]
    files += list(HERE.glob('*.py'))
    for folder in ('agent-service/benchmark/multiturn', 'agent-service/benchmark/e2e'):
        files += list((ROOT / folder).glob('*.ts'))
    files += [ROOT / name for name in (
        'amber/src/main/scala/org/apache/texera/web/service/HistoricalResultService.scala',
        'amber/src/main/scala/org/apache/texera/web/service/OperatorPortCacheService.scala',
        'amber/src/main/scala/org/apache/texera/web/service/WorkflowExecutionService.scala',
        'amber/src/main/scala/org/apache/texera/web/resource/SyncExecutionResource.scala',
        'amber/src/main/scala/org/apache/texera/web/resource/dashboard/user/workflow/WorkflowExecutionsResource.scala',
        'common/workflow-core/src/main/scala/org/apache/texera/amber/core/workflow/WorkflowSettings.scala')]
    return sorted(set(files))


def freeze(root, spend_limit):
    if spend_limit <= 0:
        raise ValueError('Spend guard must be positive')
    folder = root / 'pilot'
    folder.mkdir(exist_ok=False)
    _, entries = resolve_task_selection(DATAMIND, 'v1.1', 'lite')
    allowed = {'/'.join(e[f] for f in ('task_domain', 'dataset_name', 'task_id')) for e in entries}
    cases = {}
    for task, spec in CASES.items():
        prepared = root / 'prepared' / task.replace('/', '__')
        manifest = json.loads((prepared / 'manifest.json').read_text())
        validate_case(manifest, allowed, spec['turns'])
        prompts = build_prompts(manifest)
        if json.loads((prepared / 'prompts.json').read_text()) != prompts:
            raise ValueError('Prepared prompts differ from current shared task instructions')
        cases[task] = {**spec, 'prepared': str(prepared.resolve()),
                       'hashes': {name: digest(prepared / name) for name in ('manifest.json', 'gold.json', 'prompts.json')},
                       'input_hashes': {name: digest(ROOT / name) for name in manifest['files']}}
    jobs = [{'task': task, 'agent': agent, 'context': context, 'model': model}
            for task in CASES for model in MODELS for context in CONTEXTS for agent in AGENTS]
    random.Random(106).shuffle(jobs)
    sources = {str(p.relative_to(ROOT)): digest(p) for p in source_files()}
    with zipfile.ZipFile(folder / 'source.zip', 'x', zipfile.ZIP_DEFLATED) as archive:
        for name, sha in sources.items():
            body = (ROOT / name).read_bytes()
            if digest(ROOT / name) != sha:
                raise RuntimeError('Source changed during freeze')
            archive.writestr(name, body)
    save(folder / 'protocol.json', {
        'created_at': datetime.now(timezone.utc).isoformat(), 'cases': cases, 'jobs': jobs,
        'models': list(MODELS), 'contexts': list(CONTEXTS), 'agents': list(AGENTS),
        'attempts_per_session': 1, 'max_model_calls_per_question': 40, 'max_output_tokens': 8192,
        'input_token_cap': None, 'compaction': False, 'concurrency': 2,
        'catalog_statistics': False, 'catalog_records': 0, 'inventory': 'paths only',
        'native_settings': {c: native_settings(c) for c in CONTEXTS},
        'baseline': 'Ordinary persistent Python with script catalog or exact trajectory; retention freely chosen.',
        'python_answer_receipt': 'Immutable task/script catalog boundary in both policies.',
        'task_prompt_policy': 'Identical question and first-request analysis instructions; framework system/tools differ.',
        'solver_attempt_policy': 'Every question in each natural prefix; no replay, injected gold, retries or scaling.',
        'spend_guard_usd': spend_limit,
        'spend_guard_policy': 'Stop dispatch after completed question; two in-flight questions may overshoot. Judge cost separate.',
        'rates_usd_per_million': {m: pilot_rates(m) for m in MODELS},
        'pricing_policy': 'Configured gateway token rates with cache discount; estimates, not invoices.',
        'judge': {'model': 'gpt-5.2', 'prompt_sha256': digest(UPSTREAM_PROMPT), 'attempts': 1,
                  'protocol': 'Upstream binary rubric; same judge for all arms, no published-score claim.'},
        'metrics': ['official binary score', 'declared-root dependency agreement and coverage',
                    'exact saved-result reads/inputs', 'current-table preservation',
                    'oracle-keyed working-table checks and coverage', 'executed/cached operator counts',
                    'tokens including cached', 'calls', 'solver cost', 'wall time'],
        'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'source_status': subprocess.check_output(['git', 'status', '--short'], cwd=ROOT, text=True),
        'source_hashes': sources,
    })
    print(f'Frozen {len(jobs)} small sessions, {sum(CASES[j["task"]]["turns"] for j in jobs)} questions.', flush=True)


def job_key(job):
    return '__'.join((job['task'].replace('/', '__'), job['model'].replace('gpt-5.6-', ''),
                     job['agent'], job['context']))


class SpendGuard:
    def __init__(self, limit):
        self.limit, self.total = limit, 0.
        self.lock = threading.Lock()
        self.stopped = False

    def check(self):
        with self.lock:
            if self.stopped or self.total >= self.limit:
                raise RuntimeError('Pilot stopped: spend guard or unknown billed usage')

    def add(self, cost):
        with self.lock:
            if cost is None:
                self.stopped = True
                raise RuntimeError('Unknown token cost; preserve artifacts and stop')
            self.total += cost


def run_job(job, protocol, folder, guard):
    output = folder / 'runs' / job_key(job)
    output.mkdir(parents=True, exist_ok=False)
    prepared = Path(protocol['cases'][job['task']]['prepared'])
    manifest = json.loads((prepared / 'manifest.json').read_text())
    prompts = {p['turn_id']: p['prompt'] for p in json.loads((prepared / 'prompts.json').read_text())}
    records, instance, error = [], None, None
    try:
        guard.check()
        if job['agent'] == 'dataflow':
            instance = Native(output, job['model'], settings=native_settings(job['context']),
                              complete_observer_tables=True)
        else:
            instance = Kernel(manifest, output)
            client = OpenAI(base_url='http://localhost:4000/v1', api_key=os.environ['LITELLM_MASTER_KEY'],
                            max_retries=0, timeout=180)
        for turn in manifest['turns']:
            guard.check()
            directory = output / f"t{turn['turn_id']:02d}"
            if job['agent'] == 'dataflow':
                record = instance.solve(turn, prompts[turn['turn_id']], directory)
                record['context_policy'] = job['context']
            else:
                record = solve(instance, client, job['model'], 'ordinary', manifest, turn, records,
                               directory, context_policy=job['context'], current_prompt=prompts[turn['turn_id']])
            records.append(record)
            save(directory / 'record.json', record)
            save(output / 'records.json', records)
            guard.add(record['stats']['cost_usd'])
            save(folder / 'spend.json', {'solver_cost_usd': guard.total, 'estimate': True})
            if not record['completed']:
                error = 'Question incomplete; later dependent questions not attempted'
                break
    except Exception as exc:
        error = str(exc)
    finally:
        if instance is not None:
            try:
                instance.close()
            except Exception as exc:
                error = (error or '') + '\nCleanup failed: ' + str(exc)
        save(output / 'job.json', {**job, 'error': error, 'attempted_questions': len(records),
                                   'expected_questions': len(manifest['turns'])})
    return {**job, 'path': str(output), 'error': error, 'attempted_questions': len(records)}


def run(root):
    folder = root / 'pilot'
    protocol = json.loads((folder / 'protocol.json').read_text())
    for name, sha in protocol['source_hashes'].items():
        if digest(ROOT / name) != sha:
            raise ValueError(f'Runtime source differs from freeze: {name}')
    for case in protocol['cases'].values():
        for name, sha in case['hashes'].items():
            if digest(Path(case['prepared']) / name) != sha:
                raise ValueError('Prepared inputs changed after freeze')
        for name, sha in case['input_hashes'].items():
            if digest(ROOT / name) != sha:
                raise ValueError('Raw input changed after freeze')
    with (folder / 'paid-started.json').open('x') as out:
        json.dump({'started_at': datetime.now(timezone.utc).isoformat()}, out)
    guard = SpendGuard(protocol['spend_guard_usd'])
    rows = []
    with ThreadPoolExecutor(max_workers=protocol['concurrency']) as pool:
        futures = [pool.submit(run_job, j, protocol, folder, guard) for j in protocol['jobs']]
        for future in as_completed(futures):
            rows.append(future.result())
            save(folder / 'jobs.json', rows)
    print(json.dumps({'sessions': len(rows), 'solver_cost_usd': guard.total,
                      'incomplete_sessions': sum(bool(r['error']) for r in rows)}), flush=True)


if __name__ == '__main__':
    load_dotenv(ROOT / '.env', override=False)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['freeze', 'run'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--spend-limit', type=float, default=8.)
    arguments = parser.parse_args()
    if arguments.action == 'freeze':
        freeze(arguments.root.resolve(), arguments.spend_limit)
    else:
        run(arguments.root.resolve())
