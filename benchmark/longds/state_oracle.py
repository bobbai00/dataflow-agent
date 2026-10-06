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

"""Evaluator-only state checks shared by checkpoint and natural-session runs.

Semantic anchors are explicit adapters, not guesses from an operator's name.
Dependency scores describe agreement with task annotations, not unique valid
algorithms. Unavailable observations remain unknown and coverage is reported.
"""
import math
from numbers import Real
import pandas as pd


def compare_state_table(expected, actual, keys, columns, *, atol=1e-8, rtol=1e-8):
    if actual is None:
        return {'match': None, 'coverage': 0, 'reason': 'unavailable'}
    needed = list(dict.fromkeys([*keys, *columns]))
    if any(c not in actual.columns for c in needed):
        return {'match': None, 'coverage': 0, 'reason': 'missing_columns'}
    if any(c not in expected.columns for c in needed):
        raise ValueError('Oracle anchor columns are missing')
    if expected.duplicated(keys).any():
        raise ValueError('Oracle keys must be unique')
    if actual.duplicated(keys).any():
        return {'match': False, 'coverage': 1, 'reason': 'duplicate_keys'}
    left = expected[needed].set_index(keys).sort_index()
    right = actual[needed].set_index(keys).sort_index()
    keys_match = left.index.equals(right.index)
    expected_rows, actual_rows = len(left), len(right)
    common = left.index.intersection(right.index)
    left, right = left.loc[common], right.loc[common]
    matched = 0
    total = expected_rows * len(columns)
    for name in columns:
        for a, b in zip(left[name], right[name]):
            if pd.isna(a) and pd.isna(b):
                okay = True
            elif pd.isna(a) or pd.isna(b):
                okay = False
            elif isinstance(a, Real) and not isinstance(a, bool):
                try:
                    okay = math.isclose(float(a), float(b), abs_tol=atol, rel_tol=rtol)
                except (ValueError, TypeError):
                    okay = False
            else:
                okay = a == b
            matched += bool(okay)
    return {'match': keys_match and matched == total, 'coverage': 1, 'matched_values': matched,
            'total_values': total, 'value_score': matched / total if total else 1,
            'expected_rows': expected_rows, 'actual_rows': actual_rows,
            'key_precision': len(common) / actual_rows if actual_rows else None,
            'key_recall': len(common) / expected_rows if expected_rows else None,
            'reason': 'different_keys' if not keys_match else 'match' if matched == total else 'different_values'}

def dependency_agreement(references, expected_tasks):
    uses = [r for r in references if r.get('kind') in {'read', 'compute', 'definition'}]
    observed = {r['task_id'] for r in uses if isinstance(r.get('task_id'), int)}
    unknown = sum(not isinstance(r.get('task_id'), int) for r in uses)
    expected = set(expected_tasks)
    overlap = observed & expected
    return {'observed': sorted(observed), 'expected': sorted(expected),
            'precision': len(overlap) / len(observed) if observed else None,
            'recall': len(overlap) / len(expected) if expected and (observed or not unknown) else None,
            'unresolved': unknown,
            'coverage': (len(uses) - unknown) / len(uses) if uses else None,
            'metric': 'task_annotation_agreement'}

def classify_update(changed, matches_current, matches_previous):
    if not changed:
        return 'unchanged'
    if matches_current is True:
        return 'updated'
    if matches_current is False and matches_previous is True:
        return 'stale'
    if matches_current is False:
        return 'incorrect'
    return 'unknown'


def annotated_closure(turns, task_id):
    """All earlier annotated dependencies, not just adjacent-task edges."""
    by_id = {t['turn_id']: t for t in turns}
    result = set()
    active = set()

    def visit(number):
        if number in active:
            raise ValueError('Dependency annotation contains a cycle')
        if number not in by_id:
            raise ValueError('Dependency annotation names an unknown task')
        active.add(number)
        for parent in by_id[number].get('depends_tasks', []):
            if parent >= number:
                raise ValueError('Dependencies must name earlier tasks')
            if parent not in result:
                result.add(parent)
                visit(parent)
        active.remove(number)

    visit(task_id)
    return sorted(result)


def script_answer_references(records, current):
    """Follow named answer bindings through observed script-block writes.

    Unrelated inspections and scripts are excluded. A block that computes two
    outputs shares conservative parent reads; this is not column-level lineage.
    """
    nodes = {}
    for record in records:
        # A later same-value write can have the same content hash and a
        # different producer. It cannot become an earlier answer's parent.
        if record.get('turn_id', current['turn_id']) > current['turn_id']:
            continue
        for script in record.get('scripts', []):
            for name, binding in script.get('written_bindings', {}).items():
                nodes[(name, binding['version'])] = binding
    references = []
    seen = set()

    def visit(name, binding):
        key = (name, binding.get('version'))
        if key in seen:
            return
        seen.add(key)
        task = binding.get('changed_task')
        if task != current['turn_id']:
            references.append({'kind': 'read', 'task_id': task, 'name': name, 'version': key[1]})
        for parent in binding.get('parents', []):
            earlier = nodes.get((parent['name'], parent['version']))
            if earlier is None:
                references.append({'kind': 'read', 'task_id': parent.get('task_id'),
                                   'name': parent['name'], 'version': parent['version'], 'unresolved_binding': True})
            else:
                visit(parent['name'], earlier)

    for name, binding in current.get('source_bindings', {}).items():
        visit(name, binding)
    return references


def native_answer_references(capture, task_id):
    """Declared answer-root graph closure, with definition/fork provenance.

    This measures the declared computation graph, not reads inside a Python
    callback. Result consultations outside that closure are excluded.
    """
    tasks = capture['history']['tasks']
    current = next((t for t in tasks if t['task_id'] == task_id), None)
    if not current or current.get('output_roots', {}).get('basis') != 'answer':
        return [{'kind': 'definition', 'task_id': None, 'reason': 'unknown_answer_roots'}]
    workflow = capture['snapshot'].get('workflow') or {}
    operators = {o['operatorID']: o for o in workflow.get('operators', [])}
    inputs = {}
    for edge in workflow.get('links', []):
        inputs.setdefault(edge['target']['operatorID'], []).append(edge['source']['operatorID'])
    owners = {}
    for task in tasks:
        for op in task['operators']:
            if op['change'] in {'created', 'updated'}:
                owners[(op['operator_id'], op.get('revision'))] = task['task_id']
    records, accumulated = {}, {}
    for task in tasks:
        for op in task.get('operators', []):
            if op.get('change') == 'deleted':
                accumulated.pop(op['operator_id'], None)
            else:
                accumulated[op['operator_id']] = op
        records[task['task_id']] = dict(accumulated)
    references, seen = [], set()

    def visit(op_id, saved_task=None):
        key = (op_id, saved_task)
        if key in seen:
            return
        seen.add(key)
        if saved_task is not None and saved_task != task_id:
            node = records.get(saved_task, {}).get(op_id)
            if node is None:
                # Read-only result handles are excluded from the visible
                # operator delta. Their immutable savedResult descriptor is
                # still available in the captured graph. Only handles may
                # resolve through today's graph, never a mutable definition.
                handle = operators.get(op_id, {}).get('savedResult')
                if handle:
                    visit(handle['operatorId'], handle['taskId'])
                    return
                references.append({'kind': 'definition', 'task_id': saved_task,
                                   'operator_id': op_id, 'unresolved_operator': True})
                return
            historical_handle = node.get('saved_result')
            if historical_handle:
                visit(historical_handle['operatorId'], historical_handle['taskId'])
                return
            owner = owners.get((op_id, node.get('revision')), saved_task)
            references.append({'kind': 'read', 'task_id': saved_task, 'operator_id': op_id,
                               'definition_task': owner})
            for parent in node.get('inputs', []):
                visit(parent, saved_task)
            return
        op = operators.get(op_id)
        if op is None:
            references.append({'kind': 'definition', 'task_id': saved_task, 'operator_id': op_id})
            return
        saved = op.get('savedResult')
        if saved:
            visit(saved['operatorId'], saved['taskId'])
            return
        origin = op.get('stateOrigin')
        owner = origin.get('taskId') if origin else owners.get((op_id, op.get('nativeOp', {}).get('revision')))
        if owner != task_id:
            references.append({'kind': 'definition', 'task_id': owner, 'operator_id': op_id})
        for parent in inputs.get(op_id, []):
            visit(parent)

    for root in current['output_roots']['roots']:
        visit(root['operator_id'], root.get('task_id'))
    return references
