#!/usr/bin/env python3
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
"""Reproduce the frozen R4 cost/accuracy report from recorded runs; no model calls."""
import hashlib
import json
from pathlib import Path
import statistics
import sys
from collections import Counter,defaultdict

ROOT=Path(__file__).resolve().parents[3]
SCRATCH=ROOT/'benchmark/longds/system_scratch'
PREFIX='LongDS_CostR4_20260924'
old=json.loads((ROOT/'docs/analysis-state-isolated-results.json').read_text())
selection=json.loads((ROOT/'benchmark/longds/cost-r4-selection.json').read_text())
sys.path.insert(0,str(ROOT/'agent-service/benchmark/multiturn'))
from importlib import import_module
recorded_model_usage=import_module('analyze-analysis-state').recorded_model_usage
tasks=[t.replace('/','__') for t in selection['selected_tasks']]
aliases=dict(zip(tasks,['Survey','BI','Water']))
hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT/'docs/analysis-state-isolated-results.json',ROOT/'benchmark/longds/cost-r4-selection.json']}
def read(p):
    b=p.read_bytes();hashes[str(p.relative_to(ROOT))]=hashlib.sha256(b).hexdigest();return json.loads(b)

def cost(u):
    return ((u.get('input_tokens',0)-u.get('cached_tokens',0)-u.get('cache_write_tokens',0))*.2+
            u.get('cached_tokens',0)*.02+u.get('cache_write_tokens',0)*.25+u.get('output_tokens',0)*1.2)/1e6

def cost_parts(u):
    return {'uncached_input':(u.get('input_tokens',0)-u.get('cached_tokens',0)-u.get('cache_write_tokens',0))*.2/1e6,
            'cache_read':u.get('cached_tokens',0)*.02/1e6,
            'cache_write':u.get('cache_write_tokens',0)*.25/1e6,
            'output':u.get('output_tokens',0)*1.2/1e6}

def inspect_trace(d):
    seen=set();counts=Counter();last_history={};prefix_failures=[];first_turn_inputs=[];steps=[]
    categories=defaultdict(lambda: {'calls':0,'cost_usd':0.0})
    files=[(int(f.parent.name[1:]),f) for f in sorted((d/'turns').glob('t[0-9][0-9]/react_steps.json'))]
    captured=d/'interrupted-react-steps.json'
    if captured.exists():files.append((max((t for t,_ in files),default=0)+1,captured))
    for turn,f in files:
        turn_steps=read(f)
        if isinstance(turn_steps,dict):turn_steps=turn_steps['steps']
        previous=None;first=True;requests=set()
        for s in turn_steps:
            if s['id'] in seen or s['role']!='agent' or not s.get('usage',{}).get('inputTokens'):continue
            seen.add(s['id']);steps.append(s)
            args=[c['input'] if isinstance(c.get('input'),dict) else {} for c in s.get('toolCalls',[]) if c.get('toolName')=='dataflow']
            editing=any(any(a.get(k) for k in ['edits','delete','restore','fork']) for a in args)
            retrieving=any(a.get('inspect') or a.get('recall') for a in args)
            observing=any(a.get('observe') for a in args)
            category=('edit_and_retrieve' if retrieving else 'edit') if editing else ('retrieve' if retrieving else 'observe' if observing else 'other_tool' if args else 'no_tool')
            u=s['usage']
            categories[category]['calls']+=1
            categories[category]['cost_usd']+=cost({'input_tokens':u.get('inputTokens',0),'cached_tokens':u.get('cachedInputTokens',0),
                'cache_write_tokens':u.get('cacheCreationInputTokens',0),'output_tokens':u.get('outputTokens',0)})
            for a in args:
                fingerprint=json.dumps({k:v for k,v in a.items() if k!='reasoning'},sort_keys=True)
                counts['exact_repeated_requests']+=fingerprint in requests
                requests.add(fingerprint)
            inp=s.get('inputMessages',[])
            if first:first_turn_inputs.append({'turn':turn,'input_tokens':s['usage']['inputTokens']});first=False
            if previous is not None:
                counts['within_turn_prefix_pairs']+=1
                if inp[:len(previous)]==previous:counts['within_turn_exact_prefix_pairs']+=1
                else:prefix_failures.append({'turn':turn,'step':s['stepId']})
            previous=inp
            for m in inp:
                text=m.get('content')
                if isinstance(text,str) and text.startswith('## Task '):
                    task=text.splitlines()[0];prior=last_history.get(task)
                    if prior is not None:
                        counts['history_reappearances']+=1
                        counts['identical_history_reappearances']+=prior==text
                    last_history[task]=text
            for c in s.get('toolCalls',[]):
                counts['tool_calls']+=1;a=c['input'] if isinstance(c.get('input'),dict) else {}
                counts['inspect_calls']+=bool(a.get('inspect'))
                counts['recall_calls']+=bool(a.get('recall'))
                counts['observe_only_calls']+=bool(a.get('observe')) and not any(a.get(k) for k in ['edits','inspect','recall','fork','delete','restore'])
                counts['edit_chars']+=len(a.get('edits',''))
            for r in s.get('toolResults',[]):
                result=r.get('output')
                if isinstance(result,str) and '[ERROR]' in result:counts['unstructured_error_calls']+=1
                if isinstance(result,dict):
                    counts['calls_with_validation_errors']+=any(o['status']=='error' for o in result.get('operators',[]))
                    counts['deduplicated_inspection_responses']+=sum(t.startswith('Already shown in this task:') for t in result.get('inspection',[]))
    return {'counts':dict(counts),'generation_categories':dict(categories),'prefix_failures':prefix_failures,'first_call_inputs':first_turn_inputs}

rows=[]
for trial in range(1,4):
    for task in tasks:
        sut=f'{PREFIX}_react-efficient_luna_t{trial}';d=SCRATCH/sut/task
        if not (d/'protocol.json').exists():continue
        protocol=read(d/'protocol.json');answers=read(d/'turns/answers.json') if (d/'turns/answers.json').exists() else []
        usage,usage_source=recorded_model_usage(d,answers)
        for p in [d/'interrupted-react-steps.json',d/'session-budget.json']:
            if p.exists():read(p)
        judged=read(d/'results_eval.json') if (d/'results_eval.json').exists() else []
        complete=len(judged)==protocol['turns'] and all(t.get('judge',{}).get('score') in (0,1) for t in judged)
        row={'sut':sut,'task':task,'label':aliases[task],'trial':trial,'arm':'react-efficient',
             'expected':protocol['turns'],'completed_questions':len(answers),'judged_questions':sum(t.get('judge',{}).get('score') in (0,1) for t in judged),
             'complete':complete,'correct':sum(t.get('judge',{}).get('score',0) or 0 for t in judged),
             'usage':dict(usage),'usage_source':usage_source,'runtime':protocol['runtime']}
        row['session_budget']=read(d/'session-budget.json') if (d/'session-budget.json').exists() else None
        row['budget_stopped']=bool((row['session_budget'] or {}).get('expired'))
        row['unmetered_error_turns']=[{'turn':a.get('turn_id'),'error':a.get('answer') or a.get('error')} for a in answers if not a.get('stats',{}).get('llm_calls') and (a.get('error') or str(a.get('answer','')).startswith('Error:'))]
        row['accuracy']=row['correct']/row['expected'] if complete else None
        row['cost_parts']=cost_parts(usage)
        if complete:
            assert abs(usage.get('cost_usd',0)-cost(usage))<1e-8
            row['trace']=inspect_trace(d)
            for stat,key in [('tool_calls','tool_calls'),('inspection_calls','inspect_calls'),('recall_calls','recall_calls')]:
                row['usage'][stat]=row['trace']['counts'].get(key,0)
            pair=[]
            for arm in ['dsgym','react-entries']:
                original=next((r for r in old['runs'] if r['trial']==trial and r['arm']==arm and r['task']==task and r['complete']),None)
                if original:
                    olddir=SCRATCH/original['sut']/task;prior=read(olddir/'results_eval.json')
                    groups=Counter();changes=[];both_pass_cost={'old':0.0,'new':0.0,'questions':0}
                    for i,(a,b) in enumerate(zip(prior,judged),1):
                        sa=a['judge']['score'];sb=b['judge']['score'];groups['both_pass' if sa and sb else 'both_fail' if not sa and not sb else 'new_only' if sb else 'old_only']+=1
                        if sa and sb:
                            both_pass_cost['old']+=a.get('stats',{}).get('cost_usd',0)
                            both_pass_cost['new']+=b.get('stats',{}).get('cost_usd',0)
                            both_pass_cost['questions']+=1
                        if sa!=sb:changes.append({'turn':i,'old':sa,'new':sb})
                    pair.append({'control':arm,'groups':dict(groups),'changed_scores':changes,'both_pass_cost':both_pass_cost})
            row['paired_outcomes']=pair
        rows.append(row)

baselines=[r for r in old['runs'] if r['task'] in tasks and r['trial']<=3 and r['arm'] in ['dsgym','react-entries'] and r['complete']]
aggregates=[]
for trial in range(1,4):
    for arm in ['dsgym','react-entries','react-efficient']:
        source=rows if arm=='react-efficient' else baselines
        rr=[r for r in source if r['trial']==trial and r['arm']==arm and r['complete']]
        if len(rr)!=len(tasks):continue
        usage=Counter()
        for r in rr:
            for k,v in r['usage'].items():
                if isinstance(v,(int,float)):usage[k]+=v
        aggregates.append({'trial':trial,'arm':arm,'task_macro_accuracy':statistics.mean(r['accuracy'] for r in rr),
                           'correct':sum(r['correct'] for r in rr),'questions':sum(r['expected'] for r in rr),'usage':dict(usage),'cost_parts':cost_parts(usage)})

comparisons=[]
for a in aggregates:
    if a['arm']!='react-efficient':continue
    for b in aggregates:
        if b['trial']!=a['trial'] or b['arm']=='react-efficient':continue
        comparisons.append({'trial':a['trial'],'control':b['arm'],
                            'cost_change':a['usage']['cost_usd']/b['usage']['cost_usd']-1,
                            'accuracy_difference_pp':100*(a['task_macro_accuracy']-b['task_macro_accuracy']),
                            'correct_difference':a['correct']-b['correct'],
                            'under_25_percent_cost_premium':a['usage']['cost_usd']<=1.25*b['usage']['cost_usd']})

# The prior selected-memory experiment is a secondary architectural comparison;
# it is not substituted for the stronger entries control above.
behavior=[]
for trial in range(1,4):
    for arm in ['react-entries','react-analysis','react-efficient']:
        source=rows if arm=='react-efficient' else old['runs']
        rr=[r for r in source if r['trial']==trial and r['arm']==arm and r['task'] in tasks and r['complete']]
        if len(rr)!=len(tasks):continue
        categories=defaultdict(lambda: {'calls':0,'cost_usd':0.0});counts=Counter()
        for r in rr:
            trace=r.get('trace') or inspect_trace(SCRATCH/r['sut']/r['task'])
            assert abs(sum(x['cost_usd'] for x in trace['generation_categories'].values())-r['usage']['cost_usd'])<1e-8
            counts.update(trace['counts'])
            for name,values in trace['generation_categories'].items():
                for key,value in values.items():categories[name][key]+=value
        behavior.append({'trial':trial,'arm':arm,'correct':sum(r['correct'] for r in rr),'questions':96,
                         'generation_categories':dict(categories),'counts':dict(counts)})
matched_successes=[]
for trial in range(1,4):
    rr=[r for r in rows if r['trial']==trial and r['complete']]
    if len(rr)!=len(tasks):continue
    for control in ['dsgym','react-entries']:
        pairs=[p for r in rr for p in r['paired_outcomes'] if p['control']==control]
        if len(pairs)!=len(tasks):continue
        totals=Counter()
        for p in pairs:totals.update(p['both_pass_cost'])
        matched_successes.append({'trial':trial,'control':control,**totals,
                                  'cost_change':totals['new']/totals['old']-1 if totals['old'] else None})
cache_checks=Counter()
for row in rows:
    if row['complete']:
        cache_checks.update({k:v for k,v in row['trace']['counts'].items() if k in {
            'within_turn_prefix_pairs','within_turn_exact_prefix_pairs',
            'history_reappearances','identical_history_reappearances'}})
report={'scope':selection,'complete_sessions':sum(r['complete'] for r in rows),'planned_sessions':9,
        'rows':rows,'aggregates':aggregates,'comparisons':comparisons,'behavior_comparison':behavior,
        'matched_successes':matched_successes,'cache_checks':dict(cache_checks),'source_sha256':hashes,
        'limitations':['Historical controls, not a simultaneous randomized A/B test.',
                      'Previously audited development tasks; does not establish full-benchmark generalization.',
                      'A combined revision; no ablation isolates each fix, and existing post-control correctness fixes are also present.',
                      'Repository cache-aware model-cost estimates, not provider invoices or infrastructure charges.',
                      'Provider requests failing or stopping without returned usage cannot be priced from these traces; unmetered_error_turns lists detected completed-turn cases.',
                      'First pass and repetitions are separate; old outputs and scores are unchanged.']}
base_comparisons=[c for c in comparisons if c['control']=='dsgym']
entry_comparisons=[c for c in comparisons if c['control']=='react-entries']
report['acceptance_check']={
    'all_planned_sessions_scored':report['complete_sessions']==9,
    'within_25_percent_dsgym_cost_in_every_completed_trial':bool(base_comparisons) and all(c['under_25_percent_cost_premium'] for c in base_comparisons),
    'higher_task_macro_accuracy_than_dsgym_in_every_completed_trial':bool(base_comparisons) and all(c['accuracy_difference_pp']>0 for c in base_comparisons),
    'preserves_previous_entries_accuracy_in_every_matched_trial':bool(entry_comparisons) and all(c['accuracy_difference_pp']>=0 for c in entry_comparisons),
    'matched_entries_trials':[c['trial'] for c in entry_comparisons],
    'limits':'Historical comparisons on three development tasks; budget stops and unreported provider usage remain explicit.',
}
dest=ROOT/'docs/cost-r4-results.json';dest.write_text(json.dumps(report,indent=2)+'\n')
license=(ROOT/'docs/cost-r4-implementation.md').read_text().split('-->',1)[0]+'-->\n\n'
lines=[license,f'**Representative efficiency results: {report["complete_sessions"]}/9 sessions scored.**',
       'Three full LongDS v1 sessions per trial (Survey, BI, Water), 96 questions. '
       'Model: gpt-5.6-luna. Judge: GPT-5.2 with the same upstream prompt and references. '
       'Score 1 is correct. Historical controls retain their recorded results.',
       '\n| Trial | Arm | Task-macro accuracy | Correct / 96 | Model calls | Model cost |',
       '| --- | --- | ---: | ---: | ---: | ---: |']
if report['complete_sessions']==9:
    checks=report['acceptance_check']
    verdict=('The 25% DSGym cost premium target holds in every trial.' if checks['within_25_percent_dsgym_cost_in_every_completed_trial'] else 'The 25% DSGym cost premium target does not hold in every trial.')
    verdict+=' '+('Accuracy exceeds DSGym in every trial.' if checks['higher_task_macro_accuracy_than_dsgym_in_every_completed_trial'] else 'An accuracy advantage over DSGym is not consistent across all trials.')
    verdict+=' '+('Previous entries accuracy is preserved in the matched trials.' if checks['preserves_previous_entries_accuracy_in_every_matched_trial'] else 'Previous entries accuracy is not fully preserved in the matched trials.')
    verdict+=' The efficiency mode remains opt-in; these measurements do not justify making it the default.'
    lines.insert(2,verdict+'\n')
for a in aggregates:
    lines.append(f'| {a["trial"]} | {a["arm"]} | {a["task_macro_accuracy"]:.2%} | {a["correct"]}/96 | {a["usage"]["llm_calls"]:.0f} | ${a["usage"]["cost_usd"]:.6f} |')
lines+=['\nCorrect answers by task, showing trials 1 / 2 / 3 in each cell:',
        '\n| Task | Questions per trial | DSGym | Previous entries | New efficient entries |',
        '| --- | ---: | ---: | ---: | ---: |']
for task in tasks:
    cells=[]
    for arm in ['dsgym','react-entries','react-efficient']:
        source=rows if arm=='react-efficient' else baselines
        values=[]
        for trial in range(1,4):
            r=next((r for r in source if r['task']==task and r['trial']==trial and r['arm']==arm and r['complete']),None)
            values.append(str(r['correct']) if r else '—')
        cells.append(' / '.join(values))
    expected=next(r['expected'] for r in baselines if r['task']==task)
    lines.append(f"| {aliases[task]} | {expected} | {' | '.join(cells)} |")
lines+=['\nA dash means no complete recorded comparison; it does not mean a zero score.']
lines+=['\nFirst pass by session:','\n| Task | Arm | Correct | Questions | Cost |','| --- | --- | ---: | ---: | ---: |']
for task in tasks:
    for arm in ['dsgym','react-entries','react-efficient']:
        source=rows if arm=='react-efficient' else baselines
        r=next((r for r in source if r['task']==task and r['trial']==1 and r['arm']==arm and r['complete']),None)
        if r:lines.append(f'| {aliases[task]} | {arm} | {r["correct"]} | {r["expected"]} | ${r["usage"]["cost_usd"]:.6f} |')
lines+=['\n| Trial | Historical control | Cost change | Accuracy change |',
        '| --- | --- | ---: | ---: |']
for c in comparisons:
    lines.append(f"| {c['trial']} | {c['control']} | {c['cost_change']:+.2%} | {c['accuracy_difference_pp']:+.2f} pp |")
lines+=['\nFirst-pass recorded cost components:',
        '\n| Arm | Uncached input | Cache reads | Cache writes | Output |',
        '| --- | ---: | ---: | ---: | ---: |']
for a in aggregates:
    if a['trial']==1:
        c=a['cost_parts']
        lines.append(f"| {a['arm']} | ${c['uncached_input']:.6f} | ${c['cache_read']:.6f} | ${c['cache_write']:.6f} | ${c['output']:.6f} |")
lines+=['\nOutput includes reasoning tokens where the provider reports them as output; reasoning is not charged a second time. '
        'These are usage-based estimates at the recorded repository rates.']
lines+=['\nCosts on questions both systems answered correctly:',
        '\n| Trial | Control | Both correct | Control cost | New cost | Change |',
        '| --- | --- | ---: | ---: | ---: | ---: |']
for p in matched_successes:
    lines.append(f"| {p['trial']} | {p['control']} | {p['questions']} | ${p['old']:.6f} | ${p['new']:.6f} | {p['cost_change']:+.2%} |")
lines+=['\nThis success-conditioned comparison helps separate cheaper correct work from stopping early; '
        'it is not a randomized estimate and does not replace the all-question scores and spending.',
        f"\nRecorded cache-shape checks: {cache_checks['within_turn_exact_prefix_pairs']}/{cache_checks['within_turn_prefix_pairs']} "
        f"consecutive within-question inputs preserve the entire earlier prefix, and "
        f"{cache_checks['identical_history_reappearances']}/{cache_checks['history_reappearances']} repeated history entries are byte-identical. "
        'These are recorded input checks; provider cache residency and billing remain separate.']
lines+=['\nFirst-pass generation categories (calls / model cost):',
        '\n| Category | Previous entries | Previous selected memory | New efficient entries |',
        '| --- | ---: | ---: | ---: |']
for category in ['edit','edit_and_retrieve','retrieve','observe','other_tool','no_tool']:
    cells=[]
    for arm in ['react-entries','react-analysis','react-efficient']:
        b=next((b for b in behavior if b['trial']==1 and b['arm']==arm),None)
        c=b['generation_categories'].get(category,{'calls':0,'cost_usd':0}) if b else None
        cells.append(f"{c['calls']} / ${c['cost_usd']:.6f}" if c else 'pending')
    lines.append(f"| {category} | {' | '.join(cells)} |")
lines+=['\nThese categories describe what each generation requested, not the causal cost of that action. '
        'A retrieval request pays for its preceding context; later generations ingest the retrieved text. '
        'No-tool includes answer generations. Exact repeated requests ignore only reasoning text and do '
        'not count revised repairs as identical. Error counters are not a complete runtime-retry census.']
stopped=[r for r in rows if r['budget_stopped']]
if stopped:
    lines+=['\nBudget-stopped sessions: '+', '.join(f"trial {r['trial']} {r['label']} ({r['completed_questions']}/{r['expected']} turns finished before stopping)" for r in stopped)+'. Unreached questions are scored as failures, and captured interrupted-call usage is included. Any in-flight provider usage that was not returned remains unknown.']
unmetered=[(r['trial'],r['label'],e['turn']) for r in rows for e in r['unmetered_error_turns']]
if unmetered:
    lines+=['\nRequests failed without returned usage at: '+', '.join(f'trial {t}, {label} question {q}' for t,label,q in unmetered)+'. Their answers retain their scored failures, but any unreported provider charge is unknown; displayed model cost is recorded-usage cost.']
lines+=['\nOnly complete three-task trials are aggregated. Missing or unfinished sessions are not silently scored as zero. '
        'Unanswered questions within a completed budget-limited session remain failures.',
        '\nThe [structured results](cost-r4-results.json) retain per-session usage, exact-prefix checks, '
        'paired accuracy flips and hashes. The [implementation and stable comparison](cost-r4-implementation.md) '
        'describe the changes and comparability limits. Costs use $0.20/M uncached input, $0.02/M cache reads, '
        '$0.25/M cache writes and $1.20/M output. Judge spending is recorded in each results_eval.json separately.']
(ROOT/'docs/cost-r4-results.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({'complete':report['complete_sessions'],'aggregates':aggregates},indent=2))
