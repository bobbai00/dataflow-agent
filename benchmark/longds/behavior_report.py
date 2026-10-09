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

"""How a registered-protocol session carried state across its questions.

Read from committed edits only: `name@N` inputs, calls of functions an earlier
question defined (in statements and inside new code), operators set again with
only their settings changed, which settings functions take, and how much new
code each question wrote. A rejected edit committed nothing and counts nothing.
"""

import argparse
import ast
from collections import Counter
import difflib
import gzip
import json
from pathlib import Path
import re
import statistics

BUILTINS = {'scan', 'project', 'cast', 'filter', 'aggregate', 'join', 'union', 'distinct', 'sort', 'limit',
            'window', 'unpivot', 'pivot'}
# A new public function this similar to an earlier one, names aside, is a copy.
COPY_SIMILARITY = 0.75


def committed_edits(steps):
    """Edit actions whose receipt says they committed, in call order."""
    for step in steps:
        for call, result in zip(step.get('toolCalls') or [], step.get('toolResults') or []):
            outcomes = (result.get('output') or {}).get('actions') or []
            for index, action in enumerate((call.get('input') or {}).get('actions') or []):
                status = next((o.get('status') for o in outcomes if o.get('index') == index),
                              outcomes[index].get('status') if index < len(outcomes) else None)
                if action.get('type') == 'edit' and status == 'ok':
                    yield action


def statement(line):
    """`set id: f(inputs, setting=value)` as its id, callee, inputs and settings (doc excluded)."""
    match = re.match(r'\s*set\s+([A-Za-z_]\w*)\s*:\s*(.+)$', line)
    if not match:
        return None
    try:
        call = ast.parse(match[2].strip(), mode='eval').body
    except SyntaxError:
        return None
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
        return None
    inputs = [ast.unparse(arg).replace(' ', '') for arg in call.args]
    settings = {k.arg: ast.unparse(k.value) for k in call.keywords if k.arg not in (None, 'doc')}
    return {'id': match[1], 'function': call.func.id, 'inputs': inputs, 'settings': settings}


def public_functions(python):
    try:
        tree = ast.parse(python or '')
    except SyntaxError:
        return []
    found = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and not node.name.startswith('_'):
            args = node.args
            settings = [a.arg for a in args.kwonlyargs]
            calls = {n.func.id for n in ast.walk(node) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
            found.append({'name': node.name, 'source': ast.get_source_segment(python, node) or '',
                          'settings': settings, 'calls': calls})
    return found


def session_behavior(run, state_types):
    """`run` holds one folder per question, `tNN/react_steps.json.gz`; `state_types`
    lists each question's gold labels, in order."""
    statements, definitions = [], []
    for number in range(1, len(state_types) + 1):
        path = Path(run) / f't{number:02d}' / 'react_steps.json.gz'
        steps = json.load(gzip.open(path))['steps'] if path.exists() else []
        for edit in committed_edits(steps):
            for line in (edit.get('changes') or '').splitlines():
                parsed = statement(line)
                if parsed:
                    statements.append({**parsed, 'question': number})
            definitions += [{**f, 'question': number} for f in public_functions(edit.get('python'))]
    defined_at = {}
    for f in definitions:
        defined_at.setdefault(f['name'], f['question'])
    created_at = {}
    for s in statements:
        created_at.setdefault(s['id'], s['question'])

    version_inputs = [(s['question'], s['id'], i) for s in statements for i in s['inputs'] if '@' in i]
    earlier_calls = [s for s in statements
                     if s['function'] not in BUILTINS and defined_at.get(s['function'], s['question']) < s['question']]
    first_definitions = [f for f in definitions if defined_at[f['name']] == f['question']]
    code_calls = [f for f in first_definitions
                  if any(defined_at.get(c, f['question']) < f['question'] for c in f['calls'] - {f['name']})]
    last, settings_resets = {}, []
    for s in statements:
        before = last.get(s['id'])
        if (before and before['question'] < s['question'] and before['function'] == s['function']
                and before['inputs'] == s['inputs'] and before['settings'] != s['settings']):
            settings_resets.append(s)
        last[s['id']] = s
    copies, seen = [], []
    for f in first_definitions:
        body = re.sub(r'def \w+', 'def f', f['source'])
        if any(g['question'] < f['question'] and difflib.SequenceMatcher(
                None, body, re.sub(r'def \w+', 'def f', g['source'])).ratio() >= COPY_SIMILARITY for g in seen):
            copies.append(f['name'])
        seen.append(f)
    created = [s for s in statements if created_at[s['id']] == s['question'] and s['question'] > 1]
    reading_earlier = [s for s in created
                       if any(created_at.get(i.split('@')[0], s['question']) < s['question'] for i in s['inputs'])]
    per_question = Counter(f['question'] for f in first_definitions)
    revisiting = [n for n, labels in enumerate(state_types, 1) if {'Rollback', 'Counterfactual'} & set(labels)]

    def questions_with(items):
        return sorted({item['question'] if isinstance(item, dict) else item[0] for item in items})

    return {
        'questions': len(state_types),
        'version_inputs': len(version_inputs),
        'statements': len(statements),
        'functions_defined': len(defined_at),
        'functions_with_settings': len({f['name'] for f in first_definitions if f['settings']}),
        'setting_names': dict(Counter(name for f in first_definitions for name in f['settings']).most_common(8)),
        'earlier_function_calls': len(earlier_calls),
        'earlier_function_code_calls': len(code_calls),
        'settings_resets': len(settings_resets),
        'near_copies': len(copies),
        'new_functions_per_question': round(statistics.mean(per_question.get(n, 0) for n in range(1, len(state_types) + 1)), 2)
        if state_types else 0,
        'new_operators_after_first': len(created),
        'new_operators_reading_earlier_tables': len(reading_earlier),
        'rollback_or_counterfactual': {
            'questions': len(revisiting),
            'with_version_input': len(set(revisiting) & set(questions_with(version_inputs))),
            'with_earlier_function_call': len(set(revisiting) & set(questions_with(earlier_calls))),
            'with_settings_reset': len(set(revisiting) & set(questions_with(settings_resets))),
        },
    }


def combine(behaviors):
    """Several sessions of one arm: counts add up, settings merge, the mean is recomputed."""
    if not behaviors:
        return {}
    total = {}
    for b in behaviors:
        for key, value in b.items():
            if key == 'new_functions_per_question':
                continue
            if isinstance(value, dict):
                merged = total.setdefault(key, {})
                for k, v in value.items():
                    merged[k] = merged.get(k, 0) + v
            else:
                total[key] = total.get(key, 0) + value
    total['new_functions_per_question'] = round(
        sum(b['new_functions_per_question'] * b['questions'] for b in behaviors) / max(total['questions'], 1), 2)
    return total


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path, help='a session folder with tNN/react_steps.json.gz')
    parser.add_argument('metadata', type=Path, help="the session's metadata.json with state_type per question")
    arguments = parser.parse_args()
    labels = [entry.get('state_type', []) for entry in json.loads(arguments.metadata.read_text())]
    print(json.dumps(session_behavior(arguments.run, labels), indent=2))
