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
"""Six controlled eight-task sessions with private, prespecified state checks.

Gold uses loops over generated records. Agents see only session.json and CSVs.
These are mechanism probes, not independent real-world benchmark domains.
"""
import argparse
import json
from pathlib import Path
import runpy

HERE = Path(__file__).resolve().parent
write_case = runpy.run_path(str(HERE / 'task-study.py'))['write_case']


def metadata(directory, overrides=None, corrections=()):
    gold = json.loads((directory / 'gold.json').read_text())
    checks = [{'fields': {}, 'correction': i in corrections} for i in range(1, len(gold) + 1)]
    for task, fields in (overrides or {}).items():
        checks[task - 1]['fields'] = fields
    (directory / 'checks.json').write_text(json.dumps(checks, indent=2))


def extend(directory, tasks):
    session = json.loads((directory / 'session.json').read_text())
    gold = json.loads((directory / 'gold.json').read_text())
    for ident, prompt, answer in tasks:
        session['turns'].append(dict(id=ident, prompt=prompt)); gold.append(answer)
    (directory / 'session.json').write_text(json.dumps(session, indent=2))
    (directory / 'gold.json').write_text(json.dumps(gold, indent=2))


def generate(root):
    runpy.run_path(str(HERE / 'state-study.py'))['generate'](root)
    directory = root / 'fanout_correction'
    g = json.loads((directory / 'gold.json').read_text())
    extend(directory, [
        ('restore_cost', 'Set the extra cost surcharge back to zero, retaining the returns correction and full default population. Return JSON total, regional, units.', g[2]),
        ('mixed_reports', 'Using the current default, report West-only profit as west_total, full-portfolio units as units, and repeat the originally published East-only temporary profit as temporary_total. This is a temporary check; leave default unchanged. Return JSON west_total, units, temporary_total.', dict(west_total=g[2]['regional']['West'], units=g[2]['units'], temporary_total=g[1]['total'])),
        ('publication', 'Report our current full operating report together with the original published baseline total. Return JSON total, regional, units, baseline_total.', {**g[2], 'baseline_total': g[0]['total']}),
    ])
    metadata(directory, {
        3: dict(total='update', regional='update', units='preservation'),
        5: dict(total='update', regional='update', units='preservation', baseline_total='preservation', temporary_total='preservation'),
        6: dict(total='update', regional='update', units='preservation'),
        7: dict(west_total='selection', units='preservation', temporary_total='preservation'),
        8: dict(total='update', regional='update', units='preservation', baseline_total='preservation'),
    }, corrections=(3,))
    directory = root / 'temporary_scope'
    g = json.loads((directory / 'gold.json').read_text())
    active = dict(bill=576.0, intensity=g[0]['intensity'])
    extend(directory, [
        ('adopt_again', 'Adopt tariff 0.40 as the default over all original buildings. Return JSON bill, intensity.', active),
        ('detour', 'Separately report total energy across the original portfolio. Keep all tariffs and scenarios unchanged. Return JSON kwh.', dict(kwh=1440)),
        ('all_states', 'Report the active default bill and intensity, the original published baseline_bill, the original South stress_bill, and the earlier North comparison bill as north_bill. Return JSON bill, intensity, baseline_bill, stress_bill, north_bill.', {**active, 'baseline_bill': g[0]['bill'], 'stress_bill': g[2]['bill'], 'north_bill': g[3]['bill']}),
    ])
    metadata(directory, {
        2: dict(bill='update', intensity='preservation'),
        5: dict(bill='selection', intensity='preservation', baseline_bill='preservation', stress_bill='preservation'),
        6: dict(bill='update', intensity='preservation'),
        8: dict(bill='selection', intensity='preservation', baseline_bill='preservation', stress_bill='preservation', north_bill='preservation'),
    })
    directory = root / 'membership_values'
    g = json.loads((directory / 'gold.json').read_text())
    extend(directory, [
        ('original_a', 'Temporarily take the ORIGINAL cohort IDs from the first publication, restrict those patients to clinic A, and sum their values in the new export. Do not re-evaluate risk. Leave default unchanged. Return JSON count, value.', dict(count=2, value=814)),
        ('tighten', 'Set CURRENT default eligibility to risk >= 6 on the adopted new export. Return JSON count, value.', dict(count=2, value=1414)),
        ('compare', 'Repeat the current default count and total value, and the original publication count and value. Return JSON count, value, baseline_count, baseline_value.', dict(count=2, value=1414, baseline_count=g[0]['count'], baseline_value=g[0]['value'])),
    ])
    metadata(directory, {
        3: dict(count='selection', value='selection'), 4: dict(count='selection', value='selection'),
        5: dict(count='update', value='update', baseline_count='preservation', baseline_value='preservation'),
        6: dict(count='selection', value='selection'), 7: dict(count='update', value='update'),
        8: dict(count='update', value='update', baseline_count='preservation', baseline_value='preservation'),
    })

    old = [dict(name=chr(65+i), base=20+i, current=20+i+gain) for i, gain in enumerate([12, 8, 7, 6, 4, 0, -2, -5])]
    new = [{**row, 'current': row['base']+gain} for row, gain in zip(old, [2, -3, 8, -1, 10, 6, 4, 0])]
    def selected(data, names=None):
        rows = [r for r in data if (r['name'] in names if names is not None else r['current'] > r['base'])]
        return dict(names=sorted(r['name'] for r in rows), count=len(rows), gain=sum(r['current']-r['base'] for r in rows))
    leaders = sorted(old, key=lambda r: r['current']-r['base'], reverse=True)[:2]
    top_names = [r['name'] for r in leaders]
    new_top = sorted(new, key=lambda r: r['current']-r['base'], reverse=True)[:2]
    write_case(root, 'scope_expansion', {'old.csv': old, 'new.csv': new}, [
        ('leaders', 'Use {old.csv}. Gain means current minus base. Publish the top TWO entities by gain, preserving this result for later. Return JSON names (alphabetical), count, gain (sum for those two).', selected(old, top_names)),
        ('detour', 'Separately, count all entities in the original file. Return JSON count.', dict(count=len(old))),
        ('expand', 'Now report ALL entities whose gain is positive in the original file. Return JSON names (alphabetical), count, gain (sum).', selected(old)),
        ('other_leaders', 'Temporarily report the THREE entities with highest current, regardless of gain. Break ties in current by name ascending. Return JSON names (alphabetical).', dict(names=sorted(r['name'] for r in sorted(old, key=lambda r:(-r['current'],r['name']))[:3]))),
        ('fixed_members', 'New measurements are {new.csv}. Use exactly the TWO entity IDs in our FIRST publication and compute their gains from the new file. Return JSON names (alphabetical), count, gain (sum).', selected(new, top_names)),
        ('reapply_rule', 'Separately, reapply the INITIAL top-two-by-gain selection rule to the new file. Return JSON names (alphabetical), count, gain (sum).', selected(new, [r['name'] for r in new_top])),
        ('all_new', 'Report ALL entities whose gain is positive in the new file. Return JSON names (alphabetical), count, gain (sum).', selected(new)),
        ('compare', 'Across ALL entities, including zero and negative gains, report summed original-file gains as old_gain and new-file gains as new_gain. Repeat the originally published top-two summed gain as published_gain. Return JSON old_gain, new_gain, published_gain.', dict(old_gain=sum(r['current']-r['base'] for r in old), new_gain=sum(r['current']-r['base'] for r in new), published_gain=selected(old, top_names)['gain'])),
    ])
    metadata(root/'scope_expansion', {i: dict(names='selection', count='selection', gain='selection') for i in [3, 5, 6, 7]})
    checks = json.loads((root/'scope_expansion'/'checks.json').read_text())
    checks[7]['fields'] = dict(old_gain='selection', new_gain='selection', published_gain='preservation')
    (root/'scope_expansion'/'checks.json').write_text(json.dumps(checks, indent=2))

    orders = [dict(id=i, updated='2025-01-01', region=['East','West'][i%2], units=i+2, price=10+i) for i in range(1,9)]
    revisions = [{**orders[i], 'updated':'2025-02-01', 'units':orders[i]['units']+5} for i in [1,4]]
    export = orders + revisions
    corrections = [{**orders[i], 'updated':'2025-03-01', 'units':orders[i]['units']-1} for i in [0,7]]
    def report(records, latest=False, fee=0):
        selected = {}
        for row in sorted(records, key=lambda r:r['updated'], reverse=not latest): selected[row['id']] = row
        regional = {}
        for row in selected.values(): regional[row['region']] = regional.get(row['region'],0)+row['units']*(row['price']-fee)
        return dict(total=sum(regional.values()), regional=regional, units=sum(r['units'] for r in selected.values()))
    initial, corrected = report(export), report(export, True)
    net, revised = report(export, True, 1), report(export+corrections, True, 1)
    write_case(root, 'repair_descendants', {'orders.csv':export, 'reordered.csv':list(reversed(export)), 'revised.csv':export+corrections}, [
        ('establish', 'Use {orders.csv}. Each id is an order with timestamped revisions. Initially take the EARLIEST updated row per id. Revenue is units*price. Publish total revenue, revenue by region and total units. Preserve this publication. Return JSON total, regional (object), units.', initial),
        ('east', 'Temporarily report East-only revenue under the current default deduplication rule. Return JSON east_total.', dict(east_total=initial['regional']['East'])),
        ('correct', 'Correction: the default must take the LATEST updated row per id, not the earliest. Repair ALL reports using the full original population. Return JSON total, regional, units, and baseline_total from the original publication.', {**corrected,'baseline_total':initial['total']}),
        ('fee', 'Adopt a handling fee of 1 per unit. Default net revenue is units*(price-1), using the corrected deduplication rule. Update total and regional reports; units remains the deduplicated unit sum. Return JSON total, regional, units.', net),
        ('baseline', 'Repeat the original published revenue and the original East temporary revenue, exactly as originally calculated. Return JSON baseline_total, east_total.', dict(baseline_total=initial['total'],east_total=initial['regional']['East'])),
        ('reorder', 'Adopt {reordered.csv} as the current export, keeping our latest-timestamp rule and fee. Physical row order must not change the result. Return JSON total, regional, units.', net),
        ('new_corrections', 'A corrected export is {revised.csv}. Adopt it, retaining our current latest-timestamp rule and handling fee. Update all default reports. Return JSON total, regional, units.', revised),
        ('compare', 'Repeat all current default reports and the original publication total. Return JSON total, regional, units, baseline_total.', {**revised,'baseline_total':initial['total']}),
    ])
    metadata(root/'repair_descendants', {
        3: dict(total='update', regional='update', units='update', baseline_total='preservation'),
        4: dict(total='update', regional='update', units='preservation'),
        5: dict(baseline_total='preservation', east_total='preservation'),
        6: dict(total='preservation', regional='preservation', units='preservation'),
        7: dict(total='update', regional='update', units='update'),
        8: dict(total='update', regional='update', units='update', baseline_total='preservation'),
    }, corrections=(3,7))
    files, tasks = {}, []
    for i in range(8):
        filename = f'independent_{i}.csv'
        rows = [dict(value=(j+3)*(i+2), group=['A','B'][j%2]) for j in range(37)]
        files[filename] = rows
        tasks.append((f'independent_{i}', f'Independent task: use {{{filename}}}. Report the number of rows and sum of value. Return JSON count, total.', dict(count=len(rows),total=sum(r['value'] for r in rows))))
    write_case(root, 'independent_control', files, tasks)
    metadata(root/'independent_control')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    generate(parser.parse_args().directory.resolve())
