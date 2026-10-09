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

"""Which state operations a dataflow session used, by question label: setting
changes, variants, commits, inserted steps, restores and copies of saved
versions, ranking comparisons, new functions, and held statements; with
output tokens and accuracy per label. Python runs are listed for output and
accuracy only."""
import argparse
from collections import Counter, defaultdict
import gzip
import json
from pathlib import Path
import re

LABELS = ('Update', 'Counterfactual', 'Rollback')
OPERATIONS = {
    'setting change': re.compile(r'^\w+\.\w+\s*=(?!=)'),
    'variant': re.compile(r'^\w+\s*=\s*variant\('),
    'commit': re.compile(r'^\w+\s*=\s*[A-Za-z_]\w*\s*$'),
    'restore': re.compile(r'^(\w+)\s*=\s*\1@\d+\s*$'),
    'copy of a saved version': re.compile(r'^(\w+)\s*=\s*(?!\1@)\w+@\d+\s*$'),
    'inserted step': re.compile(r'^(\w+)\s*=\s*\w+\(\s*\1\b'),
    'rank_change': re.compile(r'^\w+\s*=\s*rank_change\('),
    'diff': re.compile(r'^\w+\s*=\s*diff\('),
    'new function': re.compile(r'^def \w+\('),
}


def answers(run):
    if (run / 'records.json').exists():
        return run
    verification = run / 'replay-verification.json'
    return Path(json.loads(verification.read_text())['source']) if verification.exists() else run


def label(state_types):
    for name in LABELS:
        if name in state_types:
            return name
    return 'Initial'


def accepted_edits(run, q):
    """Edit texts whose statements applied (all, or all but the held ones), and held counts."""
    path = run / f't{q:02d}' / 'react_steps.json.gz'
    texts, held = [], 0
    if not path.exists():
        return texts, held
    for step in json.loads(gzip.open(path, 'rt').read())['steps']:
        results = {r.get('toolCallId'): r for r in (step.get('toolResults') or [])}
        for call in step.get('toolCalls') or []:
            args = call.get('input')
            if not isinstance(args, dict):
                continue
            out = (results.get(call.get('toolCallId')) or {}).get('output')
            items = {a.get('index'): a for a in (out.get('actions') or [])} if isinstance(out, dict) else {}
            for i, action in enumerate(args.get('actions') or [], start=1):
                if not (isinstance(action, dict) and action.get('type') == 'edit'):
                    continue
                item = items.get(i) or {}
                output = item.get('output') if isinstance(item.get('output'), dict) else {}
                held_lines = {h.get('line') for h in output.get('held') or []}
                held += len(held_lines)
                if item.get('status') == 'ok' or held_lines:
                    texts.append('\n'.join(line for n, line in enumerate((action.get('changes') or '').splitlines(), start=1)
                                           if n not in held_lines))
    return texts, held


def report(gold, run, limit=None):
    run = answers(run)
    by_label = defaultdict(Counter)
    for record in json.loads((run / 'records.json').read_text()):
        q = record['turn_id']
        if limit and q > limit:
            continue
        name = label(gold[q - 1].get('state_type', []))
        c = by_label[name]
        c['questions'] += 1
        judge = run / f't{q:02d}' / 'judge.json'
        c['correct'] += (json.loads(judge.read_text()).get('score') == 1) if judge.exists() else 0
        c['output'] += record['stats'].get('output_tokens') or 0
        texts, held = accepted_edits(run, q)
        c['held statements'] += held
        for text in texts:
            for line in text.splitlines():
                if not line or line[0].isspace():
                    continue
                for operation, pattern in OPERATIONS.items():
                    if pattern.match(line):
                        c[operation] += 1
    return by_label


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gold', type=Path, required=True)
    parser.add_argument('--arm', nargs=2, action='append', metavar=('NAME', 'RUN'), required=True)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    gold = json.loads(args.gold.read_text())['turns']
    columns = ['questions', 'correct', 'output', *OPERATIONS, 'held statements']
    print('| Arm | Label | ' + ' | '.join(columns) + ' |')
    print('|---|---|' + '---:|' * len(columns))
    for name, run in args.arm:
        rows = report(gold, Path(run), args.limit)
        for kind in ('Initial', *LABELS):
            c = rows.get(kind)
            if not c:
                continue
            values = [str(c['questions']), str(c['correct']), f"{c['output'] / c['questions']:,.0f}/q",
                      *(str(c[op]) for op in OPERATIONS), str(c['held statements'])]
            print(f'| {name} | {kind} | ' + ' | '.join(values) + ' |')
