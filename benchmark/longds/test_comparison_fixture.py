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
from collections import defaultdict
import csv
import json

import pytest

import comparison_fixture as fixture


def test_reference_answers_match_raw_inputs_and_revision_semantics(tmp_path, monkeypatch):
    monkeypatch.setattr(fixture, 'ROOT', tmp_path / 'repo')
    folder = fixture.prepare_fixture(tmp_path / 'run')
    data = tmp_path / 'run/controlled-data'
    original = list(csv.DictReader((data / 'orders.csv').open()))
    updated = list(csv.DictReader((data / 'orders_updated.csv').open()))

    def scores(rows, delivered):
        result = defaultdict(int)
        for row in rows:
            if not delivered or row['status'] == 'delivered':
                result[row['unit']] += int(row['amount'])
        return result

    def table(result):
        return {'scores': [{'unit': unit, 'score': result[unit]} for unit in sorted(result)]}

    old = scores(original, True)
    revised = scores(original, False)
    refreshed = scores(updated, False)
    restored = scores(updated, True)
    expected = [table(old), table(revised), {'rows': [
        {'unit': unit, 'original_score': old[unit], 'current_score': revised[unit],
         'current_minus_original': revised[unit]-old[unit]} for unit in sorted(old)]},
        table(refreshed), table(restored), {'historical_score': old['U01'], 'current_score': restored['U01'],
            'current_minus_historical': restored['U01']-old['U01']},
        table({u: 2*restored[u] for u in ['U01', 'U03']}),
        {'scores': [{'unit': u, 'score': restored[u]} for u in sorted(restored, key=lambda u: (-restored[u], u))[:3]]},
    ]
    gold = json.loads((folder / 'gold.json').read_text())
    assert [t['answer'] for t in gold['turns']] == expected
    assert sorted(p.name for p in data.iterdir()) == ['orders.csv', 'orders_updated.csv']
    assert 'ground_truth' not in (folder / 'prompts.json').read_text()


def test_existing_mount_is_preserved_without_creating_partial_inputs(tmp_path, monkeypatch):
    monkeypatch.setattr(fixture, 'ROOT', tmp_path / 'repo')
    mount = fixture.ROOT / 'benchmark/longds/DataMind/longds/dataset/data/longds/synthetic/operator_history/task1/data'
    mount.mkdir(parents=True)
    (mount / 'owned.txt').write_text('another run')
    with pytest.raises(FileExistsError):
        fixture.prepare_fixture(tmp_path / 'run')
    assert (mount / 'owned.txt').read_text() == 'another run'
    assert not (tmp_path / 'run/controlled-data').exists()
