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

"""How a dataflow run changed state: per question, its output tokens, the
operators it created, the existing operators it changed in place, the shared
functions it defined, redefined and called, its ordered limits, its `name@N`
references, and the effect lines its execute receipts showed. Works for both
edit syntaxes, so old and new runs of the same session compare directly.
"""
import argparse
from collections import Counter, defaultdict
import difflib
import gzip
import json
from pathlib import Path
import re
import textwrap

LABELS = ('Initial', 'Update', 'Rollback', 'Counterfactual')
ASSIGN = re.compile(r'^([A-Za-z_]\w*)\s*=\s*(.+)$')
LEGACY = re.compile(r'^(create|update|modify) operator (\w+)(?::\s*(\w+)\(| from (\w+)@(\d+))')


def answers_folder(run):
    if (run / 'records.json').exists():
        return run
    verification = run / 'replay-verification.json'
    if verification.exists():
        source = Path(json.loads(verification.read_text())['source'])
        if (source / 'records.json').exists():
            return source
    return run


def margin_blocks(text):
    blocks, current = [], []
    for line in text.splitlines():
        if line and not line[0].isspace():
            if current:
                blocks.append(current)
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append(current)
    return blocks


def study_edit(text, existing, functions):
    """Counts for one edit; `existing` and `functions` are updated in place."""
    c = Counter()
    bodies = []
    for block in margin_blocks(text):
        head = block[0]
        if head.startswith('def '):
            name = re.match(r'def (\w+)', head)[1]
            c['functions_redefined' if name in functions else 'functions_defined'] += 1
            body = textwrap.dedent('\n'.join(block))
            functions[name] = body
            bodies.append(body)
            continue
        legacy = LEGACY.match(head)
        if legacy:
            verb, name, op, source, task = legacy.groups()
            if source:
                c['restores' if name == source else 'copies'] += 1
            elif name in existing:
                c['updated_in_place'] += 1
            else:
                c['created'] += 1
            if op == 'process':
                body = textwrap.dedent('\n'.join(block[1:]))
                bodies.append(body)
            existing.add(name)
            continue
        assign = ASSIGN.match(head)
        if not assign:
            if head.startswith('del '):
                c['deleted'] += len(head[4:].split(','))
            continue
        name, rhs = assign.groups()
        saved = re.fullmatch(r'(\w+)@(\d+)', rhs.strip())
        if saved:
            c['restores' if saved[1] == name else 'copies'] += 1
            existing.add(name)
            continue
        call = re.match(r'(\w+)\(', rhs)
        op = call[1] if call else ''
        if op in functions:
            c['shared_calls'] += 1
        if op == 'limit' and 'by=' in rhs:
            c['ordered_limits'] += 1
        c['updated_in_place' if name in existing else 'created'] += 1
        existing.add(name)
        if op == 'process' and len(block) > 1:
            bodies.append(textwrap.dedent('\n'.join(block[1:])))
    c['at_references'] += len(re.findall(r'\b\w+@\d+\b', text))
    return c, bodies


def study(run, gold, limit=None):
    records = json.loads((answers_folder(run) / 'records.json').read_text())
    records = [r for r in records if limit is None or r['turn_id'] <= limit]
    existing, functions, earlier_bodies = set(), {}, []
    rows = []
    for record in records:
        turn = record['turn_id']
        labels = gold[turn - 1].get('state_type', [])
        actions = [a for b in record.get('native_actions', []) if isinstance(b, dict) for a in b.get('actions', []) if isinstance(a, dict)]
        counts, near = Counter(), 0
        text_chars = 0
        before = set(existing)
        for action in actions:
            if action.get('type') != 'edit':
                continue
            text = action.get('changes', '')
            text_chars += len(text)
            c, bodies = study_edit(text, existing, functions)
            counts.update(c)
            for body in bodies:
                best = max((difflib.SequenceMatcher(None, body, old).ratio() for old in earlier_bodies[-80:]), default=0)
                near += best >= 0.8
                earlier_bodies.append(body)
        counts['at_references'] += sum(len(re.findall(r'\b\w+@\d+\b', json.dumps(a.get('operator_ids', []))))
                                       for a in actions if a.get('type') in ('read', 'answer'))
        effects = 0
        steps = run / f't{turn:02d}' / 'react_steps.json.gz'
        if steps.exists():
            blob = json.dumps(json.loads(gzip.open(steps, 'rt').read())['steps'])
            effects = blob.count('changed since ')
        rows.append({'turn': turn, 'labels': labels, 'output_tokens': record['stats'].get('output_tokens'),
                     'calls': record['stats'].get('llm_calls'), 'cost_usd': record['stats'].get('cost_usd'),
                     'edit_chars': text_chars, 'near_copy_functions': near, 'effect_lines': effects,
                     'changed_existing': bool(counts['updated_in_place'] or counts['functions_redefined'] or counts['restores']),
                     **dict(counts)})
    return rows


def summarize(rows):
    out = {}
    for kind, select in (('all', lambda r: True),
                         ('state change', lambda r: any(l in r['labels'] for l in ('Update', 'Rollback', 'Counterfactual'))),
                         ('initial only', lambda r: not any(l in r['labels'] for l in ('Update', 'Rollback', 'Counterfactual')))):
        sel = [r for r in rows if select(r)]
        if not sel:
            continue
        total = Counter()
        for r in sel:
            total.update({k: v for k, v in r.items() if isinstance(v, (int, float)) and not isinstance(v, bool) and k != 'turn'})
            total['questions_changing_existing'] += r['changed_existing']
        total['questions'] = len(sel)
        out[kind] = dict(total)
    return out


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, action='append', required=True, help='a dataflow run folder (repeatable)')
    parser.add_argument('--gold', type=Path, required=True)
    parser.add_argument('--limit', type=int, help='study only the first N questions')
    args = parser.parse_args()
    gold = json.loads(args.gold.read_text())['turns']
    for run in args.run:
        rows = study(run, gold, args.limit)
        s = summarize(rows)
        print(f'== {run.name}')
        for kind, t in s.items():
            q = t['questions']
            print(f"  {kind:12s} q={q:3d} | output/q {t.get('output_tokens', 0)/q:6.0f} | edit chars/q {t.get('edit_chars', 0)/q:6.0f} | "
                  f"created {t.get('created', 0)} | in place {t.get('updated_in_place', 0)} | restores {t.get('restores', 0)} | "
                  f"fn defined {t.get('functions_defined', 0)} redefined {t.get('functions_redefined', 0)} calls {t.get('shared_calls', 0)} | "
                  f"limit-by {t.get('ordered_limits', 0)} | @N refs {t.get('at_references', 0)} | effect lines {t.get('effect_lines', 0)} | "
                  f"near-copies {t.get('near_copy_functions', 0)} | questions changing existing state {t.get('questions_changing_existing', 0)}")
