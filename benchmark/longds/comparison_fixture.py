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
"""Reproduce the version-history diagnostic without exposing its reference to solvers."""
import argparse
import csv
import json
from pathlib import Path

from state_comparison import ROOT, build_prompts, save

FIXTURE = {'manifest': {'key': 'synthetic__operator_history__task1',
              'domain': 'synthetic',
              'dataset_name': 'operator_history',
              'task_id': 'task1',
              'data_dir': 'data/longds/synthetic/operator_history/task1/data',
              'files': ['data/longds/synthetic/operator_history/task1/data/orders.csv',
                        'data/longds/synthetic/operator_history/task1/data/orders_updated.csv'],
              'turns': [{'turn_id': 1,
                         'context': 'Use orders.csv. The unit score is the sum of delivered amounts for that '
                                    'unit. Keep a complete working table called scores, with all units and '
                                    'unrounded values. Name the eligible-order calculation eligible so its '
                                    'definition can be revised independently. Keep earlier definitions and '
                                    'results available for later comparisons.',
                         'question': 'Report every unit and its score, ordered by unit.'},
                        {'turn_id': 2,
                         'context': 'Revise eligibility to include all statuses with a nonmissing amount. '
                                    'Other rules remain unchanged. This becomes the current default.',
                         'question': 'Report every unit and its revised score, ordered by unit.'},
                        {'turn_id': 3,
                         'context': 'Compare the complete current working table with the score table as it '
                                    'was in task 1. Include units outside any ranked selection.',
                         'question': 'For every unit report original_score, current_score and '
                                     'current_minus_original, ordered by unit.'},
                        {'turn_id': 4,
                         'context': 'The current input is now orders_updated.csv, containing the source '
                                    'update. Use this file for current calculations. Keep the task-2 '
                                    'all-status eligibility rule. Preserve older source results and their '
                                    'versions.',
                         'question': 'Report every unit and its current score, ordered by unit.'},
                        {'turn_id': 5,
                         'context': 'Restore the eligibility definition from task 1, applying it to the '
                                    'current updated input rather than the historical input. Keep the '
                                    'historical task-1 results unchanged.',
                         'question': 'Report every unit and its restored-rule score on the current input, '
                                     'ordered by unit.'},
                        {'turn_id': 6,
                         'context': 'Inspect the historical task-1 score result and compare it with the '
                                    'current restored-rule result. Historical means the original input as '
                                    'well as the original eligibility definition.',
                         'question': 'For U01 report historical_score, current_score and '
                                     'current_minus_historical.'},
                        {'turn_id': 7,
                         'context': 'For one temporary scenario, double eligible amounts before summing '
                                    'under the current delivered-only rule and current input. Preserve the '
                                    'default calculation and its result.',
                         'question': 'Report scenario scores for U01 and U03, ordered by unit.'},
                        {'turn_id': 8,
                         'context': 'Continue the default analysis after the temporary scenario. Keep the '
                                    'current input and the restored delivered-only eligibility definition.',
                         'question': 'Report the three highest default scores, ordered by score descending '
                                     'and unit ascending.'}]},
 'gold': {'key': 'synthetic__operator_history__task1',
          'turns': [{'turn_id': 1,
                     'context': 'Use orders.csv. The unit score is the sum of delivered amounts for that '
                                'unit. Keep a complete working table called scores, with all units and '
                                'unrounded values. Name the eligible-order calculation eligible so its '
                                'definition can be revised independently. Keep earlier definitions and '
                                'results available for later comparisons.',
                     'question': 'Report every unit and its score, ordered by unit.',
                     'answer': {'scores': [{'unit': 'U01', 'score': 44},
                                           {'unit': 'U02', 'score': 57},
                                           {'unit': 'U03', 'score': 40},
                                           {'unit': 'U04', 'score': 63},
                                           {'unit': 'U05', 'score': 36},
                                           {'unit': 'U06', 'score': 54},
                                           {'unit': 'U07', 'score': 72},
                                           {'unit': 'U08', 'score': 50}]},
                     'state_type': ['Initial'],
                     'depends_tasks': [],
                     'depends_span': []},
                    {'turn_id': 2,
                     'context': 'Revise eligibility to include all statuses with a nonmissing amount. Other '
                                'rules remain unchanged. This becomes the current default.',
                     'question': 'Report every unit and its revised score, ordered by unit.',
                     'answer': {'scores': [{'unit': 'U01', 'score': 54},
                                           {'unit': 'U02', 'score': 57},
                                           {'unit': 'U03', 'score': 60},
                                           {'unit': 'U04', 'score': 63},
                                           {'unit': 'U05', 'score': 66},
                                           {'unit': 'U06', 'score': 69},
                                           {'unit': 'U07', 'score': 72},
                                           {'unit': 'U08', 'score': 75}]},
                     'state_type': ['Update'],
                     'depends_tasks': [1],
                     'depends_span': [1]},
                    {'turn_id': 3,
                     'context': 'Compare the complete current working table with the score table as it was '
                                'in task 1. Include units outside any ranked selection.',
                     'question': 'For every unit report original_score, current_score and '
                                 'current_minus_original, ordered by unit.',
                     'answer': {'rows': [{'unit': 'U01',
                                          'original_score': 44,
                                          'current_score': 54,
                                          'current_minus_original': 10},
                                         {'unit': 'U02',
                                          'original_score': 57,
                                          'current_score': 57,
                                          'current_minus_original': 0},
                                         {'unit': 'U03',
                                          'original_score': 40,
                                          'current_score': 60,
                                          'current_minus_original': 20},
                                         {'unit': 'U04',
                                          'original_score': 63,
                                          'current_score': 63,
                                          'current_minus_original': 0},
                                         {'unit': 'U05',
                                          'original_score': 36,
                                          'current_score': 66,
                                          'current_minus_original': 30},
                                         {'unit': 'U06',
                                          'original_score': 54,
                                          'current_score': 69,
                                          'current_minus_original': 15},
                                         {'unit': 'U07',
                                          'original_score': 72,
                                          'current_score': 72,
                                          'current_minus_original': 0},
                                         {'unit': 'U08',
                                          'original_score': 50,
                                          'current_score': 75,
                                          'current_minus_original': 25}]},
                     'state_type': ['Rollback', 'Counterfactual'],
                     'depends_tasks': [1, 2],
                     'depends_span': [2, 1]},
                    {'turn_id': 4,
                     'context': 'The current input is now orders_updated.csv, containing the source update. '
                                'Use this file for current calculations. Keep the task-2 all-status '
                                'eligibility rule. Preserve older source results and their versions.',
                     'question': 'Report every unit and its current score, ordered by unit.',
                     'answer': {'scores': [{'unit': 'U01', 'score': 154},
                                           {'unit': 'U02', 'score': 57},
                                           {'unit': 'U03', 'score': 60},
                                           {'unit': 'U04', 'score': 63},
                                           {'unit': 'U05', 'score': 66},
                                           {'unit': 'U06', 'score': 69},
                                           {'unit': 'U07', 'score': 72},
                                           {'unit': 'U08', 'score': 75}]},
                     'state_type': ['Update'],
                     'depends_tasks': [2],
                     'depends_span': [2]},
                    {'turn_id': 5,
                     'context': 'Restore the eligibility definition from task 1, applying it to the current '
                                'updated input rather than the historical input. Keep the historical task-1 '
                                'results unchanged.',
                     'question': 'Report every unit and its restored-rule score on the current input, '
                                 'ordered by unit.',
                     'answer': {'scores': [{'unit': 'U01', 'score': 144},
                                           {'unit': 'U02', 'score': 57},
                                           {'unit': 'U03', 'score': 40},
                                           {'unit': 'U04', 'score': 63},
                                           {'unit': 'U05', 'score': 36},
                                           {'unit': 'U06', 'score': 54},
                                           {'unit': 'U07', 'score': 72},
                                           {'unit': 'U08', 'score': 50}]},
                     'state_type': ['Rollback', 'Update'],
                     'depends_tasks': [1, 4],
                     'depends_span': [4, 1]},
                    {'turn_id': 6,
                     'context': 'Inspect the historical task-1 score result and compare it with the current '
                                'restored-rule result. Historical means the original input as well as the '
                                'original eligibility definition.',
                     'question': 'For U01 report historical_score, current_score and '
                                 'current_minus_historical.',
                     'answer': {'historical_score': 44,
                                'current_score': 144,
                                'current_minus_historical': 100},
                     'state_type': ['Rollback', 'Counterfactual'],
                     'depends_tasks': [1, 5],
                     'depends_span': [5, 1]},
                    {'turn_id': 7,
                     'context': 'For one temporary scenario, double eligible amounts before summing under '
                                'the current delivered-only rule and current input. Preserve the default '
                                'calculation and its result.',
                     'question': 'Report scenario scores for U01 and U03, ordered by unit.',
                     'answer': {'scores': [{'unit': 'U01', 'score': 288}, {'unit': 'U03', 'score': 80}]},
                     'state_type': ['Counterfactual'],
                     'depends_tasks': [5],
                     'depends_span': [2]},
                    {'turn_id': 8,
                     'context': 'Continue the default analysis after the temporary scenario. Keep the '
                                'current input and the restored delivered-only eligibility definition.',
                     'question': 'Report the three highest default scores, ordered by score descending and '
                                 'unit ascending.',
                     'answer': {'scores': [{'unit': 'U01', 'score': 144},
                                           {'unit': 'U07', 'score': 72},
                                           {'unit': 'U04', 'score': 63}]},
                     'state_type': ['Initial'],
                     'depends_tasks': [5, 7],
                     'depends_span': [3, 1]}]},
 'amounts': [[20, 24, 10],
             [20, 20, 17],
             [20, 20, 20],
             [21, 21, 21],
             [18, 18, 30],
             [27, 27, 15],
             [24, 24, 24],
             [25, 25, 25]],
 'cancelled_last_units': [1, 3, 5, 6, 8]}

def prepare_fixture(output):
    output = Path(output).resolve()
    mount = ROOT / "benchmark/longds/DataMind/longds/dataset/data/longds/synthetic/operator_history/task1/data"
    if mount.exists() or mount.is_symlink():
        raise FileExistsError("Diagnostic data mount already exists; preserve its owning run")
    folder = output / "prepared" / FIXTURE["manifest"]["key"]
    if folder.exists():
        raise FileExistsError("Prepared diagnostic already exists; preserve its owning run")
    data = output / "controlled-data"
    data.mkdir(parents=True, exist_ok=False)
    records = [{"unit": f"U{i:02d}", "status": "cancelled" if j == 2 and i in FIXTURE["cancelled_last_units"] else "delivered", "amount": value}
               for i, values in enumerate(FIXTURE["amounts"], 1) for j, value in enumerate(values)]
    for name, rows in [("orders.csv", records), ("orders_updated.csv", records + [{"unit": "U01", "status": "delivered", "amount": 100}])]:
        with (data / name).open("x") as stream:
            writer = csv.DictWriter(stream, fieldnames=["unit", "status", "amount"])
            writer.writeheader()
            writer.writerows(rows)
    mount.parent.mkdir(parents=True, exist_ok=True)
    mount.symlink_to(data, target_is_directory=True)
    save(folder / "manifest.json", FIXTURE["manifest"])
    save(folder / "gold.json", FIXTURE["gold"])
    save(folder / "prompts.json", build_prompts(FIXTURE["manifest"]))
    return folder

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    prepare_fixture(parser.parse_args().output)
