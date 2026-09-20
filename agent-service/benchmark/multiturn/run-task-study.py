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
"""Run fresh complete sessions, keeping primary and recovery costs separate.

Source the isolated stack profile before invoking. The model runners read only
session.json; this coordinator scores afterward using gold.json. Never overwrite
an earlier attempt or restart the watched agent service during a campaign.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import random
from pathlib import Path
import runpy
import subprocess
import threading
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--kb-root', type=Path, required=True)
    parser.add_argument('--env-file', type=Path, required=True)
    parser.add_argument('--arms', default='code,tasks')
    parser.add_argument('--families', default='')
    parser.add_argument('--workers', type=int, default=3)
    parser.add_argument('--native-workers', type=int, default=2)
    parser.add_argument('--recovery-rounds', type=int, default=2)
    parser.add_argument('--repeat-all', action='store_true', help='Repeat every session, not only failures.')
    parser.add_argument('--seed', type=int, default=1729)
    args = parser.parse_args()
    arms = args.arms.split(',')
    assert all(arm in ['code', 'coderetain', 'base', 'compact', 'return', 'context', 'tasks', 'reuse', 'maint', 'demand', 'frames'] for arm in arms)
    assert args.workers > 0 and args.native_workers > 0 and args.recovery_rounds >= 0
    fixtures, out, kb_root = args.fixtures.resolve(), args.out.resolve(), args.kb_root.resolve()
    families = args.families.split(',') if args.families else sorted(p.parent.name for p in fixtures.glob('*/session.json'))
    assert families
    out.mkdir(parents=True, exist_ok=False)
    score = runpy.run_path(str(HERE / 'task-study.py'))['score']
    manifest = dict(
        revision=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        started=time.time(), arms=arms, families=families,
        fixtures={family: {name: hashlib.sha256((fixtures / family / name).read_bytes()).hexdigest()
                           for name in ['session.json', 'gold.json']} for family in families},
        recovery_rounds=args.recovery_rounds, repeat_all=args.repeat_all, seed=args.seed,
        code_transport=os.environ.get('TASK_CODE_TRANSPORT', 'responses'), primary=[], recoveries=[],
    )
    for family in families:
        for path in sorted((fixtures / family).glob('*.csv')) + list((fixtures / family).glob('checks.json')):
            manifest['fixtures'][family][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    native_gate = threading.Semaphore(args.native_workers)

    def save():
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2))

    def run(family, arm, label):
        directory = out / label
        if arm in ('code', 'coderetain'):
            command = [str(kb_root / '.venv/bin/python'), str(HERE / 'run-task-code.py'),
                       str(fixtures / family / 'session.json'), str(directory),
                       '--kb-root', str(kb_root), '--env-file', str(args.env_file.resolve()),
                       '--transport', manifest['code_transport']] + (['--retention'] if arm == 'coderetain' else [])
        else:
            command = ['bun', 'run', str(HERE / 'run-task-native.ts'),
                       str(fixtures / family / 'session.json'), str(directory), arm]
        with (native_gate if arm not in ('code', 'coderetain') else threading.Semaphore(1)):
            started = time.time()
            with (out / (label + '.log')).open('w') as log:
                process = subprocess.run(command, cwd=ROOT, env=os.environ, stdout=log, stderr=subprocess.STDOUT)
            directory.mkdir(exist_ok=True)
            summary = score(fixtures / family, directory)
            row = dict(family=family, arm=arm, label=label, exit_code=process.returncode,
                       elapsed_seconds=time.time() - started,
                       **{key: value for key, value in summary.items() if key != 'results'})
            print(json.dumps(row), flush=True)
            return row

    def group(jobs, key):
        random.Random(args.seed).shuffle(jobs)
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(run, *job) for job in jobs]
            for future in concurrent.futures.as_completed(futures):
                manifest[key].append(future.result())
                save()

    save()
    group([(family, arm, f'{arm}-{family}') for family in families for arm in arms], 'primary')
    failed = [row for row in manifest['primary'] if args.repeat_all or row['passed'] != row['tasks'] or row['exit_code']]
    group([(row['family'], row['arm'], f"recovery{attempt}-{row['arm']}-{row['family']}")
           for row in failed for attempt in range(1, args.recovery_rounds + 1)], 'recoveries')
    manifest['finished'] = time.time()
    save()


if __name__ == '__main__':
    main()
