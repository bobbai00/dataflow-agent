# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Small diagnostic, not a representative benchmark. Gold is evaluator-only.

Generate: python study.py generate /tmp/study --seed 41
Score:    python study.py score /tmp/study /tmp/run
"""
import argparse
import ast
import csv
import json
import random
from pathlib import Path


def report(rows, cutoff=12, deduct_refunds=True, membership=None, segment=None):
    groups = {}
    for row in rows:
        if membership is not None:
            if row['customer'] not in membership:
                continue
        elif row['orders'] < cutoff:
            continue
        if segment is not None and row['segment'] != segment:
            continue
        group = groups.setdefault(row['region'], [0, 0.0, 0.0, 0.0])
        for i, value in enumerate([1, row['gross'], row['cost'], row['refunds']]):
            group[i] += value
    scores = [(region, 100 * (gross - cost - (refunds if deduct_refunds else 0)) / gross)
              for region, (count, gross, cost, refunds) in groups.items() if count >= 2]
    scores.sort(key=lambda item: (-item[1], item[0]))
    return {'regions': [r for r, _ in scores[:2]], 'scores': [round(s, 6) for _, s in scores[:2]]}


def generate(directory, seed):
    directory.mkdir(parents=True, exist_ok=False)
    rng = random.Random(seed)
    rows = []
    for region in ['East', 'North', 'South', 'West']:
        for i in range(16):
            gross = float(rng.randrange(800, 2600))
            rows.append(dict(customer=f'{region[0]}{i:02}', region=region,
                             segment='trial' if i % 2 == 0 else 'core', orders=float(rng.choice([3, 6, 9, 13, 18, 24])),
                             gross=gross, cost=round(gross * rng.uniform(.3, .82), 2),
                             refunds=round(gross * rng.uniform(.02, .32), 2)))
    fresh = []
    for row in rows:
        new = dict(row)
        new['orders'] = float(rng.choice([3, 6, 9, 13, 18, 24]))
        new['gross'] = float(rng.randrange(700, 3000))
        new['cost'] = round(new['gross'] * rng.uniform(.25, .9), 2)
        new['refunds'] = round(new['gross'] * rng.uniform(.01, .38), 2)
        fresh.append(new)
    files = [directory / 'customers_v1.csv', directory / 'customers_v2.csv']
    for path, data in zip(files, [rows, fresh]):
        with path.open('w') as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader(); writer.writerows(data)
    original_ids = {r['customer'] for r in rows if r['orders'] >= 12}
    initial = report(rows)
    revised = report(fresh, 5, False)
    common = 'Return JSON with regions (ranked region names) and scores (corresponding margin percentages, at least four decimal places).'
    turns = [
        ('initial', f'Use {files[0]} as our data. Each row is a unique customer. Our initial report selects customers with orders >= 12, groups by region, sums gross, cost and refunds, then computes margin percent as 100*(sum(gross)-sum(cost)-sum(refunds))/sum(gross). Keep regions with at least two eligible customers, rank by margin descending and region alphabetically for ties, and report the top two. Establish this as the default and preserve this published baseline for later comparisons. ' + common, initial),
        ('persistent_cohort', 'Broaden the default eligibility rule to orders >= 5. Keep all other rules and use our original data. Publish the revised default report. ' + common, report(rows, 5)),
        ('persistent_metric', 'Revise the default margin definition to ignore refunds: 100*(sum(gross)-sum(cost))/sum(gross). Keep the current eligibility and other report rules. Publish it. ' + common, report(rows, 5, False)),
        ('local_original_recipe', 'For a temporary sensitivity check, take only trial customers and apply our INITIAL report definition in full, including its original eligibility and margin formula. Use original data. Leave the default and published baseline unchanged. ' + common, report(rows, segment='trial')),
        ('mixed_membership', 'Another temporary check: take exactly the customer membership admitted by the INITIAL eligibility rule on our original data, and score them with the CURRENT default margin definition. Use original data and keep the default unchanged. ' + common, report(rows, deduct_refunds=False, membership=original_ids)),
        ('recipe_new_data', f'A new export is available at {files[1]}. Temporarily apply the INITIAL report definition in full to this new export, recomputing eligibility from its values. Also repeat the ORIGINAL published baseline for comparison. Do not change our default. ' + common + ' Include baseline_regions and baseline_scores from the original publication.', {**report(fresh), 'baseline_regions': initial['regions'], 'baseline_scores': initial['scores']}),
        ('default_preservation', 'Return to our current default report on the ORIGINAL export. The temporary checks must not change it. ' + common, report(rows, 5, False)),
        ('membership_new_data', 'Temporarily use the new export values for exactly the customer IDs admitted by the INITIAL eligibility rule on the ORIGINAL export. Apply the CURRENT default margin formula. Do not re-evaluate membership using the new export orders. Keep all other report rules and the default unchanged. ' + common, report(fresh, deduct_refunds=False, membership=original_ids)),
        ('adopt_data_compare', 'Now adopt the new export as default data, retaining the CURRENT default eligibility rule and margin formula. Recompute eligibility on the new values and publish the report. Also give delta: the new top-ranked margin minus the top-ranked margin in our ORIGINAL published baseline, in percentage points. ' + common, {**revised, 'delta': round(revised['scores'][0] - initial['scores'][0], 6)}),
    ]
    public = {'seed': seed, 'files': [str(p) for p in files], 'turns': [{'id': name, 'prompt': prompt} for name, prompt, _ in turns]}
    (directory / 'session.json').write_text(json.dumps(public, indent=2))
    (directory / 'gold.json').write_text(json.dumps([gold for _, _, gold in turns], indent=2))
    print(directory / 'session.json')


def parse_answer(value):
    if isinstance(value, dict):
        return value
    decoder = json.JSONDecoder()
    found = []
    for offset, char in enumerate(str(value)):
        if char == '{':
            try:
                obj, _ = decoder.raw_decode(str(value)[offset:])
                if isinstance(obj, dict) and 'regions' in obj:
                    found.append(obj)
            except ValueError:
                pass
    if found:
        return found[-1]
    # CodeAgentWrapper stringifies a legitimate final_answer(dict) into Python
    # repr. Normalize this transport shape; do not call it an analysis failure.
    try:
        obj = ast.literal_eval(str(value).strip())
        return obj if isinstance(obj, dict) and 'regions' in obj else None
    except (ValueError, SyntaxError):
        return None


def score(directory, run):
    gold = json.loads((directory / 'gold.json').read_text())
    results = []
    for index, expected in enumerate(gold, 1):
        path = run / f't{index:02}'
        if not (path / 'answer.json').exists():
            continue
        raw = json.loads((path / 'answer.json').read_text())
        actual = parse_answer(raw.get('answer', raw.get('response', raw)))
        failures = []
        for key, value in expected.items():
            got = (actual or {}).get(key)
            if key.endswith('regions'):
                ok = got == value
            else:
                left = value if isinstance(value, list) else [value]
                right = got if isinstance(got, list) else [got]
                try:
                    ok = len(left) == len(right) and all(abs(float(a) - float(b)) <= .0001 for a, b in zip(left, right))
                except (ValueError, TypeError):
                    ok = False
            if not ok:
                failures.append(key)
        result = dict(turn=index, passed=not failures, failed_fields=failures, actual=actual, expected=expected)
        (path / 'evaluation.json').write_text(json.dumps(result, indent=2))
        stats = json.loads((path / 'stats.json').read_text())
        results.append({**result, **stats})
    summary = {'turns': len(results), 'passed': sum(r['passed'] for r in results),
               'cost_usd': sum(r['cost_usd'] for r in results), 'llm_calls': sum(r['llm_calls'] for r in results),
               'results': results}
    (run / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != 'results'}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['generate', 'score'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('run', type=Path, nargs='?')
    parser.add_argument('--seed', type=int, default=41)
    args = parser.parse_args()
    if args.action == 'generate': generate(args.directory.resolve(), args.seed)
    else: score(args.directory, args.run)
