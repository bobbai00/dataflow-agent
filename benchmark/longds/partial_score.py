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

"""Deterministic diagnostic credit for explicitly selected answer requirements.

Rubrics must select fields from the question before calling these helpers.
The score is not the benchmark's official binary grade. Unknown shapes must
remain unscored rather than being silently converted to an empty answer.
"""
from collections import Counter
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
from statistics import mean

MISSING = object()


def equivalent(expected, actual, decimals=None):
    if actual is MISSING:
        return False
    if isinstance(expected, bool) or isinstance(actual, bool):
        return type(expected) is type(actual) and expected == actual
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        try:
            left, right = Decimal(str(expected)), Decimal(str(actual))
            if not left.is_finite() or not right.is_finite():
                return False
            if decimals is not None:
                quantum = Decimal(1).scaleb(-decimals)
                left = left.quantize(quantum, rounding=ROUND_HALF_EVEN)
                right = right.quantize(quantum, rounding=ROUND_HALF_EVEN)
            return left == right
        except InvalidOperation:
            return False
    if isinstance(expected, str) and isinstance(actual, str):
        return " ".join(expected.split()) == " ".join(actual.split())
    if isinstance(expected, list) and isinstance(actual, list):
        # Unordered categorical sets, e.g. pressure-signal names. Row order is
        # handled explicitly by compare_table, not by this value comparator.
        return Counter(map(str, expected)) == Counter(map(str, actual))
    return type(expected) is type(actual) and expected == actual


def compare_scalars(expected, actual, decimals=None):
    facts = []
    for field, value in expected.items():
        found = actual.get(field, MISSING)
        facts.append({"field": field, "expected": value,
                      "actual": None if found is MISSING else found,
                      "missing": found is MISSING,
                      "match": equivalent(value, found, decimals)})
    matched = sum(f["match"] for f in facts)
    return {"matched": matched, "total": len(facts), "facts": facts,
            "partial_score": matched / len(facts) if facts else 1.0,
            "exact": matched == len(facts)}


def compare_table(expected, actual, key_fields, value_fields, *, ordered=False,
                  decimals=None, extra_fields=()):
    def key(row):
        return tuple(row.get(k, MISSING) for k in key_fields)

    gold_keys = [key(r) for r in expected]
    if any(MISSING in k for k in gold_keys) or len(set(gold_keys)) != len(gold_keys):
        raise ValueError("Missing or duplicate reference identity; fix the rubric.")
    supplied = actual is not None
    actual = actual or []
    keys = [key(r) for r in actual]
    counts = Counter(keys)
    gold = dict(zip(gold_keys, expected))
    # Duplicates never count as additional true matches. Conflicting duplicate
    # records are not arbitrarily selected for value credit.
    predicted = {key(r): r for r in actual if counts[key(r)] == 1 and MISSING not in key(r)}
    matched_keys = set(gold_keys) & set(keys)
    precision = len(matched_keys) / len(keys) if keys else float(not gold_keys and supplied)
    recall = len(matched_keys) / len(gold_keys) if gold_keys else float(supplied)
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    facts, extra = [], []
    for identity, row in gold.items():
        prediction = predicted.get(identity, {})
        audit = compare_scalars({k: row[k] for k in value_fields}, prediction, decimals)
        facts.extend({"key": list(identity), **f} for f in audit["facts"])
        reported = {k: row[k] for k in extra_fields if k in row and k in prediction}
        audit = compare_scalars(reported, prediction, decimals)
        extra.extend({"key": list(identity), **f} for f in audit["facts"])
    matched_values = sum(f["match"] for f in facts)
    value_accuracy = matched_values / len(facts) if facts else None
    order_accuracy = (sum(a == b for a, b in zip(gold_keys, keys)) / max(len(gold_keys), len(keys))
                      if gold_keys or keys else float(supplied)) if ordered else None
    axes = [f1] + [a for a in [value_accuracy, order_accuracy] if a is not None]

    def printable(identity):
        return [None if v is MISSING else v for v in identity]

    return {"identity_precision": precision, "identity_recall": recall, "identity_f1": f1,
            "expected_rows": len(expected), "reported_rows": len(actual),
            "missing_answer": not supplied,
            "missing_keys": [printable(k) for k in gold_keys if k not in counts],
            "extra_keys": [printable(k) for k in keys if k not in gold],
            "duplicate_keys": [printable(k) for k, n in counts.items() if n > 1],
            "value_accuracy": value_accuracy, "matched_values": matched_values,
            "requested_values": len(facts), "facts": facts, "order_accuracy": order_accuracy,
            "partial_score": mean(axes), "exact": supplied and all(a == 1 for a in axes),
            "reported_extra_values": {"matched": sum(f["match"] for f in extra),
                                      "total": len(extra), "facts": extra}}
