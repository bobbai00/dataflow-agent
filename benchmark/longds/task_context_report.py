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
"""Read-only diagnostics for the frozen task-context pilot.

Official scores are never changed. Observed state accesses and runtime failures
are counted mechanically; semantic causes and cross-task cascades are not
invented from failed answers or graph edges.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import json
from pathlib import Path
import statistics

from comparison_report import build_report
from state_comparison import digest, save, verify_sources
from task_context_metrics import score_components


def context_summary(rows):
    result = {}
    for label, selected in [('all_calls', rows), ('first_calls', [r for r in rows if r['first_call']]),
                            ('within_task_calls', [r for r in rows if not r['first_call']])]:
        known = [r for r in selected if r['input_tokens'] is not None and r['cached_tokens'] is not None]
        inputs = sum(r['input_tokens'] for r in known)
        result[label] = {'calls': len(selected), 'unknown_token_calls': len(selected) - len(known),
            'mean_dynamic_context_chars': statistics.mean(r['dynamic_context_chars'] for r in selected) if selected else None,
            'mean_input_tokens': statistics.mean(r['input_tokens'] for r in known) if known else None,
            'mean_fresh_input_tokens': statistics.mean(r['input_tokens'] - r['cached_tokens'] for r in known) if known else None,
            'cache_hit_rate': sum(r['cached_tokens'] for r in known) / inputs if inputs else None}
    return result


def aggregate_partial(rows):
    supported = [r for r in rows if r['components_total']]
    total = sum(r['components_total'] for r in supported)
    return {'turns_supported': len(supported), 'turns_unsupported': len(rows) - len(supported),
            'json_parseable': sum(r['format_json'] for r in supported),
            'components_total': total, 'components_correct': sum(r['components_correct'] for r in supported),
            'macro_strict_component_score': statistics.mean(r['strict_component_score'] for r in supported) if supported else None,
            'micro_strict_component_score': sum(r['components_correct'] for r in supported) / total if total else None,
            'component_presence': sum(r['components_present'] for r in supported) / total if total else None}


def trace_diagnostics(folder):
    total_counts = Counter()
    mechanical_turns = []
    contexts = []
    final_graph = None
    for file in sorted(folder.glob('t*/react_steps.json.gz')):
        counts = Counter()
        steps = json.loads(gzip.decompress(file.read_bytes()))['steps']
        previous = None
        for step in steps:
            messages = step.get('inputMessages')
            if step.get('role') == 'agent' and messages:
                if previous is not None:
                    counts['within_task_prefix_checks'] += 1
                    counts['within_task_prefix_changes'] += messages[:len(previous)] != previous
                usage = step.get('usage') or {}
                contexts.append({'turn': int(file.parent.name[1:]),
                    'first_call': previous is None,
                    'dynamic_context_chars': len(json.dumps(messages, ensure_ascii=False)),
                    'input_tokens': usage.get('inputTokens'), 'cached_tokens': usage.get('cachedInputTokens')})
                previous = messages
            for result in step.get('toolResults') or []:
                output = result.get('output')
                if not isinstance(output, dict):
                    continue
                for item in output.get('actions', []):
                    action = item.get('action') or {}
                    status = item.get('status')
                    if status == 'skipped':
                        counts['skipped_actions'] += 1
                        continue
                    if status == 'error':
                        counts['error_actions'] += 1
                        counts['error_' + action.get('type', 'unknown')] += 1
                    if action.get('type') == 'execute':
                        outcomes = item.get('output')
                        for op in outcomes.get('operators', []) if isinstance(outcomes, dict) else []:
                            state = op.get('state', 'unknown')
                            counts['execute_' + state.replace(' ', '_') + '_visits'] += 1
                            cause = op.get('cause', '')
                            if state == 'not run' and cause.startswith('upstream '):
                                counts['execute_upstream_blocked_visits'] += 1
                            elif state == 'not run' and 'do not read from it' in cause:
                                counts['execute_unrelated_stopped_visits'] += 1
                    if status == 'ok' and action.get('type') == 'inspect':
                        counts['inspect_' + action.get('target', 'unknown')] += 1
                    if status == 'ok' and action.get('type') == 'edit':
                        for line in action.get('changes', '').splitlines():
                            line = line.strip()
                            if line.startswith('fork operator '):
                                counts['fork_commands'] += 1
                            elif line.startswith('update operator ') and ' from task ' in line:
                                counts['restore_commands'] += 1
        graph = file.parent / 'task-history.json'
        if graph.exists():
            final_graph = json.loads(graph.read_text()).get('tasks', [])
        total_counts.update(counts)
        mechanical_turns.append({'turn_id': int(file.parent.name[1:]), 'counts': dict(counts)})
    counts = total_counts
    if final_graph is not None:
        counts['tasks_in_graph'] = len(final_graph)
        for task in final_graph:
            counts['observed_task_edges'] += len(task.get('dependencies', []))
            counts['recorded_task_consultations'] += len(task.get('consulted_tasks', []))
            counts['unresolved_references'] += task.get('unresolved_references', 0)
            for edge in task.get('dependencies', []):
                for ref in edge.get('references', []):
                    counts['task_reference_' + ref['kind']] += 1
    # Explicit zeros prevent the absence of a failure counter looking unknown.
    for key in ['within_task_prefix_changes', 'error_actions', 'execute_failed_visits',
                'execute_upstream_blocked_visits', 'execute_unrelated_stopped_visits', 'inspect_task',
                'inspect_state', 'fork_commands', 'restore_commands', 'unresolved_references']:
        counts.setdefault(key, 0)
    return {'counts': dict(counts), 'mechanical_turns': mechanical_turns, 'model_contexts': contexts}


def stage_timings(file):
    result = defaultdict(Counter)
    if file is not None:
        with file.open() as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                agent = row.get('agentId')
                if not agent:
                    continue
                for field in ['compileMs', 'contextMs', 'modelMs', 'postStepMs']:
                    if isinstance(row.get(field), (int, float)):
                        result[agent][field] += row[field]
                        result[agent][field + '_events'] += 1
    return result


def verify_study(output):
    study = json.loads((output / 'protocol.json').read_text())
    for phase, expected in study['manifests'].items():
        if digest(output / phase / 'manifest.json') != expected:
            raise ValueError(f'Frozen {phase} manifest changed')
    if digest(output / 'partial-rubrics.json') != study['partial_rubric_sha256']:
        raise ValueError('Frozen partial rubric changed')
    return study


def judge_cost(output):
    original = [json.loads(file.read_text()) for file in (output / 'judge-cache').glob('*.json')]
    recovered = [json.loads(file.read_text()) for file in (output / 'judge-recovery-cache').glob('*.json')
                 if not file.name.endswith('.started.json')]
    usage = [call for verdict in original + recovered for call in verdict.get('usage', [])]
    return {'unique_original_verdicts': len(original), 'unique_recovery_verdicts': len(recovered),
        'calls': len(usage),
        'original_unjudged_verdicts': sum(v.get('score') not in (0, 1) for v in original),
        'unjudged_recovery_verdicts': sum(v.get('score') not in (0, 1) for v in recovered),
        'reported_cost_usd': sum(call.get('cost') or 0 for call in usage),
        'unknown_cost_calls': sum(call.get('cost') is None for call in usage),
        'cost_source': 'Provider usage cost; original failed calls and judge-only recoveries included, shared verdicts counted once'}


def build(output, timing_log=None):
    study = verify_study(output)
    rubric_path = output / 'partial-rubrics.json'
    rubrics = json.loads(rubric_path.read_text())
    timing = stage_timings(timing_log)
    result = {'analysis_source_sha256': digest(__file__), 'protocol_sha256': digest(output / 'protocol.json'),
              'runtime_commit': study['runtime_commit'], 'scope': study['scope'], 'phases': {}}
    result['judge'] = judge_cost(output)
    for phase in ['longds', 'krama']:
        folder = output / phase
        protocol = json.loads((folder / 'manifest.json').read_text())
        verify_sources(protocol)
        report = build_report(folder)
        diagnostics, partial, per_turn = [], defaultdict(list), []
        prompt_hashes, tool_hashes = set(), set()
        for job in protocol['jobs']:
            path = folder / 'runs' / f"{job['arm']}-r{job['rep']}" / job['task'].replace('/', '__')
            record = {'task': job['task'], 'arm': job['arm'], 'rep': job['rep'], **trace_diagnostics(path)}
            if (path / 'resources.json').exists():
                agent = json.loads((path / 'resources.json').read_text())['agent_id']
                record['stage_timings'] = dict(timing[agent])
            diagnostics.append(record)
            if (path / 'system_prompt.txt').exists():
                prompt_hashes.add(digest(path / 'system_prompt.txt'))
                system = json.loads((path / 'system-info.json').read_text())
                import hashlib
                tool_hashes.add(hashlib.sha256(json.dumps(system['tools'], sort_keys=True).encode()).hexdigest())
        for row in report['turns']:
            fields = {k: row.get(k) for k in ['task', 'arm', 'rep', 'turn_id', 'score']}
            fields['stats'] = row['stats']
            if phase == 'longds':
                component = score_components(row['solution'], rubrics[row['task']][str(row['turn_id'])])
                partial[row['arm']].append(component)
                fields['strict_json_agreement'] = component
            else:
                fields['official_evaluation'] = row.get('judge', {}).get('evaluation')
            per_turn.append(fields)
        if len(prompt_hashes) > 1 or len(tool_hashes) > 1:
            raise ValueError('Matched prompt/tool definitions differ')
        context = {arm: context_summary([row for d in diagnostics if d['arm'] == arm for row in d['model_contexts']])
                   for arm in report['summary']}
        result['phases'][phase] = {k: report[k] for k in ['summary', 'pairs', 'breakdowns', 'metrics', 'cost_analysis']}
        result['phases'][phase].update({'complete': all(s['complete'] for s in report['summary'].values()),
            'prompt_hashes': sorted(prompt_hashes), 'tool_hashes': sorted(tool_hashes),
            'diagnostics': diagnostics, 'partial': {arm: aggregate_partial(rows) for arm, rows in partial.items()},
            'context': context, 'turns': per_turn})
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--timing-log', type=Path)
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    report = build(args.output, args.timing_log)
    save(args.report or args.output / 'task-context-report.json', report)
    print(json.dumps({phase: data['summary'] for phase, data in report['phases'].items()}, indent=2))
