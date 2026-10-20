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
"""Run the predeclared ledger stage only after both context conditions pass.

No new solver attempts are selected from outcomes, and no interrupted attempts
are replayed. A failed/incomplete context condition stops the follow-up visibly.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time

from comparison_budget import audit_requests, wire_rows
from comparison_adjudicate import recover_phase
from comparison_campaign import completed_artifacts, existing_controller, job_key
from state_comparison import HERE, ROOT, digest, save, verify_sources


def phase_complete(folder):
    path = folder / 'progress.json'
    if not path.exists():
        return False
    progress = json.loads(path.read_text())
    if progress['status'] == 'running':
        if existing_controller(folder) != progress.get('controller_pid') or not progress.get('controller_pid'):
            raise ValueError(f'{folder.name} controller stopped before completing; follow-up not launched')
        return False
    if progress['status'] not in ['complete', 'completed_with_failures']:
        raise ValueError(f'{folder.name} completed with failures; follow-up not launched')
    if progress['status'] == 'completed_with_failures' and 'completed' not in progress:
        raise ValueError(f'{folder.name} completed with failures; follow-up not launched')
    protocol = json.loads((folder / 'manifest.json').read_text())
    if len(progress['completed']) != len(protocol['jobs']):
        raise ValueError(f'{folder.name} completion count differs from the protocol')
    for job in protocol['jobs']:
        if not completed_artifacts(folder / 'runs' / job_key(job), job['turns_total']):
            raise ValueError(f'{folder.name} has incomplete artifacts; follow-up not launched')
    return True


def watcher_alive(pid, output):
    try:
        proc = Path('/proc') / str(pid)
        state = (proc / 'stat').read_text().rsplit(')', 1)[1].split()[0]
        command = (proc / 'cmdline').read_bytes().split(b'\0')
        cwd = (proc / 'cwd').resolve()
        scripts = [Path(arg.decode()) for arg in command if arg and Path(arg.decode()).name == Path(__file__).name]
        matches = any((script if script.is_absolute() else cwd / script).resolve() == Path(__file__).resolve()
                      for script in scripts)
        return state != 'Z' and matches and str(output).encode() in command
    except (FileNotFoundError, PermissionError):
        return False


def run(output, workers, resume=False):
    output = output.resolve()
    marker = output / 'followup.json'
    previous = None
    if marker.exists():
        previous = json.loads(marker.read_text())
        if not resume:
            raise FileExistsError('Follow-up already registered; inspect its status before resuming')
        if previous['status'] not in ['waiting_for_context_conditions', 'stopped_with_error']:
            raise ValueError('Only an inactive waiting or failed follow-up may be resumed')
        if watcher_alive(previous['pid'], output) or existing_controller(output / 'ledger'):
            raise ValueError('Follow-up or ledger controller is still active')
        if previous['ledger_protocol_sha256'] != digest(output / 'ledger/manifest.json'):
            raise ValueError('Ledger protocol changed since registration')
        archive = output / 'followup-history' / f"registration-{previous['pid']}.json"
        archive.parent.mkdir(parents=True, exist_ok=True)
        with archive.open('xb') as stream:
            stream.write(marker.read_bytes())
    elif resume:
        raise FileNotFoundError('No follow-up registration to resume')
    state = {'status': 'waiting_for_context_conditions', 'pid': os.getpid(),
             'created_at': datetime.now(timezone.utc).isoformat(), 'source_sha256': digest(__file__),
             'ledger_protocol_sha256': digest(output / 'ledger/manifest.json'),
             'policy': 'All predeclared bounded history controls reused; only ledger adds paid solver jobs'}
    if previous:
        state['resumed_from_pid'] = previous['pid']
    save(marker, state)
    with (output / f'followup-source-{os.getpid()}.py').open('xb') as stream:
        stream.write(Path(__file__).read_bytes())
    try:
        reviewed = set()
        while True:
            # Inspect every condition on each pass so a failed second condition
            # is not hidden behind a still-running first one.
            for phase in ['control', 'bounded']:
                progress_path = output / phase / 'progress.json'
                if progress_path.exists() and phase not in reviewed:
                    status = json.loads(progress_path.read_text())['status']
                    if status in ['complete', 'completed_with_failures']:
                        recover_phase(output / phase)
                        reviewed.add(phase)
            complete = [phase_complete(output / phase) for phase in ['control', 'bounded']]
            if all(complete):
                break
            time.sleep(20)
        protocol = json.loads((output / 'ledger/manifest.json').read_text())
        verify_sources(protocol)
        audit = audit_requests(wire_rows(output, ['bounded'], protocol['full_input_policy']['scale']), 64000)
        save(output / 'bounded/followup-budget-audit.json', audit)
        if audit['unknown_usage'] or audit['estimated_over_budget'] or audit['actual_over_budget']:
            raise ValueError('Context budget audit needs review; ledger not launched')
        state['status'] = 'ledger_running'
        save(marker, state)
        environment = {**os.environ, 'MODEL_INPUT_TOKEN_BUDGET': '64000',
                       'MODEL_INPUT_TOKEN_SCALE': str(protocol['full_input_policy']['scale']),
                       'MODEL_MAX_CALLS_PER_TURN': str(protocol['max_model_calls_per_turn']), 'PYTHONUNBUFFERED': '1'}
        subprocess.check_call([str(ROOT / '.venv/bin/python'), str(HERE / 'comparison_campaign.py'),
            '--output', str(output), '--phase', 'ledger', '--native-workers', str(workers), '--script-workers', '1'],
            cwd=ROOT, env=environment)
        recover_phase(output / 'ledger')
        if not phase_complete(output / 'ledger'):
            raise ValueError('Ledger phase did not complete')
        state['status'] = 'complete'
    except Exception as error:
        state['status'] = 'stopped_with_error'
        state['error'] = str(error)
        save(marker, state)
        raise
    state['finished_at'] = datetime.now(timezone.utc).isoformat()
    save(marker, state)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--native-workers', type=int, default=2)
    parser.add_argument('--resume', action='store_true', help='Adopt an inactive waiting/failed registration; retain its history')
    args = parser.parse_args()
    if args.native_workers < 1:
        raise ValueError('Worker count must be positive')
    run(args.output, args.native_workers, args.resume)
