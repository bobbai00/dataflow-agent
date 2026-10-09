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
"""Supplemental matched cost analysis without changing solver outcomes."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re


def script_turn_metrics(folder):
    trajectory, turns = folder / 'agent/traj.json', folder / 'agent/turns.json'
    if not trajectory.exists() or not turns.exists():
        return {}
    prompts = {message['content']: turn['turn_id']
               for turn in json.loads(turns.read_text()) for message in turn.get('prompt', [])
               if message.get('role') == 'user' and isinstance(message.get('content'), str)}
    metrics, current = {}, None
    for message in json.loads(trajectory.read_text()).get('conversation', []):
        content = message.get('content')
        if not isinstance(content, str):
            continue
        if message.get('role') == 'user' and content in prompts:
            current = prompts[content]
            metrics[current] = {'python_blocks': 0, 'execution_observations': 0}
        elif current is not None and message.get('role') == 'assistant':
            metrics[current]['python_blocks'] += sum(bool(code.strip()) for code in
                re.findall(r'<python>(.*?)</python>', content, re.DOTALL))
        elif current is not None and message.get('role') == 'user':
            metrics[current]['execution_observations'] += (
                '<information>' in content and 'No python code found.' not in content)
    return metrics


def turn_behavior(row, metrics):
    if metrics is None:
        return 'unknown_trace'
    if row.get('score') is None:
        return 'unjudged'
    if metrics['python_blocks'] or metrics['execution_observations']:
        return 'code_attempted'
    if row['score'] == 1:
        return 'correct_without_code'
    solution = row.get('solution')
    if solution is None or (isinstance(solution, str) and not solution.strip()):
        return 'no_code_nonanswer'
    if isinstance(solution, str):
        try:
            solution = json.loads(solution)
        except ValueError:
            pass
    if isinstance(solution, dict) and solution.get('error'):
        return 'no_code_nonanswer'
    return 'wrong_without_code'


def cost_summary(rows):
    result = {'turns': len(rows), 'judged': sum(r.get('score') is not None for r in rows),
              'correct': sum(r.get('score') == 1 for r in rows),
              'llm_calls': sum((r.get('stats') or {}).get('llm_calls', 0) for r in rows)}
    for name, getter in [('recorded_cost_usd', lambda r: (r.get('stats') or {}).get('cost_usd')),
                         ('uniform_cost_usd', lambda r: r.get('uniform_cost_usd'))]:
        values = [getter(r) for r in rows]
        result[name] = sum(value for value in values if value is not None)
        result['unknown_'+name.replace('_usd', '_turns')] = sum(value is None for value in values)
    result['uniform_cost_per_correct_answer'] = (result['uniform_cost_usd']/result['correct']
        if result['correct'] and result['judged'] == result['turns'] and not result['unknown_uniform_cost_turns'] else None)
    return result


def paired_costs(rows, a, b):
    grouped = defaultdict(dict)
    for row in rows:
        grouped[(row['task'], row['rep'], row['turn_id'])][row['arm']] = row
    common = {key: arms for key, arms in grouped.items() if all(
        arm in arms and arms[arm].get('score') is not None for arm in [a, b])}
    prefix = set()
    sessions = defaultdict(list)
    for key in common:
        sessions[key[:2]].append(key)
    for keys in sessions.values():
        previous = 0
        for key in sorted(keys):
            if key[2] != previous+1 or any(common[key][arm]['score'] != 1 for arm in [a, b]):
                break
            prefix.add(key)
            previous = key[2]
    selections = {
        'all_paired': list(common),
        'both_correct': [key for key, pair in common.items() if all(pair[arm]['score'] == 1 for arm in [a, b])],
        'both_correct_consecutive_prefix': sorted(prefix),
    }
    if 'dsgym' in [a, b]:
        selections['script_code_attempted'] = [key for key, pair in common.items()
            if pair['dsgym'].get('script_behavior') == 'code_attempted']
        selections['excluding_script_no_code_nonanswers'] = [key for key, pair in common.items()
            if pair['dsgym'].get('script_behavior') in ['code_attempted', 'correct_without_code', 'wrong_without_code']]
    return {name: {arm: cost_summary([common[key][arm] for key in keys]) for arm in [a, b]}
            for name, keys in selections.items()}


def analyze_cost(folder, report):
    rows = [dict(row) for row in report['turns']]
    traces = {}
    for row in rows:
        if row['arm'] != 'dsgym':
            continue
        key = (row['task'], row['rep'])
        if key not in traces:
            path = folder / 'runs' / f"dsgym-r{row['rep']}" / row['task'].replace('/', '__')
            traces[key] = script_turn_metrics(path)
        row['script_metrics'] = traces[key].get(row['turn_id'])
        row['script_behavior'] = turn_behavior(row, row['script_metrics'])
    behavior = defaultdict(list)
    for row in rows:
        if row['arm'] == 'dsgym':
            behavior[row['script_behavior']].append(row)
    arms = sorted({r['arm'] for r in rows})
    return {'analysis_source_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'base_report_analysis_source_sha256': report.get('analysis_source_sha256'),
            'policy': {
                'official_outcomes_and_spend': 'unchanged; all attempts retained',
                'matching': 'same task, repetition and turn; both judgments available',
                'no_code_nonanswer': 'score 0, no Python block or execution observation, and explicit JSON error or empty answer',
                'consecutive_prefix': 'all answers from turn 1 through this turn correct in both arms; not verification of latent state',
                'interpretation': 'conditional descriptive analysis, not an isolated causal effect; earlier skipped work can affect later cost',
            },
            'all_observed': {arm: cost_summary([r for r in rows if r['arm'] == arm]) for arm in arms},
            'script_behavior': {name: cost_summary(rs) for name, rs in sorted(behavior.items())},
            'pairs': {a+'__'+b: paired_costs(rows, a, b) for i, a in enumerate(arms) for b in arms[i+1:]},
            'script_turns': [{k: row.get(k) for k in ['task', 'rep', 'turn_id', 'score', 'script_behavior', 'script_metrics']}
                             for row in rows if row['arm'] == 'dsgym']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    args = parser.parse_args()
    report = json.loads((args.folder / 'report.json').read_text())
    result = analyze_cost(args.folder, report)
    (args.folder / 'cost-analysis.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'script_turns'}, indent=2))


if __name__ == '__main__':
    main()
