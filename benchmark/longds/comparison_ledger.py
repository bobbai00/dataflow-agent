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
"""Predeclare the ledger arm with all already-frozen bounded history controls.

Reuse is chosen before their outcomes are known. Every control repetition is
retained, including wrong answers. Comparison costs include those controls;
new experiment spending excludes calls already made in the bounded phase.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import random

from state_comparison import ROOT, digest, save, verify_sources


def freeze(output):
    output = output.resolve()
    target = output / 'ledger'
    if target.exists():
        raise FileExistsError(target)
    control_path = output / 'bounded/manifest.json'
    control = json.loads(control_path.read_text())
    verify_sources(control)
    if control['full_input_policy']['budget_tokens'] != 64000:
        raise ValueError('Ledger requires the predeclared 64k bounded comparison')
    jobs = []
    for job in control['jobs']:
        if job['arm'] != 'history':
            continue
        settings = job['settings']
        if not settings['stateHistory'] or settings['stateLedger']:
            raise ValueError('Control must expose history without a ledger')
        source = output / 'bounded/runs' / f"history-r{job['rep']}" / job['task'].replace('/', '__')
        jobs.append({**job, 'phase': 'ledger', 'reuse_from': str(source)})
        jobs.append({**job, 'phase': 'ledger', 'arm': 'ledger', 'settings': {**settings, 'stateLedger': True}})
    if not jobs:
        raise ValueError('No predeclared history controls')
    random.Random(103).shuffle(jobs)
    own_source = str(Path(__file__).relative_to(ROOT))
    protocol = {**control, 'phase': 'ledger', 'created_at': datetime.now(timezone.utc).isoformat(),
                'jobs': jobs, 'source_hashes': {**control['source_hashes'], own_source: digest(__file__)},
                'reused_control_protocol_sha256': digest(control_path),
                'reuse_policy': 'All bounded history repetitions, predeclared without outcome selection; no solver replay',
                'new_solver_jobs': sum('reuse_from' not in job for job in jobs),
                'new_solver_turns': sum(job['turns_total'] for job in jobs if 'reuse_from' not in job)}
    for name, sha in protocol['source_hashes'].items():
        path = target / 'source' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write((ROOT / name).read_bytes())
        if digest(path) != sha:
            raise RuntimeError(f'Source changed while freezing: {name}')
    save(target / 'manifest.json', protocol)
    print(f"Frozen ledger: {protocol['new_solver_jobs']} new jobs / {protocol['new_solver_turns']} new turns; all matched bounded history controls reused")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    freeze(parser.parse_args().output)
