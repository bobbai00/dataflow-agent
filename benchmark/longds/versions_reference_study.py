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

Successful accesses are compared with state immediately before that action.
Discriminating data references require different complete table contents, or
an operator genuinely absent from the live graph. Definition differences are
reported separately. Missing captures or within-turn unobserved values remain
unknown; a different execution identity alone never proves different values.

Reads the pilot's records and observer captures; makes no model calls.
"""
import argparse
from collections import Counter
from copy import deepcopy
import gzip
import hashlib
import json
from pathlib import Path
import re
from context_state_pilot import rows_digest, visible_tables
from context_state_score import normalized_native_actions

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


def classify(reference, turn, saved_state, current_state):
    """Compare state immediately before a successful access. Different execution
    identities alone do not establish different values; missing proof stays unknown."""
    kind, operator, n = reference
    saved, current = saved_state.get(operator), current_state.get(operator)
    definition = kind in ('read_definition', 'copy_definition', 'update_definition')
    if not saved or not definition and not saved.get('available'):
        verdict = 'historical_result_unavailable'
    elif definition and not saved.get('definition'):
        verdict = 'historical_definition_unknown'
    elif not current or not current.get('present'):
        verdict = 'operator_absent_now'
    elif definition:
        verdict = ('same_definition' if saved['definition'] == current.get('definition') else
                   'definition_differs' if current.get('definition') else 'current_definition_unknown')
    elif not current.get('available'):
        verdict = 'current_result_unknown'
    elif saved.get('value_hash') and current.get('value_hash'):
        verdict = 'same_as_current' if saved['value_hash'] == current['value_hash'] else 'discriminating'
    elif saved.get('result_version') and saved.get('result_version') == current.get('result_version'):
        verdict = 'same_as_current'
    else:
        verdict = 'unknown'
    return {'kind': kind, 'operator': operator, 'task': n, 'turn': turn, 'verdict': verdict,
            'scope': 'definition' if definition else 'data', 'saved_version_recorded_at': n if saved else None,
            'changed_after_by_tasks': []}


def compact_capture(capture, value_cache=None):
    state = {}
    tables = visible_tables(capture)
    operators = capture.get('snapshot', {}).get('workflow', {}).get('operators', [])
    saved_handles = {op['operatorID']: f"{op['savedResult']['operatorId']}@{op['savedResult']['taskId']}"
                     for op in operators if op.get('savedResult')}
    for op in operators:
        if op.get('savedResult'):
            continue
        name = op['operatorID']
        info = capture.get('snapshot', {}).get('results', {}).get(name, {})
        table = tables.get(name, {})
        version = info.get('resultVersion') or table.get('version') or {}
        version_id = version.get('id') if isinstance(version, dict) else version
        native = op.get('nativeOp') or {}
        semantic_inputs = [saved_handles.get(i, i) for i in native.get('inputs', [])]
        definition = (hashlib.sha256(json.dumps({'type': native['type'], 'inputs': semantic_inputs,
                                                'properties': native.get('properties', {})},
                                               sort_keys=True).encode()).hexdigest() if native.get('type') else None)
        value_hash = None
        if table.get('complete') and 'rows' in table:
            cache_key = (name, version_id)
            if value_cache is not None and version_id and cache_key in value_cache:
                value_hash = value_cache[cache_key]
            else:
                value_hash = rows_digest(table['rows'])
                if value_cache is not None and version_id:
                    value_cache[cache_key] = value_hash
        state[name] = {'present': True, 'available': not info.get('error') and info.get('state') in ('Completed', 'CompletedFromCache'),
                       'result_version': version_id,
                       'definition': definition, 'operator_revision': native.get('revision'),
                       'inputs': semantic_inputs,
                       'value_hash': value_hash}
    return state


def apply_edit(state, output):
    for name in output.get('invalidated_results', []):
        if name in state:
            state[name] = {**state[name], 'available': False, 'value_hash': None, 'result_version': None}
    for change in output.get('changes', []):
        name = change.get('operator_id')
        verb = change.get('operation')
        if verb == 'delete_operator':
            state.pop(name, None)
        elif name and verb in ('create_operator', 'update_operator', 'copy_definition', 'restore_operator'):
            state[name] = {**state.get(name, {}), 'present': True, 'available': False, 'definition': None,
                           'value_hash': None, 'result_version': None}
    for block in output.get('operator_blocks', []):
        if block.get('id') in state and block.get('inputs') is not None:
            inputs = [i['id'] if isinstance(i, dict) else i for i in block['inputs']]
            if inputs != state[block['id']].get('inputs'):
                state[block['id']]['definition'] = None
            state[block['id']]['inputs'] = inputs


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
            if verb == 'delete':
                existing.discard(op)
            else:
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
        states, sealed, versions, value_cache, definitions = {}, {}, {}, {}, {}
        for record in records:
            capture = capture_at(run, record['turn_id'])
            state = compact_capture(capture, value_cache) if capture else {}
            del capture  # Do not retain a full observer while loading the next one.
            states[record['turn_id']] = state
            if record['completed']:
                sealed[record['turn_id']] = state
            for name, value in state.items():
                if value.get('available') and value.get('result_version'):
                    versions[(name, value['result_version'])] = value
                if value.get('operator_revision') and value.get('definition'):
                    definitions[(name, value['operator_revision'])] = value['definition']
        existing = set()
        for record in records:
            turn = record['turn_id']
            requested, malformed = normalized_native_actions(record)
            trace_path = run / f't{turn:02d}' / 'react_steps.json.gz'
            with gzip.open(trace_path, 'rt') as source:
                steps = json.load(source)['steps']
            current = deepcopy(states.get(turn - 1, {}))
            actions, classified = [], []
            for step in steps:
                for receipt in step.get('toolResults', []):
                    batch = receipt.get('output')
                    if not isinstance(batch, dict):
                        continue
                    for item in batch.get('actions', []):
                        if item.get('status') != 'ok':
                            continue
                        action = item.get('action')
                        if not isinstance(action, dict):
                            continue
                        # A read's exact result identity can resolve state at
                        # access even if the same immutable proof was exported
                        # only at the turn boundary. Never use a different ID.
                        for ref in batch.get('references', []):
                            if ref.get('actionIndex') != item.get('index') or ref.get('savedTaskId') is not None:
                                continue
                            name = ref.get('operatorId')
                            proof = versions.get((name, ref.get('resultVersion')))
                            if proof:
                                current[name] = deepcopy(proof)
                            elif name in current and ref.get('operatorRevision'):
                                current[name]['definition'] = definitions.get((name, ref['operatorRevision']))
                        actions.append(action)
                        for ref in references_in([action]):
                            classified.append(classify(ref, turn, sealed.get(ref[2], {}), current))
                        output = item.get('output')
                        if action.get('type') == 'edit' and isinstance(output, dict):
                            apply_edit(current, output)
                        elif action.get('type') == 'execute' and isinstance(output, dict):
                            for op in output.get('operators', []):
                                if op.get('state') != 'executed' or op.get('id') not in current:
                                    continue
                                current[op['id']].update(available=False, value_hash=None, result_version=None)
            judged = metrics.get((key, turn), {}).get('judge', {}).get('score')
            expected = gold[turn - 1]
            labels = expected.get('state_type', [])
            depends = expected.get('depends_tasks', [])
            edits = edits_in(actions, existing)
            referenced_tasks = sorted({ref['task'] for ref in classified})
            turns.append({'run': key, 'model': job['model'], 'context': job['context'], 'turn': turn, 'score': judged,
                          'labels': labels, 'depends_tasks': depends, 'referenced_tasks': referenced_tasks,
                          'malformed_tool_calls': malformed, 'requested_references': len(references_in(requested)),
                          'successful_references': len(classified),
                          'references_in_depends': sum(t in depends for t in referenced_tasks),
                          'discriminating_references': sum(c['scope'] == 'data' and c['verdict'] in ('discriminating', 'operator_absent_now') for c in classified),
                          'same_as_current_references': sum(c['verdict'] == 'same_as_current' for c in classified),
                          'edits': dict(edits), 'calls': record['stats'].get('llm_calls'), 'cost_usd': record['stats'].get('cost_usd')})
            for c in classified:
                rows.append({'run': key, 'model': job['model'], 'context': job['context'], 'score': judged, 'labels': labels, **c})
            if not classified:
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
    disc = [r for r in rows if r.get('scope') == 'data' and r['verdict'] in ('discriminating', 'operator_absent_now')]
    print('discriminating references:', len(disc), 'in', len({(r["run"], r["turn"]) for r in disc}), 'turns')
    for r in disc[:20]:
        print(f"  {r['run']} t{r['turn']:02d} {r['kind']} {r['operator']}@{r['task']} score={r['score']} labels={r['labels']} changed_after={r['changed_after_by_tasks']}")
    print('written', out)


if __name__ == '__main__':
    main()
