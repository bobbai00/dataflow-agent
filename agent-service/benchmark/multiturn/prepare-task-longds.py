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
"""Real LongDS session with an explicit, shared JSON answer contract.

This is a deterministic research adaptation, not an official LongDS score.
Only public context, questions, file inventory, and the contracts below enter
session.json. Gold values and dependency annotations stay in gold.json.
"""
import argparse
import json
from pathlib import Path

CONTRACTS = [
    'Array of objects with language, total_issues, in the requested ranking order.',
    'Object with yearly_data (array of year, total_issues; year ascending) and highest_total_issues_year (object with year, total_issues).',
    'Array of objects with language, issues_2021, in the requested ranking order.',
    'Array of objects with language, share_2011, share_2021, change. List the three positive changes descending, followed by the three negative changes ascending.',
    'Object with languages (array of language, first_half_avg, second_half_avg, growth_rate; language ascending) and overall_growth_rate.',
    'Array of objects with language, total_prs, in the requested ranking order.',
    'Object with yearly_data (array of year, total_prs, yoy_increase; year ascending; first increase null), max_increase_year, max_increase_amount.',
    'Array of objects with language, issues_rank, prs_rank, composite_score, in the requested ranking order.',
    'Array of objects with language, share_2011, share_2021, change. List the three positive changes descending, followed by the three negative changes ascending.',
    'Array of objects with language, issues_share_growth, total_prs; total_prs descending, language ascending for ties.',
    'Object with mean, median, std, min, max, q25, q75, iqr.',
    'Array of objects with language, num_repos, in the requested ranking order.',
    'Object with highest_activity_density_language (object with language, activity_density, gap_vs_average), avg_density, and languages (array of language, num_repos, total_issues, total_prs, activity_density; density descending, language ascending for ties).',
    'Object with slope, intercept, r_squared, top3_positive_residual, top3_negative_residual. Each residual list contains language, total_prs, predicted_prs, residual; positive list descending, negative list ascending, language ascending for ties.',
    'Object with classification (array of language, issues_share_change, pr_share_change, num_repos, category; category then language ascending) and avg_repos_by_category (object mapping each nonempty category to its mean). Category spellings: dual-rising, dual-declining, mixed.',
]


def prepare(source, destination):
    manifest = json.loads((source / 'manifest.json').read_text())
    assert manifest['key'] == 'community__github_programming_languages_data__task1'
    assert len(manifest['turns']) == len(CONTRACTS)
    destination.mkdir(parents=True, exist_ok=False)
    public = []
    for task, contract in zip(manifest['turns'], CONTRACTS):
        inventory = ('Available files:\n' + '\n'.join(manifest['files']) + '\n\n') if not public else ''
        prompt = inventory + task['context'] + '\n\n' + task['question'] + '\n\nReturn only JSON. Answer format: ' + contract
        public.append(dict(id=str(task['turn_id']), prompt=prompt))
    (destination / 'session.json').write_text(json.dumps(dict(family='longds_github', files=manifest['files'], turns=public), indent=2))
    gold = [task['answer'] for task in json.loads((source / 'gold.json').read_text())['turns']]
    # Drop upstream presentation metadata that the questions do not request.
    gold[6] = {key: value for key, value in gold[6].items() if key != 'answer_type'}
    gold[10] = gold[10]['stats']
    gold[13] = {key: value for key, value in gold[13].items() if key != 'answer_type'}
    (destination / 'gold.json').write_text(json.dumps(gold, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    prepare(args.source, args.destination)
