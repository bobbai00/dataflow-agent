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
"""Strict reference-JSON agreement, kept separate from official judgments.

This diagnostic requires the reference's field names and array ordering.
It is intentionally not a semantic partial-accuracy score: equivalent answers
with other keys can score poorly. Missing leaves receive zero credit. No LLM,
field aliases, answer-dependent tolerances, or inferred causal error labels.
"""
from decimal import Decimal
import json
import math
import re


def component_rubric(reference):
    if not isinstance(reference, (dict, list)):
        return []
    leaves = []

    def visit(value, parts):
        if isinstance(value, dict):
            for key, child in value.items():
                visit(child, [*parts, str(key)])
        elif isinstance(value, list):
            for i, child in enumerate(value):
                visit(child, [*parts, i])
        else:
            numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
            if numeric and not math.isfinite(value):
                raise ValueError('Nonfinite reference value cannot be scored')
            decimals = max(3, -Decimal(str(value)).as_tuple().exponent) if isinstance(value, float) else 0
            leaves.append({'path': '/' + '/'.join(str(p).replace('~', '~0').replace('/', '~1') for p in parts),
                           'parts': parts, 'expected': value,
                           'absolute_tolerance': .5 * 10 ** -decimals if isinstance(value, float) else 0})
    visit(reference, [])
    return leaves


def score_components(answer, rubric):
    valid = True
    try:
        if isinstance(answer, str):
            text = answer.strip()
            if text.startswith('```') and text.endswith('```'):
                text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.I)[:-3].strip()
            value = json.loads(text, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
        else:
            value = answer
        if not isinstance(value, (dict, list)):
            raise ValueError('Answer must be a JSON collection')
    except (ValueError, TypeError):
        valid, value = False, None
    present = correct = 0
    for leaf in rubric:
        actual = value
        found = valid
        for part in leaf['parts']:
            if isinstance(part, int) and isinstance(actual, list) and 0 <= part < len(actual):
                actual = actual[part]
            elif isinstance(part, str) and isinstance(actual, dict) and part in actual:
                actual = actual[part]
            else:
                found = False
                break
        if not found:
            continue
        present += 1
        expected = leaf['expected']
        if isinstance(expected, (int, float)) and not isinstance(expected, bool):
            okay = (isinstance(actual, (int, float)) and not isinstance(actual, bool)
                    and math.isfinite(actual) and abs(actual - expected) <= leaf['absolute_tolerance'] + 1e-12)
        elif isinstance(expected, str):
            normalize = lambda text: ' '.join(text.split()).casefold()
            okay = isinstance(actual, str) and normalize(actual) == normalize(expected)
        else:
            okay = type(actual) is type(expected) and actual == expected
        correct += bool(okay)
    return {'format_json': valid, 'components_total': len(rubric), 'components_present': present,
            'components_correct': correct, 'presence_fraction': present / len(rubric) if rubric else None,
            'strict_component_score': correct / len(rubric) if rubric else None}
