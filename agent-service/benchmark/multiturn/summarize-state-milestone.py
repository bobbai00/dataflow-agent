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
"""Summarize all fresh trials; never replace primary failures with retries."""
import argparse
from collections import defaultdict
import json
from pathlib import Path


def summarize(root, replacement=None):
    manifest = json.loads((root/'manifest.json').read_text())
    for row in manifest['primary']+manifest['recoveries']: row['_root']=str(root)
    if replacement:
        other=json.loads((replacement/'manifest.json').read_text())
        assert set(other['arms'])==set(manifest['arms'])
        assert other['recovery_rounds']==manifest['recovery_rounds'] and other['repeat_all']==manifest['repeat_all']
        assert other['revision']==manifest['revision'], 'Runtime revision must remain fixed'
        assert set(other['families']).issubset(set(manifest['families']))
        for key in ['primary','recoveries']:
            manifest[key]=[r for r in manifest[key] if r['family'] not in other['families']]+[{**r,'_root':str(replacement)} for r in other[key]]
        manifest['finished']=max(manifest['finished'],other['finished']) if manifest.get('finished') and other.get('finished') else None
    rows = manifest['primary'] + manifest['recoveries']
    report = dict(revision=manifest['revision'], finished=manifest.get('finished'),
                  sessions=len(rows), expected_sessions=len(manifest['families'])*len(manifest['arms'])*(1+manifest['recovery_rounds']),
                  repeat_all=manifest.get('repeat_all',False), replacement=str(replacement) if replacement else None,
                  arms={}, families={}, primary={})
    def aggregate(selected):
        results=[]; costs=[]; unreported=[]
        for row in selected:
            s=json.loads((Path(row['_root'])/row['label']/'summary.json').read_text())
            results.extend(s['results']);costs.append(s['cost_usd'])
            for result in s['results']:
                if not result.get('usage_recorded') or not result.get('llm_calls'):
                    unreported.append(dict(session=row['label'],task=result['task']))
        passed=sum(r['passed'] for r in results)
        states=defaultdict(lambda:dict(passed=0,total=0))
        for r in results:
            for c in r['checks']:
                states[c['kind']]['total']+=1;states[c['kind']]['passed']+=int(c['passed'])
        total=lambda key:sum(r.get(key,0) for r in results)
        return dict(sessions=len(selected),session_passed=sum(r['session_passed'] for r in selected),
                    tasks=len(results),passed=passed,content_passed=sum(r['content_passed'] for r in results),
                    cost_usd=sum(costs),mean_session_cost_usd=sum(costs)/len(costs) if costs else None,
                    cost_per_correct_task_usd=sum(costs)/passed if passed else None,
                    cost_complete=all(r['cost_complete'] for r in selected) and not unreported,
                    unreported_usage_tasks=unreported,
                    correction_cost_usd=sum(r['correction_cost_usd'] for r in selected),
                    correction_llm_calls=sum(r.get('llm_calls',0) for r in results if r['correction']),
                    correction_output_tokens=sum(r.get('output_tokens',0) for r in results if r['correction']),
                    startup_cost_usd=sum(r.get('cost_usd',0) for r in results if r['task']==1),
                    followup_cost_usd=sum(r.get('cost_usd',0) for r in results if r['task']!=1),
                    state_checks=dict(states),task_averaged_requirement_score=sum(sum(c['passed'] for c in r['checks'])/len(r['checks']) for r in results)/len(results) if results else None,
                    input_tokens=total('input_tokens'),output_tokens=total('output_tokens'),cached_tokens=total('cached_tokens'),
                    cache_write_tokens=total('cache_write_tokens'),reasoning_tokens=total('reasoning_tokens'),
                    llm_calls=total('llm_calls'),tool_calls=total('tool_calls') if all('tool_calls' in r for r in results) else None,
                    historical_inputs=total('historical_inputs') if all('historical_inputs' in r for r in results) else None,
                    direct_returns=total('direct_returns') if all('direct_returns' in r for r in results) else None,
                    elapsed_seconds=total('elapsed_seconds'))
    for arm in manifest['arms']:
        report['arms'][arm]=aggregate([r for r in rows if r['arm']==arm])
        report['primary'][arm]=aggregate([r for r in manifest['primary'] if r['arm']==arm])
    for family in manifest['families']:
        report['families'][family]={arm:aggregate([r for r in rows if r['arm']==arm and r['family']==family]) for arm in manifest['arms']}
    consistency={}
    for family in manifest['families']:
        consistency[family]={}
        for arm in manifest['arms']:
            trials=[json.loads((Path(r['_root'])/r['label']/'summary.json').read_text()) for r in rows if r['family']==family and r['arm']==arm]
            count=trials[0]['tasks'] if trials else 0
            consistency[family][arm]=dict(trials=len(trials),tasks=count,
                passed_every_trial=sum(all(t['results'][i]['passed'] for t in trials) for i in range(count)) if len(trials)==3 else None,
                trial_scores=[t['passed'] for t in trials])
    report['consistency']=consistency
    return report


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);p.add_argument('--out',type=Path)
    p.add_argument('--replacement',type=Path,help='Replace entire families with all trials from a clarified fixture campaign.')
    args=p.parse_args();result=summarize(args.directory,args.replacement)
    if args.out:args.out.write_text(json.dumps(result,indent=2))
    print(json.dumps({k:v for k,v in result.items() if k not in ['families','consistency','primary']},indent=2))
