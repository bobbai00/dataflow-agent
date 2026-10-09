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

"""Paired dataflow-versus-Python comparison of a judged Lite run.

Pairs are (session, model, question) answered and judged in both arms. Reports
accuracy, discordant pairs with an exact McNemar test, accuracy by state label,
accuracy conditioned on whether the question's annotated dependencies were
answered correctly in the same arm, and cost on the paired questions.
Reads judge.json files directly, so it also works on a partially judged run.
"""
import argparse
from collections import defaultdict
import json
from math import comb
from pathlib import Path

LABELS = ('Initial', 'Update', 'Rollback', 'Counterfactual')


def answers_folder(run):
    if (run / 'records.json').exists():
        return run
    verification = run / 'replay-verification.json'
    if verification.exists():
        source = Path(json.loads(verification.read_text())['source'])
        if (source / 'records.json').exists():
            return source
    return run


def job_key(job):
    return '__'.join((job['task'].replace('/', '__'), job['model'].replace('gpt-5.6-', ''), job['agent'], job['context']))


def mcnemar(b, c):
    """Exact two-sided McNemar p-value for b and c discordant pairs."""
    n = b + c
    if not n:
        return 1.
    k = min(b, c)
    return min(1., 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)


def load(root):
    folder = root / 'pilot'
    protocol = json.loads((folder / 'protocol.json').read_text())
    turns = {}
    for job in protocol['jobs']:
        run = answers_folder(folder / 'runs' / job_key(job))
        gold = json.loads((Path(protocol['cases'][job['task']]['prepared']) / 'gold.json').read_text())['turns']
        records = json.loads((run / 'records.json').read_text()) if (run / 'records.json').exists() else []
        for record in records:
            directory = run / f"t{record['turn_id']:02d}"
            verdict = json.loads((directory / 'judge.json').read_text()) if (directory / 'judge.json').exists() else {}
            g = gold[record['turn_id'] - 1]
            turns[(job['task'], job['model'], job['agent'], record['turn_id'])] = {
                'score': verdict.get('score'), 'completed': record['completed'], 'cost': record['stats'].get('cost_usd') or 0.,
                'calls': record['stats'].get('llm_calls') or 0, 'labels': g.get('state_type', []),
                'depends': g.get('depends_tasks', []), 'answer': record['answer'], 'reason': verdict.get('error_detail') or verdict.get('reasoning', '')}
    return protocol, turns


def analyze(root):
    protocol, turns = load(root)
    out = []
    pairs = defaultdict(list)
    for (task, model, agent, turn), row in turns.items():
        if agent != 'dataflow':
            continue
        other = turns.get((task, model, 'python', turn))
        if other is None or row['score'] is None or other['score'] is None:
            continue
        pairs[model].append((task, turn, row, other))
    out.append('| Model | Paired questions | Dataflow correct | Python correct | Only dataflow | Only Python | McNemar p | Dataflow cost | Python cost |')
    out.append('|---|---|---|---|---|---|---|---|---|')
    for model, items in sorted(pairs.items()):
        d = sum(r['score'] == 1 for _, _, r, _ in items)
        p = sum(o['score'] == 1 for _, _, _, o in items)
        b = sum(r['score'] == 1 and o['score'] != 1 for _, _, r, o in items)
        c = sum(r['score'] != 1 and o['score'] == 1 for _, _, r, o in items)
        out.append(f"| {model.replace('gpt-5.6-', '').title()} | {len(items)} | {d} | {p} | {b} | {c} | {mcnemar(b, c):.3f} | "
                   f"{sum(r['cost'] for _, _, r, _ in items):.2f} | {sum(o['cost'] for _, _, _, o in items):.2f} |")
    out.append('')
    out.append('By session:')
    out.append('')
    out.append('| Session | Model | Paired | Dataflow correct | Python correct |')
    out.append('|---|---|---|---|---|')
    by_session = defaultdict(list)
    for model, items in pairs.items():
        for task, turn, r, o in items:
            by_session[(task, model)].append((r, o))
    for (task, model), items in sorted(by_session.items()):
        out.append(f"| `{task.split('/')[1]}/{task.split('/')[2]}` | {model.replace('gpt-5.6-', '').title()} | {len(items)} | "
                   f"{sum(r['score'] == 1 for r, _ in items)} | {sum(o['score'] == 1 for _, o in items)} |")
    out.append('')
    out.append('By state label (a question counts under each of its labels):')
    out.append('')
    out.append('| Model | Label | Paired | Dataflow correct | Python correct |')
    out.append('|---|---|---|---|---|')
    for model, items in sorted(pairs.items()):
        for label in LABELS:
            sel = [(r, o) for _, _, r, o in items if label in r['labels']]
            out.append(f"| {model.replace('gpt-5.6-', '').title()} | {label} | {len(sel)} | {sum(r['score'] == 1 for r, _ in sel)} | {sum(o['score'] == 1 for _, o in sel)} |")
    out.append('')
    out.append('Accuracy given the annotated dependencies, within each arm (questions with at least one dependency):')
    out.append('')
    out.append('| Model | Arm | All dependencies right | Correct | Some dependency wrong | Correct |')
    out.append('|---|---|---|---|---|---|')
    for model in sorted(pairs):
        for agent in ('dataflow', 'python'):
            rows = {(task, turn): row for (task, m, a, turn), row in turns.items() if m == model and a == agent}
            good = bad = good_ok = bad_ok = 0
            for (task, turn), row in rows.items():
                if row['score'] is None or not row['depends']:
                    continue
                deps = [rows.get((task, d)) for d in row['depends']]
                if any(dep is None or dep['score'] is None for dep in deps):
                    continue
                if all(dep['score'] == 1 for dep in deps):
                    good += 1; good_ok += row['score'] == 1
                else:
                    bad += 1; bad_ok += row['score'] == 1
            out.append(f"| {model.replace('gpt-5.6-', '').title()} | {agent} | {good} | {good_ok} | {bad} | {bad_ok} |")
    judged = sum(r['score'] is not None for r in turns.values())
    out.append('')
    out.append(f'Judged answers: {judged} of {len(turns)} preserved.')
    return '\n'.join(out), pairs


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--disagreements', type=Path, help='write discordant pairs as JSON here')
    args = parser.parse_args()
    text, pairs = analyze(args.root.resolve())
    print(text)
    if args.disagreements:
        rows = [{'task': task, 'model': model, 'turn': turn, 'labels': r['labels'], 'depends': r['depends'],
                 'dataflow_score': r['score'], 'python_score': o['score'],
                 'dataflow_reason': r['reason'], 'python_reason': o['reason']}
                for model, items in pairs.items() for task, turn, r, o in items if r['score'] != o['score']]
        args.disagreements.write_text(json.dumps(rows, indent=1))
