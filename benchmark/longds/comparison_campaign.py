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
"""Resume the frozen queue without replaying a solver attempt.

An existing attempt is adopted or reported as incomplete; it is never rerun.
Concurrency affects scheduling only. Run when the previous controller is stopped.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import threading
import time

from state_comparison import HERE, ROOT, digest, save, verify_inputs, verify_sources
from comparison_adjudicate import resolved_rows


def job_key(job):
    return f"{job['arm']}-r{job['rep']}/{job['task'].replace('/', '__')}"


def completed_artifacts(folder, expected):
    path = folder / "results_eval.json"
    if not path.exists():
        return False
    rows = resolved_rows(folder)
    return (len(rows) == expected and sorted(r['turn_id'] for r in rows) == list(range(1, expected+1))
            and all((r.get('judge') or {}).get('score') in (0, 1) for r in rows))


def process_matches(pid, output):
    """Check identity as well as liveness, so PID reuse cannot hold up recovery."""
    try:
        proc = Path('/proc') / str(pid)
        state = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[0]
        command = (proc / 'cmdline').read_bytes().split(b'\0')
        return (state != 'Z' and str(HERE / 'comparison_job.py').encode() in command
                and str(output).encode() in command)
    except FileNotFoundError:
        return False


def existing_controller(folder):
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            if (proc / 'stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z':
                continue
            command = (proc / 'cmdline').read_bytes().split(b'\0')
            names = [Path(c.decode()).name for c in command if c]
            if (any(n in names for n in ['state_comparison.py', 'comparison_campaign.py'])
                    and str(folder.parent).encode() in command and folder.name.encode() in command
                    and (b'run' in command or 'comparison_campaign.py' in names)):
                return int(proc.name)
        except (FileNotFoundError, PermissionError, UnicodeDecodeError):
            continue
    return None


def validate_input_policy(protocol, environment):
    """Refuse a differently configured script process before any paid job.
    The native driver independently verifies the remote service policy."""
    expected = protocol.get('full_input_policy')
    if not expected:
        return
    try:
        tokens = int(environment.get('MODEL_INPUT_TOKEN_BUDGET', '0'))
        scale = float(environment.get('MODEL_INPUT_TOKEN_SCALE', '1'))
        calls = int(environment.get('MODEL_MAX_CALLS_PER_TURN', '0'))
    except (ValueError, TypeError):
        raise ValueError('Invalid full input policy environment') from None
    if (tokens != expected['budget_tokens'] or scale != expected['scale']
            or calls != protocol['max_model_calls_per_turn']):
        raise ValueError('Full input policy environment differs from the frozen protocol')


def reuse_control(job, destination):
    """Read the whole predeclared control, never select favorable outcomes.
    A phase-local symlink lets the existing report read the original artifacts
    without a solver rerun, repricing, rejudging or copying over an attempt."""
    source = Path(job['reuse_from'])
    if not completed_artifacts(source, job['turns_total']):
        raise ValueError('Predeclared control is incomplete; refusing solver replay')
    previous = json.loads((source / 'job.json').read_text())
    if any(previous.get(field) != job[field] for field in ['task', 'arm', 'rep', 'turns_total']):
        raise ValueError('Predeclared control identity differs from the new phase')
    if previous['settings'] != job['settings']:
        raise ValueError('Predeclared control settings differ from the new phase')
    if destination.exists() or destination.is_symlink():
        if not destination.is_symlink() or destination.resolve() != source.resolve():
            raise ValueError('Existing control destination differs; refusing overwrite')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(source.resolve(), target_is_directory=True)


def run(args):
    from dotenv import load_dotenv
    load_dotenv(ROOT / '.env', override=False)
    folder = args.output.resolve() / args.phase
    controller = existing_controller(folder)
    if controller:
        raise RuntimeError(f"Campaign controller {controller} is still active; no second queue may launch")
    protocol = json.loads((folder / 'manifest.json').read_text())
    validate_input_policy(protocol, os.environ)
    verify_sources(protocol)
    progress_path = folder / 'progress.json'
    prior = json.loads(progress_path.read_text()) if progress_path.exists() else {'active': {}, 'completed': []}
    finished = {job_key(j): j for j in prior['completed']}
    active = prior['active']
    progress = {**prior, 'status': 'running', 'active': {}, 'completed': list(finished.values()),
                'controller_pid': os.getpid(), 'native_workers': args.native_workers,
                'script_workers': args.script_workers, 'resumed_at': datetime.now(timezone.utc).isoformat()}
    lock = threading.Lock()
    save(folder / f"controller-{os.getpid()}.json", {'source_sha256': digest(__file__),
         'solver_protocol_sha256': digest(folder / 'manifest.json'), 'native_workers': args.native_workers,
         'script_workers': args.script_workers, 'adopted_attempts': active,
         'full_input_policy': protocol.get('full_input_policy'),
         'policy': 'Existing attempt directories are never overwritten or retried'})
    (folder / f"controller-{os.getpid()}.py").write_bytes(Path(__file__).read_bytes())
    save(progress_path, progress)

    def execute(job):
        key = job_key(job)
        dest = folder / 'runs' / key
        started = time.monotonic()
        if job.get('reuse_from'):
            reuse_control(job, dest)
            row = {**job, 'path': str(dest), 'exit_code': None, 'reused_control': True,
                   'complete_artifacts': True, 'elapsed_since_resume': round(time.monotonic()-started, 2)}
        elif dest.exists():
            pid = active.get(key, {}).get('pid')
            with lock:
                progress['active'][key] = {'pid': pid, 'adopted': True}
                save(progress_path, progress)
            while pid and process_matches(pid, dest):
                time.sleep(2)
            complete = completed_artifacts(dest, job['turns_total'])
            row = {**job, 'path': str(dest), 'exit_code': None, 'adopted': True,
                   'complete_artifacts': complete, 'elapsed_since_resume': round(time.monotonic()-started, 2)}
        else:
            verify_sources(protocol)
            prepared = args.output.resolve() / 'prepared' / job['task'].replace('/', '__')
            verify_inputs(protocol, job['task'], prepared)
            dest.mkdir(parents=True, exist_ok=False)
            save(dest / 'job.json', job)
            with (dest / 'runner.log').open('x') as stream:
                proc = subprocess.Popen([str(ROOT / '.venv/bin/python'), str(HERE / 'comparison_job.py'),
                    '--protocol', str(folder / 'manifest.json'), '--prepared', str(prepared), '--output', str(dest)],
                    env=dict(os.environ, PYTHONUNBUFFERED='1', OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1'),
                    cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
                with lock:
                    progress['active'][key] = {'pid': proc.pid, 'started_at': datetime.now(timezone.utc).isoformat()}
                    save(progress_path, progress)
                code = proc.wait()
            row = {**job, 'path': str(dest), 'exit_code': code,
                   'complete_artifacts': completed_artifacts(dest, job['turns_total']),
                   'elapsed_seconds': round(time.monotonic()-started, 2)}
        with lock:
            progress['active'].pop(key, None)
            progress['completed'].append(row)
            save(progress_path, progress)
        print('DONE', key, row['exit_code'], row['complete_artifacts'], flush=True)

    todo = [j for j in protocol['jobs'] if job_key(j) not in finished]
    with ThreadPoolExecutor(max_workers=args.native_workers) as native, ThreadPoolExecutor(max_workers=args.script_workers) as script:
        futures = [(script if j['arm'] == 'dsgym' else native).submit(execute, j) for j in todo]
        for future in as_completed(futures):
            future.result()
    progress['status'] = ('complete' if all(completed_artifacts(Path(j['path']), j['turns_total'])
                           for j in progress['completed']) else 'completed_with_failures')
    progress['finished_at'] = datetime.now(timezone.utc).isoformat()
    save(progress_path, progress)
    subprocess.check_call([str(ROOT / '.venv/bin/python'), str(HERE / 'comparison_report.py'), str(folder)], cwd=ROOT)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--phase', required=True)
    parser.add_argument('--native-workers', type=int, default=4)
    parser.add_argument('--script-workers', type=int, default=4)
    run(parser.parse_args())
