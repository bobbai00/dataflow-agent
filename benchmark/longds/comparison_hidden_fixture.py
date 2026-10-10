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
"""A separate history diagnostic whose later queries cannot use visible previews."""
import argparse
from collections import defaultdict
import copy
import csv
from datetime import datetime, timezone
import json
from pathlib import Path
import random

from comparison_fixture import FIXTURE
from state_comparison import ROOT, arm_settings, build_prompts, digest, make_jobs, save, verify_sources

TASK = 'synthetic/operator_history/task2'
TARGETS = ['U3241', 'U3245', 'U3249', 'U3381', 'U3397', 'U3511']
REFRESHED_UNIT = 'U3245'


def fixture_data():
    rng = random.Random(103)
    rows = [{'unit': f'U{i:04d}', 'status': 'cancelled' if j == 2 and i % 2 else 'delivered',
             'amount': rng.randint(1, 120)} for i in range(1, 6001) for j in range(3)]
    updated = rows + [{'unit': REFRESHED_UNIT, 'status': 'delivered', 'amount': 10000}]

    def scores(source, delivered):
        result = defaultdict(int)
        for row in source:
            if not delivered or row['status'] == 'delivered':
                result[row['unit']] += row['amount']
        return result

    original = scores(rows, True)
    revised = scores(rows, False)
    current = scores(updated, False)
    restored = scores(updated, True)

    def leading(values, n=5):
        return {'scores': [{'unit': u, 'score': values[u]} for u in sorted(values, key=lambda u: (-values[u], u))[:n]]}

    assert not set(TARGETS) & {r['unit'] for r in leading(original)['scores']+leading(revised)['scores']}
    manifest = copy.deepcopy(FIXTURE['manifest'])
    manifest.update(key=TASK.replace('/', '__'), task_id='task2', data_dir='data/longds/'+TASK+'/data')
    manifest['files'] = [manifest['data_dir']+'/'+n for n in ['orders.csv', 'orders_updated.csv']]
    turns = manifest['turns']
    for index in [0, 1, 3, 4]:
        turns[index]['question'] = 'Report the five highest scores, ordered by score descending and unit ascending.'
    turns[2]['question'] = ('For '+', '.join(TARGETS)+
                           ', report original_score, current_score and current_minus_original, ordered by unit.')
    turns[5]['question'] = f'For {REFRESHED_UNIT} report historical_score, current_score and current_minus_historical.'
    turns[6]['question'] = f'Report scenario scores for {REFRESHED_UNIT} and U3381, ordered by unit.'
    answers = [leading(original), leading(revised), {'rows': [
        {'unit': u, 'original_score': original[u], 'current_score': revised[u],
         'current_minus_original': revised[u]-original[u]} for u in TARGETS]},
        leading(current), leading(restored), {'historical_score': original[REFRESHED_UNIT],
            'current_score': restored[REFRESHED_UNIT],
            'current_minus_historical': restored[REFRESHED_UNIT]-original[REFRESHED_UNIT]},
        {'scores': [{'unit': u, 'score': 2*restored[u]} for u in [REFRESHED_UNIT, 'U3381']]}, leading(restored, 3)]
    gold = {'key': manifest['key'], 'turns': [{**t, 'answer': answers[i],
            **{k: FIXTURE['gold']['turns'][i][k] for k in ['state_type', 'depends_tasks', 'depends_span']}}
            for i, t in enumerate(turns)]}
    return manifest, gold, rows, updated


def prepare(output):
    output = Path(output).resolve()
    phase = output / 'hidden-history'
    manifest, gold, rows, updated = fixture_data()
    data = output / 'hidden-history-data'
    mount = ROOT / 'benchmark/longds/DataMind/longds/dataset' / manifest['data_dir']
    prepared = output / 'prepared' / manifest['key']
    if any(p.exists() or p.is_symlink() for p in [phase, data, mount, prepared]):
        raise FileExistsError('Hidden-row diagnostic already exists; preserve its owning run')
    protocol = json.loads((output / 'holdout/manifest.json').read_text())
    verify_sources(protocol)
    data.mkdir()
    for name, values in [('orders.csv', rows), ('orders_updated.csv', updated)]:
        with (data / name).open('x') as stream:
            writer = csv.DictWriter(stream, fieldnames=['unit', 'status', 'amount'])
            writer.writeheader()
            writer.writerows(values)
    mount.parent.mkdir(parents=True, exist_ok=True)
    mount.symlink_to(data, target_is_directory=True)
    save(prepared / 'manifest.json', manifest)
    save(prepared / 'gold.json', gold)
    save(prepared / 'prompts.json', build_prompts(manifest))
    jobs = make_jobs([TASK], ['dsgym', 'baseline', 'history'], 3, phase='hidden-history')
    for job in jobs:
        job.update(turns_total=8, settings=None if job['arm']=='dsgym' else arm_settings(job['arm']))
    protocol.update(phase='hidden-history', created_at=datetime.now(timezone.utc).isoformat(), jobs=jobs,
        prompt_hashes={TASK: digest(prepared/'prompts.json')},
        prepared_hashes={TASK: {n: digest(prepared/n) for n in ['manifest.json', 'gold.json', 'prompts.json']}},
        input_files={n: {'bytes': (ROOT/n).stat().st_size, 'mtime_ns': (ROOT/n).stat().st_mtime_ns,
                         'sha256': digest(ROOT/n)} for n in manifest['files']}, excluded_preflight_sessions=[],
        diagnostic='6000 working rows; top-five reports exclude later queried rows; not an official LongDS task')
    extra = [Path(__file__), Path(__file__).with_name('comparison_fixture.py'),
             Path(__file__).with_name('execution_isolation.py'),
             ROOT/'benchmark/longds/DataMind/longds/runners/DSGym/executors/container_images/longds_image/kernel_executor.py']
    extra += list((ROOT/'agent-service/src/agent/native/python').glob('*.py'))
    for source in extra:
        protocol['source_hashes'][str(source.relative_to(ROOT))] = digest(source)
    for name, sha in protocol['source_hashes'].items():
        archive = phase / 'source' / name
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes((ROOT/name).read_bytes())
        assert digest(archive)==sha
    save(phase/'manifest.json', protocol)
    print('Frozen hidden-row diagnostic: 6000 units, 9 jobs, 72 turns')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    prepare(parser.parse_args().output)
