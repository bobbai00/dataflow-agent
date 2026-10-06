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

"""Markdown tables for a scored Lite run: accuracy and cost per arm, accuracy
by state label, saved-version references and which of them discriminated.

Reads pilot/summary.json, pilot/metrics.json and pilot/reference-study.json.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path

LABELS = ('Initial', 'Update', 'Rollback', 'Counterfactual')


def arm_name(row):
    return f"{row['model'].replace('gpt-5.6-', '').title()} {row['agent']} ({row['context']})"


def fmt(n, d):
    return f'{n}/{d}' + (f' ({100 * n / d:.0f}%)' if d else '')


def paired_results(metrics):
    """Exclude unjudged pairs; compare costs on exactly the same correct questions."""
    pairs = defaultdict(dict)
    for row in metrics:
        pairs[(row['model'], row['context'], row['task'], row['turn_id'])][row['agent']] = row
    groups = {}
    for (model, context, _, _), pair in sorted(pairs.items()):
        if set(pair) != {'dataflow', 'python'} or any(r['judge'].get('score') is None for r in pair.values()):
            continue
        total = groups.setdefault((model, context), {'model': model, 'context': context, 'judged_pairs': 0,
            'both_correct': 0, 'dataflow_only': 0, 'python_only': 0, 'both_wrong': 0,
            'dataflow_cost': 0., 'python_cost': 0., 'unknown_costs': 0})
        total['judged_pairs'] += 1
        correct = {agent: pair[agent]['judge']['score'] == 1 for agent in pair}
        if all(correct.values()):
            total['both_correct'] += 1
            for agent in pair:
                cost = pair[agent]['stats'].get('cost_usd')
                total['unknown_costs'] += cost is None
                total[agent + '_cost'] += cost or 0
        elif correct['dataflow']:
            total['dataflow_only'] += 1
        elif correct['python']:
            total['python_only'] += 1
        else:
            total['both_wrong'] += 1
    return list(groups.values())


def report(root):
    folder = root / 'pilot'
    protocol = json.loads((folder / 'protocol.json').read_text())
    summary = json.loads((folder / 'summary.json').read_text())
    metrics = json.loads((folder / 'metrics.json').read_text())
    study = json.loads((folder / 'reference-study.json').read_text()) if (folder / 'reference-study.json').exists() else []
    lines = []
    cases = protocol['cases']
    lines.append(f"Sessions: {', '.join(f'`{k}` ({v['turns']} turns)' for k, v in cases.items())}.")
    lines.append(f"Source revision {protocol['source_revision'][:9]}; judge {protocol['judge']['model']}; "
                 f"concurrency {protocol['concurrency']}; spend guard ${protocol['spend_guard_usd']}.")
    lines.append('')
    lines.append('| Arm | Correct | Attempted | Incomplete | Cost (USD) | Calls | Input tokens | Cached | Output |')
    lines.append('|---|---|---|---|---|---|---|---|---|')
    for row in summary['arms']:
        lines.append(f"| {arm_name(row)} | {fmt(row['correct'], row['judged'])} | {row['attempted']}/{row['expected']} | "
                     f"{row['incomplete_turns']} | {row['cost_usd']:.2f} | {row['llm_calls']} | {row['input_tokens']:,} | "
                     f"{row['cached_tokens']:,} | {row['output_tokens']:,} |")
    lines.append('')
    lines.append('Physical solver attempts, including infrastructure retries:')
    lines.append('')
    lines.append('| Arm | Known cost (USD) | Requests with unknown usage | Budget reserve (not a bill) |')
    lines.append('|---|---|---|---|')
    for row in summary['arms']:
        lines.append(f"| {arm_name(row)} | {row.get('all_attempt_cost_usd', row['cost_usd']):.2f} | "
                     f"{row.get('unknown_cost_requests', 0)} | {row.get('unknown_cost_reserve_usd', 0):.2f} |")
    lines.append('')
    lines.append('Input cache reuse at task boundaries and within tasks:')
    lines.append('')
    lines.append('| Arm | First-call observations | First-call cached input | Later-call cached input |')
    lines.append('|---|---|---|---|')
    for row in summary['arms']:
        first_input = row.get('first_call_input_tokens', 0)
        first_cached = row.get('first_call_cached_tokens', 0)
        later_input = row['input_tokens'] - first_input
        later_cached = row['cached_tokens'] - first_cached
        first = f'{100*first_cached/first_input:.1f}%' if first_input else 'unknown'
        later = f'{100*later_cached/later_input:.1f}%' if later_input and first_input else 'unknown'
        lines.append(f"| {arm_name(row)} | {row.get('first_call_usage_coverage', 0)}/{row['attempted']} | {first} | {later} |")
    lines.append('')
    lines.append('Accuracy by state label (a turn counts under each of its labels):')
    lines.append('')
    lines.append('| Arm | ' + ' | '.join(LABELS) + ' |')
    lines.append('|---|' + '---|' * len(LABELS))
    for row in summary['arms']:
        lines.append(f"| {arm_name(row)} | " + ' | '.join(fmt(row['by_label'][l]['correct'], row['by_label'][l]['judged']) for l in LABELS) + ' |')
    lines.append('')
    lines.append('Per session:')
    lines.append('')
    lines.append('| Session | Arm | Correct | Cost (USD) |')
    lines.append('|---|---|---|---|')
    per = defaultdict(lambda: {'correct': 0, 'judged': 0, 'cost': 0.})
    for m in metrics:
        key = (m['task'], arm_name(m))
        if m['judge'].get('score') is not None:
            per[key]['judged'] += 1
            per[key]['correct'] += m['judge']['score'] == 1
        per[key]['cost'] += m['stats'].get('cost_usd') or 0
    for (task, arm), v in sorted(per.items()):
        lines.append(f"| `{task.split('/')[1]}/{task.split('/')[2]}` | {arm} | {fmt(v['correct'], v['judged'])} | {v['cost']:.2f} |")
    lines.append('')
    lines.append('Matched questions: costs below include only questions both solvers answered correctly.')
    lines.append('')
    lines.append('| Model | Judged pairs | Both correct | Dataflow only | Python only | Both wrong | Dataflow cost | Python cost |')
    lines.append('|---|---|---|---|---|---|---|---|')
    for pair in paired_results(metrics):
        suffix = ' + unknown' if pair['unknown_costs'] else ''
        lines.append(f"| {pair['model'].replace('gpt-5.6-', '').title()} ({pair['context']}) | {pair['judged_pairs']} | "
                     f"{pair['both_correct']} | {pair['dataflow_only']} | {pair['python_only']} | {pair['both_wrong']} | "
                     f"${pair['dataflow_cost']:.2f}{suffix} | ${pair['python_cost']:.2f}{suffix} |")
    lines.append('')
    lines.append('Saved-version references (dataflow arms):')
    lines.append('')
    lines.append('| Arm | Turns with a reference | Reads | Edges | Variants | Definition updates | Answer sources | Retention warnings | Unavailable | Legacy rejections |')
    lines.append('|---|---|---|---|---|---|---|---|---|---|')
    for row in summary['arms']:
        if row['agent'] != 'dataflow':
            continue
        u = row['saved_version_uses']
        lines.append(f"| {arm_name(row)} | {row['turns_with_saved_reference']}/{row['attempted']} | {u['saved_reads_requested']} | "
                     f"{u['saved_edges_requested']} | {u['definition_variants_requested']} | {u['definition_updates_requested']} | "
                     f"{u['saved_answer_sources']} | {row['retention_warnings']} | {row['unavailable_results']} | {row['legacy_command_rejections']} |")
    if study:
        lines.append('')
        lines.append('Successful data accesses compared with the live table immediately before access:')
        lines.append('')
        lines.append('| Arm | Data accesses | Different values | Same as current | Absent now | Unknown | Turns with different/absent state | Correct among judged |')
        lines.append('|---|---|---|---|---|---|---|---|')
        by_arm = defaultdict(list)
        for r in study:
            by_arm[(r['model'], r['context'])].append(r)
        for (model, context), rows in sorted(by_arm.items()):
            refs = [r for r in rows if r['kind'] and r.get('scope') == 'data']
            disc = [r for r in refs if r['verdict'] in ('discriminating', 'operator_absent_now')]
            turns = {(r['run'], r['turn']): r['score'] for r in disc}
            correct = sum(1 for s in turns.values() if s == 1)
            unknown = sum(r['verdict'] not in ('discriminating', 'same_as_current', 'operator_absent_now') for r in refs)
            lines.append(f"| {model.replace('gpt-5.6-', '').title()} dataflow ({context}) | {len(refs)} | "
                         f"{sum(r['verdict'] == 'discriminating' for r in refs)} | {sum(r['verdict'] == 'same_as_current' for r in refs)} | "
                         f"{sum(r['verdict'] == 'operator_absent_now' for r in refs)} | {unknown} | {len(turns)} | "
                         f"{fmt(correct, sum(s is not None for s in turns.values()))} |")
        lines.append('')
        lines.append('Definition inspections and copies are separate from historical data access:')
        lines.append('')
        lines.append('| Arm | Definition accesses | Different definition | Same definition | Absent now | Unknown |')
        lines.append('|---|---|---|---|---|---|')
        for (model, context), rows in sorted(by_arm.items()):
            refs = [r for r in rows if r['kind'] and r.get('scope') == 'definition']
            unknown = sum(r['verdict'] not in ('definition_differs', 'same_definition', 'operator_absent_now') for r in refs)
            lines.append(f"| {model.replace('gpt-5.6-', '').title()} dataflow ({context}) | {len(refs)} | "
                         f"{sum(r['verdict'] == 'definition_differs' for r in refs)} | {sum(r['verdict'] == 'same_definition' for r in refs)} | "
                         f"{sum(r['verdict'] == 'operator_absent_now' for r in refs)} | {unknown} |")
    lines.append('')
    lines.append(f"Known judge cost: ${summary['judge_cost_usd']:.2f}" + ('' if summary.get('judge_cost_estimated') else ' (some request costs unknown)') + '.')
    lines.append(f"Selected solver answers/attempts: ${summary.get('selected_solver_cost_usd', sum(a['cost_usd'] for a in summary['arms'])):.2f}; "
                 f"all physical solver attempts, including retries: ${summary['solver_cost_usd']:.2f} known. "
                 f"Unknown usage: {summary.get('solver_unknown_cost_requests', 0)} requests; "
                 f"${summary.get('solver_cost_reserve_usd', 0):.2f} reserved against the budget, not a claimed bill.")
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    print(report(args.root.resolve()))
