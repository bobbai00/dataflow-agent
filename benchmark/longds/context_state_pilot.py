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
import ast
import errno
import fcntl
import gzip
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import threading
import time
import zipfile

from dotenv import load_dotenv
from openai import OpenAI

from _paths import DATAMIND, UPSTREAM_PROMPT
from bounded_pilot import pilot_rates
from catalog_pilot import Kernel, solve
from native_catalog_pilot import Native, SETTINGS
from prepare import prepare_one, resolve_task_selection
from state_comparison import ROOT, HERE, build_prompts, digest, save, cost_of

# The 2026-10-06 bounded pilot: two short prefixes. `--cases` selects others.
CASES = {
    'geoscience/marmara-region-earthquakes-apr-2324-2025/task1': {
        'turns': 5, 'rationale': 'Cleaning updates the working set; Q4 and Q5 compare with pre-cleaning events.'},
    'education/world_university_rankings/task3': {
        'turns': 3, 'rationale': 'Q2 asks for the original score after Q1 replaces it; Q3 must keep the recomputed rule.'},
}
MODELS = ('gpt-5.6-terra', 'gpt-5.6-luna')
CONTEXTS = ('catalog', 'trajectory')
AGENTS = ('dataflow', 'python')
DEFAULT_JUDGE = 'gpt-5.2'


def label_counts(task):
    """State labels of a Lite session, from its evaluator-only metadata."""
    meta = json.loads((DATAMIND / 'task/longds_v1.1' / task / 'metadata.json').read_text())
    counts = {}
    for entry in meta:
        for label in entry.get('state_type', []):
            counts[label] = counts.get(label, 0) + 1
    return {'session_turns': len(meta), 'labels': counts}


def prepare_cases(root, items):
    """Prepared inputs for Lite sessions (`task` or `task:turns`), in the layout `freeze` checks."""
    _, entries = resolve_task_selection(DATAMIND, 'v1.1', 'lite')
    for item in items:
        task, _, turns = item.partition(':')
        entry = next((e for e in entries if '/'.join(e[f] for f in ('task_domain', 'dataset_name', 'task_id')) == task), None)
        if entry is None:
            raise ValueError(f'Task is outside the Lite split: {task}')
        # Inventory paths stay `data/longds/...`, valid from the repo root and the KramaBench root alike.
        manifest = prepare_one(entry, int(turns) if turns else None, task_root=DATAMIND / 'task/longds_v1.1',
                               output_root=root / 'prepared', version='v1.1', split='lite')
        if manifest is None:
            raise RuntimeError(f'Could not prepare {task}')
        save(root / 'prepared' / task.replace('/', '__') / 'prompts.json', build_prompts(manifest))
        print(f'PREPARED {task}: {len(manifest["turns"])} turns, {len(manifest["files"])} files', flush=True)


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


def freeze(root, spend_limit, cases_spec=None, models=MODELS, contexts=CONTEXTS, agents=AGENTS,
           judge_model=DEFAULT_JUDGE, concurrency=2, endpoint=None):
    if spend_limit <= 0:
        raise ValueError('Spend guard must be positive')
    folder = root / 'pilot'
    folder.mkdir(exist_ok=False)
    _, entries = resolve_task_selection(DATAMIND, 'v1.1', 'lite')
    allowed = {'/'.join(e[f] for f in ('task_domain', 'dataset_name', 'task_id')) for e in entries}
    cases = {}
    for task, spec in (cases_spec or CASES).items():
        prepared = root / 'prepared' / task.replace('/', '__')
        manifest = json.loads((prepared / 'manifest.json').read_text())
        if not spec.get('turns'):
            spec = {**spec, 'turns': len(manifest['turns'])}
        validate_case(manifest, allowed, spec['turns'])
        prompts = build_prompts(manifest)
        if json.loads((prepared / 'prompts.json').read_text()) != prompts:
            raise ValueError('Prepared prompts differ from current shared task instructions')
        cases[task] = {**spec, 'prepared': str(prepared.resolve()),
                       'hashes': {name: digest(prepared / name) for name in ('manifest.json', 'gold.json', 'prompts.json')},
                       'input_hashes': {name: digest(ROOT / name) for name in manifest['files']}}
    jobs = [{'task': task, 'agent': agent, 'context': context, 'model': model}
            for task in cases for model in models for context in contexts for agent in agents]
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
        'models': list(models), 'contexts': list(contexts), 'agents': list(agents),
        'attempts_per_session': 1, 'max_model_calls_per_question': 40,
        'max_output_tokens': {'python': 8192, 'dataflow': 'agent-service default; no explicit cap in settings'},
        'input_token_cap': None, 'compaction': False, 'concurrency': concurrency,
        'agent_service_endpoint': endpoint or os.environ.get('TEXERA_AGENT_SERVICE_ENDPOINT', 'http://localhost:3071'),
        'catalog_statistics': False, 'catalog_records': 0, 'inventory': 'paths only',
        'native_settings': {c: native_settings(c) for c in contexts},
        'baseline': 'Ordinary persistent Python with script catalog or exact trajectory; retention freely chosen.',
        'python_answer_receipt': 'Immutable task/script catalog boundary in both policies.',
        'task_prompt_policy': 'Identical question and first-request analysis instructions; framework system/tools differ.',
        'solver_attempt_policy': 'Every question in each natural prefix; no replay, injected gold, retries or scaling.',
        'spend_guard_usd': spend_limit,
        'spend_guard_policy': 'Stop dispatch after completed question; two in-flight questions may overshoot. Judge cost separate.',
        'rates_usd_per_million': {m: pilot_rates(m) for m in models},
        'pricing_policy': 'Configured gateway token rates with cache discount; estimates, not invoices.',
        'judge': {'model': judge_model, 'prompt_sha256': digest(UPSTREAM_PROMPT), 'attempts': 1,
                  'endpoint': os.environ.get('JUDGE_BASE_URL', 'http://localhost:4000/v1'),
                  'protocol': 'Upstream binary rubric; same judge for all arms' +
                              ('; the paper\'s judge model' if 'deepseek-v4-pro' in judge_model else ', no published-score claim')},
        'metrics': ['official binary score', 'declared-root dependency agreement and coverage',
                    'exact saved-result reads/inputs', 'current-table preservation',
                    'oracle-keyed working-table checks and coverage', 'executed/cached operator counts',
                    'tokens including cached', 'calls', 'solver cost', 'wall time'],
        'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'source_status': subprocess.check_output(['git', 'status', '--short'], cwd=ROOT, text=True),
        'source_hashes': sources,
    })
    print(f'Frozen {len(jobs)} sessions, {sum(cases[j["task"]]["turns"] for j in jobs)} questions.', flush=True)


def job_key(job):
    return '__'.join((job['task'].replace('/', '__'), job['model'].replace('gpt-5.6-', ''),
                     job['agent'], job['context']))


class SpendGuard:
    def __init__(self, limit, initial=0.):
        self.limit, self.total = limit, initial
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


def solver_signature(source, name):
    """Freeze model-facing Python logic while allowing kernel startup repairs."""
    tree = ast.parse(source)
    if name.endswith('catalog_pilot.py'):
        selected = []
        for node in tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.Assign)):
                selected.append(node)
            elif isinstance(node, ast.ClassDef) and node.name == 'Kernel':
                selected.extend(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name != '__init__')
        return ast.dump(ast.Module(body=selected, type_ignores=[]))
    return ast.dump(next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'native_settings'))


def attempt_spend(folder, run_keys=None):
    """All physical attempts, including archived and interrupted turns; reused prefix
    records retain their original analytical cost but are never billed twice.
    Unknown timeout calls reserve $0.25 (Luna) / $2.50 (Terra), not a claimed bill."""
    known, uncertain, reserve = 0., 0, 0.
    for run in (folder / 'runs').glob('*'):
        key = run.name.split('.failed-', 1)[0].split('.partial-', 1)[0]
        if not run.is_dir() or run_keys is not None and key not in run_keys:
            continue
        records = json.loads((run / 'records.json').read_text()) if (run / 'records.json').exists() else []
        indexed = {r.get('turn_id', i): r for i, r in enumerate(records)}
        for directory in run.glob('t[0-9][0-9]'):
            if (directory / 'record.json').exists():
                indexed.setdefault(int(directory.name[1:]), json.loads((directory / 'record.json').read_text()))
        for number, record in indexed.items():
            if record.get('reused_from'):
                continue
            stats = record['stats']
            if stats.get('cost_usd') is not None:
                known += stats['cost_usd']
                missing = int('timed out' in str(record.get('error', '')).lower())
            else:
                missing = 1
                trace = run / f't{number:02d}' / 'react_steps.json.gz'
                if trace.exists():
                    model = record.get('model', 'gpt-5.6-luna')
                    with gzip.open(trace, 'rt') as source:
                        steps = json.load(source)['steps']
                    missing = 0
                    for step in steps:
                        if step.get('role') != 'agent':
                            continue
                        usage = step.get('usage')
                        if not usage:
                            missing += 1
                            continue
                        measured = {'input_tokens': usage.get('inputTokens'), 'output_tokens': usage.get('outputTokens'),
                                    'cached_tokens': usage.get('cachedInputTokens'), 'cache_write_tokens': usage.get('cacheCreationInputTokens', 0)}
                        amount = cost_of(measured, pilot_rates(model))
                        if amount is None:
                            missing += 1
                        else:
                            known += amount
            uncertain += missing
            reserve += missing * (2.5 if 'terra' in record.get('model', run.name) else .25)
        # A process may die after a provider response but before writing its turn record.
        for directory in run.glob('t[0-9][0-9]'):
            if int(directory.name[1:]) in indexed:
                continue
            model = 'gpt-5.6-terra' if '__terra__' in run.name else 'gpt-5.6-luna'
            responses = list(directory.glob('*-response.json'))
            for response in responses:
                usage = json.loads(response.read_text()).get('usage') or {}
                measured = {'input_tokens': usage.get('prompt_tokens'), 'output_tokens': usage.get('completion_tokens'),
                            'cached_tokens': (usage.get('prompt_tokens_details') or {}).get('cached_tokens', 0)}
                amount = cost_of(measured, pilot_rates(model))
                if amount is not None:
                    known += amount
                else:
                    uncertain += 1
                    reserve += 2.5 if 'terra' in model else .25
            unmatched = max(0, len(list(directory.glob('*-request.json'))) - len(responses))
            uncertain += unmatched
            reserve += unmatched * (2.5 if 'terra' in model else .25)
    return {'known_cost_usd': known, 'unknown_requests': uncertain, 'unknown_cost_reserve_usd': reserve,
            'guard_cost_usd': known + reserve, 'estimate': True}


def rows_digest(rows):
    serialized = sorted(json.dumps(row, sort_keys=True, ensure_ascii=False, default=str) for row in rows)
    return hashlib.sha256('\n'.join(serialized).encode()).hexdigest()


def visible_tables(capture):
    hidden = {op['operatorID'] for op in capture.get('snapshot', {}).get('workflow', {}).get('operators', [])
              if op.get('savedResult')}
    return {name: table for name, table in capture.get('observerTables', {}).items() if name not in hidden}


def completed_prefix(run):
    """Include answers persisted before an observer export or aggregate save failed.
    Never discard a completed answer merely because records.json missed it."""
    aggregate = run / 'records.json'
    indexed = {r['turn_id']: r for r in json.loads(aggregate.read_text())} if aggregate.exists() else {}
    for path in sorted(run.glob('t[0-9][0-9]/record.json')):
        record = json.loads(path.read_text())
        indexed.setdefault(record['turn_id'], record)
    prefix = []
    for number, record in sorted(indexed.items()):
        if number != len(prefix) + 1:
            raise ValueError('Checkpoint has a gap; recover artifacts before continuing')
        if not record['completed']:
            if any(r['completed'] for n, r in indexed.items() if n > number):
                raise ValueError('Completed answers follow an incomplete checkpoint')
            break
        prefix.append(record)
    return prefix


def copy_checkpoint_file(source, target):
    """A sealed observer table is immutable. Share its bytes on the same volume;
    records and judge verdicts remain independent, since recovery rewrites them."""
    if Path(source).suffix == '.pkl':
        try:
            os.link(source, target)
            return str(target)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
    return shutil.copy2(source, target)


def replay_prefix(instance, job, previous, records, output):
    """Rebuild only agent-authored state. Verify the checkpoint before any paid continuation."""
    started = time.monotonic()
    for record in records:
        if job['agent'] == 'python':
            for script in record['scripts']:
                result = instance.code(record['turn_id'], script['source'])
                if result['success'] != script['success']:
                    raise RuntimeError('Python prefix replay differs from recorded execution')
        else:
            instance.rpc('debug', content=record['prompt'])
            for batch in record['native_actions']:
                if isinstance(batch, str):
                    try:
                        batch = json.loads(batch)
                    except ValueError:
                        continue  # Invalid arguments applied no graph action.
                instance.rpc('debug', tool='dataflow', args=batch)
        print(f'REPLAYED {job_key(job)} Q{record["turn_id"]}', flush=True)
    differences = []
    if records:
        turn = records[-1]['turn_id']
        if job['agent'] == 'python':
            actual = instance.capture(output / 'replay-observer')
            expected = json.loads((previous / f't{turn:02d}' / 'observer/bindings.json').read_text())
            differences = [name for name, item in expected.items() if item.get('file') and
                           actual.get(name, {}).get('version') != item['version']]
        else:
            actual = instance.capture(output / 'replay-observer')
            with gzip.open(previous / f't{turn:02d}' / 'observer/capture.json.gz', 'rt') as source:
                expected = json.load(source)
            for name, table in visible_tables(expected).items():
                if not table.get('complete'):
                    continue
                other = actual.get('observerTables', {}).get(name)
                if not other or not other.get('complete') or rows_digest(table['rows']) != rows_digest(other['rows']):
                    differences.append(name)
    save(output / 'replay-verification.json', {'prefix_turns': len(records), 'differences': differences,
                                              'elapsed_seconds': time.monotonic() - started,
                                              'model_calls': 0, 'source': str(previous)})
    if differences:
        raise RuntimeError('Prefix checkpoint values differ: ' + ', '.join(differences))


def run_job(job, protocol, folder, guard, spend_file=None, resume_from=None):
    output = folder / 'runs' / job_key(job)
    output.mkdir(parents=True, exist_ok=False)
    prepared = Path(protocol['cases'][job['task']]['prepared'])
    manifest = json.loads((prepared / 'manifest.json').read_text())
    prompts = {p['turn_id']: p['prompt'] for p in json.loads((prepared / 'prompts.json').read_text())}
    records, instance, error = [], None, None
    try:
        guard.check()
        if job['agent'] == 'dataflow':
            instance = Native(output, job['model'], settings=protocol['native_settings'][job['context']],
                              complete_observer_tables=True)
        else:
            instance = Kernel(manifest, output)
            client = OpenAI(base_url='http://localhost:4000/v1', api_key=os.environ['LITELLM_MASTER_KEY'],
                            max_retries=0, timeout=protocol.get('completion', {}).get('transport_timeout_seconds', 180))
        if resume_from:
            prefix = completed_prefix(resume_from)
            replay_prefix(instance, job, resume_from, prefix, output)
            for record in prefix:
                target = output / f't{record["turn_id"]:02d}'
                shutil.copytree(resume_from / target.name, target, copy_function=copy_checkpoint_file)
                reused = {**record, 'reused_from': record.get('reused_from') or str(resume_from / target.name)}
                save(target / 'record.json', reused)
                records.append(reused)
            save(output / 'records.json', records)
        for turn in manifest['turns'][len(records):]:
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
            with guard.lock:
                save(spend_file or folder / 'spend.json', {'guard_cost_usd': guard.total, 'estimate': True,
                                                        'includes_unknown_usage_reserve': True})
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


# Harness files that may change between a freeze and a resume: the runner, the Python
# baseline's kernel wiring, and evaluator-only scripts that no solver imports. Solver code
# and prompts are never exempt.
RESUMABLE = ('benchmark/longds/context_state_pilot.py', 'benchmark/longds/catalog_pilot.py',
             'benchmark/longds/context_state_score.py', 'benchmark/longds/versions_reference_study.py',
             'benchmark/longds/versions_run_report.py')


def run(root, resume=False, only_agent=None, only_jobs=None):
    with (root / 'pilot' / 'run.lock').open('a+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another runner owns this campaign; do not move its live artifacts')
        return _run(root, resume, only_agent, only_jobs)


def _run(root, resume=False, only_agent=None, only_jobs=None):
    """Run the frozen jobs. With `resume`, jobs that already finished every question are
    kept, failed or partial job folders are set aside, and the harness files named in
    RESUMABLE may differ from the freeze (their new hashes are recorded)."""
    folder = root / 'pilot'
    protocol = json.loads((folder / 'protocol.json').read_text())
    changed = {}
    with zipfile.ZipFile(folder / 'source.zip') as archive:
        for name, sha in protocol['source_hashes'].items():
            if digest(ROOT / name) != sha:
                evaluator_test = name.startswith('benchmark/longds/test_')
                if resume and (name in RESUMABLE or evaluator_test):
                    if name.endswith(('/catalog_pilot.py', '/context_state_pilot.py')):
                        if solver_signature(archive.read(name).decode(), name) != solver_signature((ROOT / name).read_text(), name):
                            raise ValueError(f'Model-facing solver logic differs from freeze: {name}')
                    changed[name] = digest(ROOT / name)
                    continue
                raise ValueError(f'Runtime source differs from freeze: {name}')
    for case in protocol['cases'].values():
        for name, sha in case['hashes'].items():
            if digest(Path(case['prepared']) / name) != sha:
                raise ValueError('Prepared inputs changed after freeze')
        for name, sha in case['input_hashes'].items():
            if digest(ROOT / name) != sha:
                raise ValueError('Raw input changed after freeze')
    jobs = protocol['jobs']
    previous_attempts = {}
    if resume:
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        selected = []
        for job in jobs:
            if only_agent and job['agent'] != only_agent:
                continue
            if only_jobs and job_key(job) not in only_jobs:
                continue
            output = folder / 'runs' / job_key(job)
            done = output / 'job.json'
            if done.exists():
                state = json.loads(done.read_text())
                if state.get('error') is None and state['attempted_questions'] == state['expected_questions']:
                    continue
                previous = output.parent / f'{output.name}.failed-{stamp}'
                output.rename(previous)
                previous_attempts[job_key(job)] = previous
            elif output.exists():
                previous = output.parent / f'{output.name}.partial-{stamp}'
                output.rename(previous)
                previous_attempts[job_key(job)] = previous
            previous = previous_attempts.get(job_key(job))
            if previous and (previous / 'replay-verification.json').exists():
                verified = json.loads((previous / 'replay-verification.json').read_text())
                if not (previous / 'records.json').exists() and verified.get('source'):
                    previous_attempts[job_key(job)] = Path(verified['source'])
            selected.append(job)
        jobs = selected
        resumes = protocol.setdefault('resumes', [])
        resumes.append({'at': datetime.now(timezone.utc).isoformat(), 'jobs': [job_key(j) for j in jobs],
                        'only_agent': only_agent, 'harness_hashes_now': changed})
        save(folder / 'protocol.json', protocol)
        jobs_file, spend_file = folder / f'jobs-resume-{stamp}.json', folder / f'spend-resume-{stamp}.json'
    else:
        with (folder / 'paid-started.json').open('x') as out:
            json.dump({'started_at': datetime.now(timezone.utc).isoformat()}, out)
        jobs_file, spend_file = folder / 'jobs.json', folder / 'spend.json'
    if protocol.get('agent_service_endpoint'):
        os.environ['TEXERA_AGENT_SERVICE_ENDPOINT'] = protocol['agent_service_endpoint']
    initial_spend = attempt_spend(folder)
    save(folder / 'all-attempt-spend.json', initial_spend)
    guard = SpendGuard(protocol['spend_guard_usd'], initial=initial_spend['guard_cost_usd'])
    rows = []
    with ThreadPoolExecutor(max_workers=protocol['concurrency']) as pool:
        futures = [pool.submit(run_job, j, protocol, folder, guard, spend_file, previous_attempts.get(job_key(j))) for j in jobs]
        for future in as_completed(futures):
            rows.append(future.result())
            save(jobs_file, rows)
    final_spend = attempt_spend(folder)
    save(folder / 'all-attempt-spend.json', final_spend)
    print(json.dumps({'sessions': len(rows), **final_spend,
                      'incomplete_sessions': sum(bool(r['error']) for r in rows)}), flush=True)


if __name__ == '__main__':
    load_dotenv(ROOT / '.env', override=False)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'freeze', 'run'])
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--spend-limit', type=float, default=8.)
    parser.add_argument('--cases', nargs='*', help='domain/dataset/task[:turns]; omitted turns means the whole session')
    parser.add_argument('--models', nargs='*', default=list(MODELS))
    parser.add_argument('--contexts', nargs='*', default=list(CONTEXTS))
    parser.add_argument('--agents', nargs='*', default=list(AGENTS))
    parser.add_argument('--judge-model', default=DEFAULT_JUDGE)
    parser.add_argument('--concurrency', type=int, default=2)
    parser.add_argument('--endpoint', help='agent-service endpoint recorded in the protocol and used by the run')
    parser.add_argument('--resume', action='store_true', help='rerun failed or partial jobs of a started run')
    parser.add_argument('--only-agent', choices=list(AGENTS), help='with --resume: restrict to one agent')
    parser.add_argument('--only-jobs', nargs='*', help='with --resume: restrict to these job folder names')
    arguments = parser.parse_args()
    if arguments.action == 'prepare':
        prepare_cases(arguments.root.resolve(), arguments.cases or [])
    elif arguments.action == 'freeze':
        selected = None
        if arguments.cases:
            selected = {}
            for item in arguments.cases:
                task, _, turns = item.partition(':')
                selected[task] = {**label_counts(task), 'turns': int(turns) if turns else 0,
                                  'rationale': 'Predeclared prefix' if turns else 'Predeclared whole-session run'}
        freeze(arguments.root.resolve(), arguments.spend_limit, selected, tuple(arguments.models),
               tuple(arguments.contexts), tuple(arguments.agents), arguments.judge_model,
               arguments.concurrency, arguments.endpoint)
    else:
        run(arguments.root.resolve(), arguments.resume, arguments.only_agent, arguments.only_jobs)
