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
"""Read-only paired reports for the frozen scope pilot; never pool benchmarks."""
import argparse
from collections import defaultdict
import gzip
import json
import math
from pathlib import Path
import re
import statistics

from comparison_report import build_report
from state_comparison import save, digest, cost_of


def paired_cases(rows):
    pairs = defaultdict(dict)
    for row in rows:
        pairs[(row['task'], row['rep'], row['turn_id'])][row['arm']] = row
    cases = []
    for identity, arms in sorted(pairs.items()):
        if not all(arm in arms and arms[arm].get('score') is not None for arm in ['before', 'after']):
            continue
        a, b = arms['before'], arms['after']
        category = ('after_only' if b['score'] > a['score'] else 'before_only' if a['score'] > b['score']
                    else 'both_correct' if a['score'] == 1 else 'both_incorrect')
        costs = {arm: arms[arm]['stats'].get('cost_usd') for arm in ['before', 'after']}
        cases.append({'task': identity[0], 'rep': identity[1], 'turn_id': identity[2],
                      'category': category, 'scores': {arm: arms[arm]['score'] for arm in costs},
                      'costs': costs, 'state_type': a.get('state_type'), 'question': a.get('question')})
    return cases


def distribution(values):
    known = sorted(float(value) for value in values
                   if isinstance(value, (int, float)) and math.isfinite(value))
    def percentile(fraction):
        position = (len(known) - 1) * fraction
        low, high = math.floor(position), math.ceil(position)
        return known[low] + (known[high] - known[low]) * (position - low)
    return {'known': len(known), 'unknown': len(values) - len(known),
            'sum': sum(known), 'mean': statistics.mean(known) if known else None,
            'median': statistics.median(known) if known else None,
            'p90': percentile(.9) if known else None,
            'max': max(known) if known else None}


def descriptive_metrics(rows, benchmark):
    """Keep timing/answer coverage independent of judging; do not mix score types."""
    arms = {}
    for arm in sorted({row['arm'] for row in rows}):
        selected = [row for row in rows if row['arm'] == arm]
        arms[arm] = {
            'observed_turns': len(selected),
            'empty_answers': sum(not str(row.get('solution') or '').strip() for row in selected),
            'runtime_failures': sum(row.get('success') is False for row in selected),
            'unknown_runtime_status': sum(row.get('success') is None for row in selected),
            'latency': distribution([(row.get('stats') or {}).get('elapsed_seconds') for row in selected]),
        }
        if benchmark == 'krama':
            groups = defaultdict(list)
            for row in selected:
                verdict = row.get('judge') or {}
                groups[verdict.get('answer_type', 'unknown')].append(verdict.get('evaluation') or {})
            metric_names = {'numeric_exact': 'success', 'string_exact': 'success',
                            'numeric_approximate': 'rae_score', 'list_exact': 'f1'}
            arms[arm]['official_metrics'] = {
                kind: {'metric': metric_names.get(kind),
                       **distribution([evaluation.get(metric_names.get(kind)) for evaluation in evaluations])}
                for kind, evaluations in groups.items()}
    pairs = defaultdict(dict)
    for row in rows:
        if all(key in row for key in ['task', 'rep', 'turn_id']):
            pairs[(row['task'], row['rep'], row['turn_id'])][row['arm']] = row
    common = [pair for pair in pairs.values() if all(arm in pair for arm in ['before', 'after'])]
    differences = []
    for pair in common:
        times = [(pair[arm].get('stats') or {}).get('elapsed_seconds') for arm in ['before', 'after']]
        differences.append(times[1] - times[0] if all(
            isinstance(value, (int, float)) and math.isfinite(value) for value in times) else None)
    return {'arms': arms, 'paired_latency': {'pairs': len(common),
            'after_minus_before_seconds': distribution(differences),
            'policy': 'Same task/repetition/turn; includes failures and unjudged answers'}}


def interrupted_spend(study):
    """A replacement never erases money spent on the externally interrupted attempt."""
    registration = json.loads((study / 'interrupt-recovery-20261004.json').read_text())
    result = {}
    for record in registration['recovery']:
        folder = Path(record['original'])
        file = folder / 'results_with_ground_truth.json'
        rows = json.loads(file.read_text()) if file.exists() else []
        costs = [stats.get('cost_usd') if 'cost_usd' in stats else cost_of(stats)
                 for row in rows for stats in [row.get('stats') or {}]]
        saved = {row['turn_id'] for row in rows}
        unfinished = sorted(int(path.parent.name[1:]) for path in folder.glob('t*/prompt.txt')
                            if path.parent.name[1:].isdigit() and int(path.parent.name[1:]) not in saved)
        result[record['arm']] = {
            'original_attempt': str(folder), 'saved_turns': len(rows),
            'known_saved_cost_usd': sum(value for value in costs if value is not None),
            'saved_turns_with_unknown_cost': sum(value is None for value in costs),
            'started_questions_without_receipts': len(unfinished),
            'unrecorded_question_ids': unfinished,
            'policy': 'Saved spend is a lower bound; interrupted requests without usage receipts remain unknown',
        }
    return result


def judge_spend(study):
    """Shared verdicts are paid once, even when many answers reuse their receipt."""
    result = {'unique_verdict_receipts': 0, 'recorded_calls': 0,
              'known_provider_cost_usd': 0, 'calls_with_unknown_cost': 0,
              'failed_calls_without_usage_receipts': 0, 'pending_or_interrupted_requests': 0,
              'policy': 'Provider-reported usage.cost, counted once per cached receipt; missing usage and active requests stay unknown'}
    for cache in [study / 'judge-cache', study / 'judge-recovery-cache']:
        for file in cache.glob('*.json'):
            if file.name.endswith('.started.json'):
                result['pending_or_interrupted_requests'] += not file.with_name(
                    file.name.replace('.started.json', '.json')).exists()
                continue
            receipt = json.loads(file.read_text())
            result['unique_verdict_receipts'] += 1
            result['failed_calls_without_usage_receipts'] += str(
                receipt.get('error_detail') or '').startswith('judge call failed:')
            for usage in receipt.get('usage', []):
                result['recorded_calls'] += 1
                cost = usage.get('cost')
                if cost is None:
                    result['calls_with_unknown_cost'] += 1
                else:
                    result['known_provider_cost_usd'] += cost
        result['pending_or_interrupted_requests'] += len(list(cache.glob('*.lock')))
    return result


def attempt_path(study, benchmark, job, recovered=False):
    original = study / f"{benchmark}-{job['arm']}" / 'runs' / f"{job['arm']}-r{job['rep']}" / job['task'].replace('/', '__')
    registration = study / 'interrupt-recovery-20261004.json'
    if not recovered or benchmark != 'longds' or not registration.exists():
        return original
    records = json.loads(registration.read_text())['recovery']
    if {record['arm'] for record in records} != {'before', 'after'}:
        raise ValueError('Both conditions must have interruption recovery registered')
    matches = [record for record in records if record['arm'] == job['arm'] and Path(record['original']) == original]
    if len(matches) > 1:
        raise ValueError('Duplicate interruption recovery')
    return (study / matches[0]['recovery_phase'] / 'runs' / f"{job['arm']}-r{job['rep']}" / job['task'].replace('/', '__')
            if matches else original)


def validate_settings(before, after):
    def configurations(protocol):
        return {(job['task'], job['rep']): job['settings'] for job in protocol['jobs']}
    if configurations(before) != configurations(after):
        raise ValueError('Unmatched condition settings')


def scope_metrics(path):
    counts = defaultdict(int)
    for file in sorted(path.glob('t*/react_steps.json.gz')):
        counts['trace_turns'] += 1
        steps = json.loads(gzip.decompress(file.read_bytes()))['steps']
        for step in steps:
            counts['model_calls'] += step.get('role') == 'agent'
            for call in step.get('toolCalls', []):
                for action in call.get('input', {}).get('actions', []):
                    if action.get('type') == 'edit':
                        kinds = re.findall(r'^\s*(?:create|update) operator\s+\w+\s*:\s*(\w+)\s*\(',
                                           action.get('changes', ''), re.MULTILINE)
                        for kind in kinds:
                            counts['definition_attempt_' + kind] += 1
            for result in step.get('toolResults', []):
                output = result.get('output')
                if not isinstance(output, dict):
                    continue
                for item in output.get('actions', []):
                    details = item.get('output')
                    if not isinstance(details, dict):
                        continue
                    for block in details.get('operator_blocks', []):
                        lines = block.get('scope') or []
                        counts['scope_blocks'] += bool(lines)
                        counts['scope_characters'] += sum(len(line) for line in lines)
                        for line in lines:
                            counts['scope_facts_' + line.split(' ', 1)[0]] += 1
    return dict(counts)


def report(study, benchmark, recovered=False):
    folder = study / ('reports-with-recovery' if recovered else 'reports') / benchmark
    folder.mkdir(parents=True, exist_ok=True)
    before = json.loads((study / f'{benchmark}-before/manifest.json').read_text())
    after = json.loads((study / f'{benchmark}-after/manifest.json').read_text())
    for field in ['model', 'full_input_policy', 'prompt_hashes', 'prepared_hashes', 'input_files', 'source_hashes']:
        if before[field] != after[field]:
            raise ValueError(f'Unmatched paired pilot: {field}')
    validate_settings(before, after)
    jobs = before['jobs'] + after['jobs']
    for job in jobs:
        source = attempt_path(study, benchmark, job, recovered)
        destination = folder / 'runs' / f"{job['arm']}-r{job['rep']}" / job['task'].replace('/', '__')
        if not source.exists():
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink():
            if destination.resolve() != source.resolve():
                raise ValueError('Report view points at another attempt')
        elif destination.exists():
            raise ValueError('Report view would overwrite an attempt')
        else:
            destination.symlink_to(source.resolve(), target_is_directory=True)
    save(folder / 'manifest.json', {**before, 'phase': f'{benchmark}-paired-report', 'jobs': jobs,
         'condition_protocol_hashes': {arm: digest(study / f'{benchmark}-{arm}/manifest.json') for arm in ['before', 'after']},
         'analysis_only': True})
    result = build_report(folder)
    result['benchmark'] = benchmark
    result['report_source_sha256'] = digest(Path(__file__))
    result['paired_cases'] = paired_cases(result['turns'])
    result['descriptive_metrics'] = descriptive_metrics(result['turns'], benchmark)
    result['recovery_view'] = recovered
    if benchmark == 'longds':
        result['judge_spend'] = judge_spend(study)
    result['representation_metrics'] = [{'task': job['task'], 'rep': job['rep'], 'arm': job['arm'],
          **scope_metrics(attempt_path(study, benchmark, job, recovered))} for job in jobs]
    if recovered and benchmark == 'longds':
        registration = study / 'interrupt-recovery-20261004.json'
        result['interruption_recovery_sha256'] = digest(registration)
        result['interrupted_attempts'] = json.loads(registration.read_text())['recovery']
        result['interpretation'] = 'Registered symmetric interruption replacements; original incomplete attempts remain in reports/ and are not solver failures'
        result['interrupted_spend'] = interrupted_spend(study)
    save(folder / 'report.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('study', type=Path)
    parser.add_argument('--with-recovery', action='store_true')
    args = parser.parse_args()
    for benchmark in ['krama', 'longds']:
        result = report(args.study.resolve(), benchmark, args.with_recovery)
        print(benchmark, json.dumps(result['summary'], indent=2))
