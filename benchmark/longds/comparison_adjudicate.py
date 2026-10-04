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
"""Recover missing judge verdicts without changing a solver or its artifacts.

Every unjudged answer gets at most one further call to the same judge/prompt,
with a 16k reply cap. Existing binary scores are never revisited. Original
failed responses remain in results_eval.json; a hash-bound sidecar records the
additional attempt, including another failure. Recovery costs are judge costs.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile

from judge_longds import UPSTREAM_PROMPT, judge_one, load_judge_prompt

POLICY = {'name': 'missing_judge_only_16k_once_v1', 'max_tokens': 16000, 'retries': 1,
          'selection': 'All missing verdicts, no existing binary scores or solver retries'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_once(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(body, indent=2, ensure_ascii=False) + '\n'
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
        # Publish a complete receipt atomically and refuse replacement. The
        # temporary is on the same filesystem, so linking cannot expose a prefix.
        os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def resolved_rows(folder):
    path = folder / 'results_eval.json'
    if not path.exists():
        path = folder / 'results_with_ground_truth.json'
    if not path.exists():
        return []
    rows = json.loads(path.read_text())
    overlay = folder / 'judge-recovery.json'
    if not overlay.exists():
        return rows
    data = json.loads(overlay.read_text())
    if path.name != 'results_eval.json' or sha(path) != data['results_sha256']:
        raise ValueError('Judge recovery no longer matches the original results')
    by_id = {row['turn_id']: row for row in rows}
    if len(by_id) != len(rows):
        raise ValueError('Duplicate original turn IDs')
    seen = set()
    for record in data['recoveries']:
        tid = record['turn_id']
        if tid in seen or tid not in by_id or by_id[tid].get('judge', {}).get('score') is not None:
            raise ValueError('Recovery may only fill one missing verdict per turn')
        seen.add(tid)
        verdict = record['verdict']
        if verdict.get('score') not in (None, 0, 1):
            raise ValueError('Invalid recovered binary score')
        row = by_id[tid]
        row['judge_original'] = row.get('judge')
        row['judge'] = verdict
        row['judge_recovered'] = verdict.get('score') is not None
        row['judge_recovery_policy'] = data.get('policy')
        row['judge_recovery_cache_reused'] = record.get('cache_reused', False)
    return rows


def recover_folder(folder, cache, client, model, prompt):
    original = folder / 'results_eval.json'
    if not original.exists():
        return 0
    overlay = folder / 'judge-recovery.json'
    if overlay.exists():
        resolved_rows(folder)
        return 0
    rows = json.loads(original.read_text())
    missing = [row for row in rows if row.get('judge', {}).get('score') is None]
    if not missing:
        return 0
    prompt_sha = hashlib.sha256(prompt.encode()).hexdigest()
    records = []
    for row in missing:
        identity = [POLICY, model, prompt_sha, row['context'], row['question'], row['ground_truth'], row['solution']]
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        target = cache / (key + '.json')
        intent = cache / (key + '.started.json')
        reused = target.exists()
        if reused:
            verdict = json.loads(target.read_text())
        else:
            # An interrupted paid request is not silently replayed. Its intent
            # remains for inspection even if there is no response receipt.
            write_once(intent, {'model': model, 'prompt_sha256': prompt_sha, 'policy': POLICY,
                               'started_at': datetime.now(timezone.utc).isoformat()})
            verdict = judge_one(client, model, prompt, row, retries=1, max_tokens=16000)
            write_once(target, verdict)
        records.append({'turn_id': row['turn_id'], 'verdict': verdict,
                        'cache_key': key, 'verdict_sha256': sha(target), 'cache_reused': reused})
    write_once(overlay, {'results_sha256': sha(original), 'policy': POLICY, 'model': model,
                        'prompt_sha256': prompt_sha, 'source_sha256': sha(__file__),
                        'created_at': datetime.now(timezone.utc).isoformat(), 'recoveries': records})
    resolved_rows(folder)
    return len(records)


def recover_phase(folder):
    from dotenv import load_dotenv
    from openai import OpenAI
    from state_comparison import verify_sources
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root / '.env', override=False)
    protocol = json.loads((folder / 'manifest.json').read_text())
    verify_sources(protocol)
    prompt = load_judge_prompt()
    if sha(UPSTREAM_PROMPT) != protocol['judge_prompt_sha256']:
        raise ValueError('Judge prompt differs from the frozen protocol')
    # Freeze a readable recovery policy/source independently of solver sources.
    registration = folder / 'judge-recovery-policy.json'
    if not registration.exists():
        write_once(registration, {'policy': POLICY, 'model': protocol['judge'],
                                 'source_sha256': sha(__file__), 'protocol_sha256': sha(folder / 'manifest.json')})
        (folder / 'judge-recovery-source.py').write_bytes(Path(__file__).read_bytes())
    else:
        saved = json.loads(registration.read_text())
        if (saved['policy'] != POLICY or saved['model'] != protocol['judge']
                or saved['protocol_sha256'] != sha(folder / 'manifest.json')):
            raise ValueError('Registered recovery policy/model/protocol differs')
    # Preserve the original source registration and every later implementation
    # version. Changing receipt publication does not change judge selection/caps.
    version = folder / f'judge-recovery-policy-{sha(__file__)}.json'
    if not version.exists():
        write_once(version, {'policy': POLICY, 'model': protocol['judge'], 'source_sha256': sha(__file__),
                             'protocol_sha256': sha(folder / 'manifest.json')})
        with version.with_suffix('.py').open('xb') as stream:
            stream.write(Path(__file__).read_bytes())
    client = OpenAI(base_url='https://openrouter.ai/api/v1', api_key=os.environ['OPENROUTER_API_KEY'], max_retries=0)
    # One phase recovery controller at a time, with immutable attempt receipts.
    lock = folder / 'judge-recovery.lock'
    with lock.open('x') as stream:
        stream.write(str(os.getpid()))
    try:
        recovered = 0
        for job in protocol['jobs']:
            dest = folder / 'runs' / f"{job['arm']}-r{job['rep']}" / job['task'].replace('/', '__')
            recovered += recover_folder(dest, folder.parent / 'judge-recovery-cache', client, protocol['judge'], prompt)
        print(json.dumps({'phase': folder.name, 'additional_verdicts_attempted': recovered, 'policy': POLICY['name']}))
    finally:
        lock.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    recover_phase(parser.parse_args().folder.resolve())
