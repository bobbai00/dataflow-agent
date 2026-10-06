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

"""Which `operator@N` references pointed at a version that differed from the
current table when they were made.

A reference is *discriminating* when using the saved version could give a
different answer than using the current operator: the operator was changed or
deleted by a task after N, or its recorded result version at N differs from
the current one at the referencing turn. A reference to a version that still
equals the current table exercises nothing the current graph could not give.

Reads the pilot's records and observer captures; makes no model calls.
"""
import argparse
from collections import Counter
import gzip
import json
from pathlib import Path
import re

REFERENCE = re.compile(r'\b([A-Za-z_]\w*)@([1-9]\d*)\b')


def references_in(actions):
    """(kind, operator, task) for every saved-version reference in a turn's actions."""
    found = []
    for action in actions:
        kind = action.get('type')
        if kind == 'read':
            for op in action.get('operator_ids', []):
                m = REFERENCE.fullmatch(op)
                if m:
                    found.append(('read' if action.get('view') is not None else 'read_definition', m[1], int(m[2])))
        elif kind == 'edit':
            for line in action.get('changes', '').splitlines():
                m = re.match(r'create edge (\w+)@(\d+)\.out', line)
                if m:
                    found.append(('edge', m[1], int(m[2])))
                m = re.match(r'(create|update) operator (\w+) from (\w+)@(\d+)', line)
                if m:
                    found.append(('copy_definition' if m[1] == 'create' else 'update_definition', m[3], int(m[4])))
        elif kind == 'answer':
            for op in action.get('operator_ids') or []:
                m = REFERENCE.fullmatch(op)
                if m:
                    found.append(('answer_source', m[1], int(m[2])))
            for m in REFERENCE.finditer(action.get('from', '') or ''):
                found.append(('answer_from', m[1], int(m[2])))
        elif kind == 'execute':
            for op in action.get('operator_ids') or []:
                m = REFERENCE.fullmatch(op)
                if m:
                    found.append(('execute', m[1], int(m[2])))
    return found


def capture_at(run, turn):
    path = run / f't{turn:02d}' / 'observer' / 'capture.json.gz'
    return json.loads(gzip.open(path, 'rt').read()) if path.exists() else None


def version_at_save(tasks, operator, n):
    """The result version recorded for `operator` at task n's save point, or the
    latest earlier record (an operator unchanged since then keeps its version)."""
    for task in sorted((t for t in tasks if t['task_id'] <= n), key=lambda t: -t['task_id']):
        for op in task.get('operators', []):
            if op['operator_id'] == operator and op.get('result_version'):
                return op['result_version'], task['task_id']
    return None, None


def classify(reference, turn, capture, history_before):
    kind, operator, n = reference
    tasks = history_before.get('tasks', []) if history_before else []
    changed_after = [t['task_id'] for t in tasks if n < t['task_id'] < turn and any(
        b['id'] == operator for b in (t.get('operator_changes') or []) + (t.get('operator_deletions') or []))]
    saved, recorded_at = version_at_save(tasks, operator, n)
    current = (capture or {}).get('observerTables', {}).get(operator, {}).get('version') if capture else None
    if isinstance(current, dict):
        current = current.get('id')
    if changed_after:
        verdict = 'discriminating'
    elif saved and current and saved != current:
        verdict = 'discriminating'
    elif saved and current and saved == current:
        verdict = 'same_as_current'
    elif current is None and saved:
        verdict = 'operator_absent_now'  # deleted or renamed since: the saved version is the only copy
    else:
        verdict = 'unknown'
    return {'kind': kind, 'operator': operator, 'task': n, 'turn': turn, 'verdict': verdict,
            'changed_after_by_tasks': changed_after, 'saved_version_recorded_at': recorded_at}


def edits_in(actions, existing):
    """Operators created, updated in place (an operator that existed before this turn),
    deleted, and definitions copied or restored from a saved version."""
    counts = Counter()
    for action in actions:
        if action.get('type') != 'edit':
            continue
        for line in action.get('changes', '').splitlines():
            m = re.match(r'(create|update|delete) operator (\w+)(?::| from (\w+)@(\d+)|\s*$)', line)
            if not m:
                continue
            verb, op, source, _ = m.groups()
            if source:
                counts['copied_from_saved' if verb == 'create' else 'restored_from_saved'] += 1
            elif verb == 'create':
                counts['created'] += 1
            elif verb == 'update':
                counts['updated_in_place' if op in existing else 'updated_new'] += 1
            elif verb == 'delete':
                counts['deleted'] += 1
            if verb != 'delete':
                existing.add(op)
    return counts


def study(root):
    folder = root / 'pilot'
    protocol = json.loads((folder / 'protocol.json').read_text())
    metrics = {(m['run'], m['turn_id']): m for m in json.loads((folder / 'metrics.json').read_text())} if (folder / 'metrics.json').exists() else {}
    rows, turns = [], []
    for job in protocol['jobs']:
        if job['agent'] != 'dataflow':
            continue
        key = '__'.join((job['task'].replace('/', '__'), job['model'].replace('gpt-5.6-', ''), job['agent'], job['context']))
        run = folder / 'runs' / key
        if not (run / 'records.json').exists():
            continue
        gold = json.loads((Path(protocol['cases'][job['task']]['prepared']) / 'gold.json').read_text())['turns']
        records = json.loads((run / 'records.json').read_text())
        existing = set()
        for record in records:
            turn = record['turn_id']
            actions = [a for batch in record.get('native_actions', []) for a in batch.get('actions', [])]
            refs = references_in(actions)
            capture = capture_at(run, turn)
            previous = capture_at(run, turn - 1) if turn > 1 else None
            history_before = (previous or {}).get('history') if previous else {'tasks': []}
            judged = metrics.get((key, turn), {}).get('judge', {}).get('score')
            expected = gold[turn - 1]
            labels = expected.get('state_type', [])
            depends = expected.get('depends_tasks', [])
            classified = [classify(ref, turn, capture, history_before) for ref in refs]
            edits = edits_in(actions, existing)
            referenced_tasks = sorted({ref[2] for ref in refs})
            turns.append({'run': key, 'model': job['model'], 'context': job['context'], 'turn': turn, 'score': judged,
                          'labels': labels, 'depends_tasks': depends, 'referenced_tasks': referenced_tasks,
                          'references_in_depends': sum(t in depends for t in referenced_tasks),
                          'discriminating_references': sum(c['verdict'] in ('discriminating', 'operator_absent_now') for c in classified),
                          'same_as_current_references': sum(c['verdict'] == 'same_as_current' for c in classified),
                          'edits': dict(edits), 'calls': record['stats'].get('llm_calls'), 'cost_usd': record['stats'].get('cost_usd')})
            for c in classified:
                rows.append({'run': key, 'model': job['model'], 'context': job['context'], 'score': judged, 'labels': labels, **c})
            if not refs:
                rows.append({'run': key, 'model': job['model'], 'context': job['context'], 'score': judged,
                             'labels': labels, 'kind': None, 'operator': None, 'task': None, 'turn': turn,
                             'verdict': 'no_reference', 'changed_after_by_tasks': [], 'saved_version_recorded_at': None})
    return rows, turns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    rows, turns = study(args.root.resolve())
    out = args.root.resolve() / 'pilot' / 'reference-study.json'
    out.write_text(json.dumps(rows, indent=1))
    (args.root.resolve() / 'pilot' / 'turn-study.json').write_text(json.dumps(turns, indent=1))
    edits = Counter()
    for t in turns:
        edits.update(t['edits'])
    print('edits over all dataflow turns:', dict(edits))
    by_label = {}
    for label in ('Initial', 'Update', 'Rollback', 'Counterfactual'):
        sel = [t for t in turns if label in t['labels']]
        if sel:
            by_label[label] = {'turns': len(sel), 'with_reference': sum(bool(t['referenced_tasks']) for t in sel),
                               'with_discriminating': sum(t['discriminating_references'] > 0 for t in sel),
                               'in_place_updates': sum(t['edits'].get('updated_in_place', 0) + t['edits'].get('restored_from_saved', 0) for t in sel),
                               'created': sum(t['edits'].get('created', 0) for t in sel)}
    print('by label:', json.dumps(by_label))
    turns = {(r['run'], r['turn']) for r in rows}
    with_ref = {(r['run'], r['turn']) for r in rows if r['kind']}
    print(f'turns {len(turns)}, turns with a saved-version reference {len(with_ref)}')
    print('references by verdict:', dict(Counter(r['verdict'] for r in rows if r['kind'])))
    print('references by kind:', dict(Counter(r['kind'] for r in rows if r['kind'])))
    disc = [r for r in rows if r['verdict'] in ('discriminating', 'operator_absent_now')]
    print('discriminating references:', len(disc), 'in', len({(r["run"], r["turn"]) for r in disc}), 'turns')
    for r in disc[:20]:
        print(f"  {r['run']} t{r['turn']:02d} {r['kind']} {r['operator']}@{r['task']} score={r['score']} labels={r['labels']} changed_after={r['changed_after_by_tasks']}")
    print('written', out)


if __name__ == '__main__':
    main()
