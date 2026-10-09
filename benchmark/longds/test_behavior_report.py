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

import gzip
import json
from pathlib import Path
import tempfile
import unittest

from behavior_report import combine, session_behavior

SCORES = '''def unit_scores(orders, *, min_orders=5):
    """Score per unit with at least min_orders orders."""
    kept = orders[orders["orders"] >= min_orders]
    return kept.assign(score=kept["value"] / kept["orders"])
'''


def question(*calls):
    """One request's steps: each call is a list of (action, status)."""
    steps = [{'role': 'user', 'isBegin': True, 'content': 'request'}]
    for i, actions in enumerate(calls):
        steps.append({'role': 'agent',
                      'toolCalls': [{'toolName': 'dataflow', 'toolCallId': f'c{i}',
                                     'input': {'reasoning': '', 'actions': [a for a, _ in actions]}}],
                      'toolResults': [{'toolCallId': f'c{i}', 'output': {'actions': [
                          {'index': j, 'status': s} for j, (_, s) in enumerate(actions)]}}]})
    return steps


def edit(changes, python=''):
    return {'type': 'edit', 'python': python, 'changes': changes}


class BehaviorReportTest(unittest.TestCase):
    def session(self, questions, labels):
        folder = Path(tempfile.mkdtemp())
        for number, steps in enumerate(questions, 1):
            (folder / f't{number:02d}').mkdir()
            with gzip.open(folder / f't{number:02d}' / 'react_steps.json.gz', 'wt') as out:
                json.dump({'steps': steps}, out)
        return session_behavior(folder, labels)

    def test_versions_settings_and_reuse_count_only_committed_edits(self):
        b = self.session([
            question([(edit("set orders: scan(files='o.csv')\nset scores: unit_scores(orders, min_orders=5, doc='five')\n"
                            "set ranked: sort(scores, by=[('score', 'desc')])\nset top: limit(ranked, n=3)", SCORES), 'ok')]),
            # A rule change: the same function and inputs with another setting.
            question([(edit("set scores: unit_scores(orders, min_orders=10, doc='ten')"), 'ok')]),
            # An earlier state, and an alternative alongside with the same function.
            question([(edit("set newcomers: join(top, top@1, on=['unit'], how='anti')\n"
                            "set strict: unit_scores(orders, min_orders=20)"), 'ok')]),
            # A rejected edit commits nothing; a new function calls an earlier one; a copy.
            question([(edit("set old: limit(top@2, n=1)"), 'error'),
                      (edit("set both: blend(scores)",
                            'def blend(table):\n    return unit_scores(table, min_orders=1)\n'
                            + SCORES.replace('unit_scores', 'unit_scores_again')), 'ok')]),
        ], [['Initial'], ['Update'], ['Rollback', 'Counterfactual'], ['Initial']])
        self.assertEqual(b['version_inputs'], 1)
        self.assertEqual(b['settings_resets'], 1)
        # scores again in question 2, strict in 3; blend is new in 4.
        self.assertEqual(b['earlier_function_calls'], 2)
        self.assertEqual(b['earlier_function_code_calls'], 1)
        self.assertEqual(b['near_copies'], 1)
        self.assertEqual(b['functions_defined'], 3)
        self.assertEqual(b['functions_with_settings'], 2)
        self.assertEqual(b['setting_names'], {'min_orders': 2})
        self.assertEqual(b['new_operators_after_first'], 3)
        self.assertEqual(b['new_operators_reading_earlier_tables'], 3)
        self.assertEqual(b['rollback_or_counterfactual'],
                         {'questions': 1, 'with_version_input': 1, 'with_earlier_function_call': 1, 'with_settings_reset': 0})
        self.assertEqual(b['new_functions_per_question'], 0.75)

    def test_sessions_of_one_arm_combine(self):
        one = self.session([question([(edit("set t: scan(files='a.csv')"), 'ok')])], [['Initial']])
        both = combine([one, one])
        self.assertEqual(both['questions'], 2)
        self.assertEqual(both['statements'], 2)
        self.assertEqual(both['rollback_or_counterfactual']['questions'], 0)
        self.assertEqual(both['new_functions_per_question'], 0)
        self.assertEqual(combine([]), {})


if __name__ == '__main__':
    unittest.main()
