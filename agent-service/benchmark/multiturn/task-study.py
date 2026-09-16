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
"""Deterministic research cases and strict JSON scoring; no model sees gold."""
import argparse, ast, csv, json, math, runpy
from pathlib import Path

HERE=Path(__file__).resolve().parent

def write_case(root,name,files,tasks):
    directory=root/name;directory.mkdir(parents=True,exist_ok=False)
    paths={}
    for filename,rows in files.items():
        path=directory/filename
        with path.open('w') as f:
            writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
        paths[filename]=str(path)
    public=[];gold=[]
    for ident,prompt,answer in tasks:
        for filename,path in paths.items():prompt=prompt.replace('{'+filename+'}',path)
        public.append(dict(id=ident,prompt=prompt));gold.append(answer)
    (directory/'session.json').write_text(json.dumps(dict(family=name,files=list(paths.values()),turns=public),indent=2))
    (directory/'gold.json').write_text(json.dumps(gold,indent=2))

def generate(root):
    runpy.run_path(str(HERE/'state-study.py'))['generate'](root)
    runpy.run_path(str(HERE/'study.py'))['generate'](root/'customer_reports',67)
    orders=[dict(id=i,region=['East','West','North','South'][i%4],units=3+i%13,price=20+i%17,cost=5+i%7,returned=i%3) for i in range(1,129)]
    visits=[dict(day=i,visits=i*13+7) for i in range(1,8)]
    def report(extra=0,returns=True):
        return dict(profit=sum((r['units']-(r['returned'] if returns else 0))*r['price']-r['units']*(r['cost']+extra) for r in orders),units=sum(r['units'] for r in orders),orders=len(orders))
    initial=report(0,False)
    tasks=[('establish','Use {orders.csv}. Establish our default operating report on all orders: profit=sum(units*(price-cost)), units=sum(units), and orders=row count. Keep the original publication available for later comparison. Return JSON profit, units, orders.',initial),('correction','Correct default profit: returned units earn no revenue but all units incur cost. Use (units-returned)*price-units*cost per row. Keep both the units and order-count reports current. Return JSON profit, units, orders.',report())]
    extra=0
    for i in range(3,20):
        if i%5==0:
            tasks.append((f'detour_{i}','Separately, sum visits in {visits.csv}. Preserve our default operating report. Return JSON visits.',dict(visits=sum(r['visits'] for r in visits))))
        else:
            extra=i%7
            tasks.append((f'update_{i}',f'Set additional handling cost to {extra} per unit in the original units column, INCLUDING units later returned, on top of each row original cost. This replaces the previous handling surcharge. Retain the returns correction and original full population. Update all default reports. Return JSON profit, units, orders.',report(extra)))
    tasks.append(('compare','Report the current default profit, units and orders. Include baseline_profit from our original publication and delta=current profit minus that original profit. Return JSON profit, units, orders, baseline_profit, delta.',{**report(extra),'baseline_profit':initial['profit'],'delta':report(extra)['profit']-initial['profit']}))
    write_case(root,'repeated_corrections',{'orders.csv':orders,'visits.csv':visits},tasks)
    controls=[];files={}
    for i in range(6):
        filename=f'independent_{i}.csv';rows=[dict(value=(j+3)*(i+2),group=['A','B'][j%2]) for j in range(37)]
        files[filename]=rows
        controls.append((f'independent_{i}',f'Independent task: use {{{filename}}} and report the number of rows and sum of value. Return JSON count, total.',dict(count=len(rows),total=sum(r['value'] for r in rows))))
    write_case(root,'independent_control',files,controls)

def parse(value):
    if isinstance(value,(dict,list)):return value
    text=str(value).strip()
    try:return json.loads(text)
    except ValueError:pass
    try:return ast.literal_eval(text)
    except (ValueError,SyntaxError):pass
    decoder=json.JSONDecoder();found=[]
    for i,ch in enumerate(text):
        if ch in '{[':
            try:
                item,length=decoder.raw_decode(text[i:]);found.append((length,item))
            except ValueError:pass
    return max(found,key=lambda pair:pair[0])[1] if found else None

def equal(expected,actual):
    if isinstance(expected,dict):return isinstance(actual,dict) and set(expected)==set(actual) and all(equal(v,actual[k]) for k,v in expected.items())
    if isinstance(expected,list):return isinstance(actual,list) and len(expected)==len(actual) and all(equal(x,y) for x,y in zip(expected,actual))
    if isinstance(expected,(int,float)) and not isinstance(expected,bool):
        try:return not isinstance(actual,bool) and math.isfinite(float(actual)) and abs(float(expected)-float(actual))<=0.0001
        except (ValueError,TypeError):return False
    return expected==actual

def score(case,run):
    gold=json.loads((case/'gold.json').read_text());results=[]
    metadata=json.loads((case/'checks.json').read_text()) if (case/'checks.json').exists() else [{} for _ in gold]
    assert len(metadata)==len(gold), 'Checks must cover every task before any model run'
    state_checks={}
    for i,expected in enumerate(gold,1):
        folder=run/f't{i:02}'
        completed=(folder/'answer.json').exists()
        answer=json.loads((folder/'answer.json').read_text()) if completed else {}
        actual=parse(answer.get('answer',''))
        stats=json.loads((folder/'stats.json').read_text()) if (folder/'stats.json').exists() else {}
        # One check per requested root field, not per output row. No judge, fuzzy
        # semantics, alias matching or after-the-fact numeric relaxation.
        fields=list(expected) if isinstance(expected,dict) and expected else [None]
        checks=[]
        meta=metadata[i-1]
        assert set(meta.get('fields',{})).issubset(set(fields)), 'Unknown requested field'
        for field in fields:
            passed=equal(expected,actual) if field is None else isinstance(actual,dict) and field in actual and equal(expected[field],actual[field])
            kind=meta.get('fields',{}).get(field,'answer')
            checks.append(dict(field=field,kind=kind,passed=passed))
            bucket=state_checks.setdefault(kind,dict(passed=0,total=0))
            bucket['total']+=1;bucket['passed']+=int(passed)
        item=dict(task=i,completed=completed,passed=completed and equal(expected,actual),
                  content_passed=completed and all(c['passed'] for c in checks),checks=checks,
                  correction=meta.get('correction',False),actual=actual,expected=expected)
        if folder.exists():(folder/'evaluation.json').write_text(json.dumps(item,indent=2))
        # These runners invoke the model for every task. A timeout can write a
        # zero-filled stats file without receiving any provider usage at all.
        results.append({**stats,**item,'usage_recorded':'cost_usd' in stats and stats.get('llm_calls',0)>0})
    passed=sum(x['passed'] for x in results)
    summary=dict(tasks=len(gold),completed=sum(x['completed'] for x in results),passed=passed,
                 session_passed=passed==len(gold),content_passed=sum(x['content_passed'] for x in results),
                 extra_field_only_failures=sum(x['content_passed'] and not x['passed'] for x in results),
                 requirements=dict(passed=sum(c['passed'] for x in results for c in x['checks']),total=sum(len(x['checks']) for x in results)),
                 task_averaged_requirement_score=sum(sum(c['passed'] for c in x['checks'])/len(x['checks']) for x in results)/len(gold),
                 state_checks=state_checks,cost_complete=all(x['usage_recorded'] for x in results),
                 cost_usd=sum(x.get('cost_usd',0) for x in results),
                 correction_cost_usd=sum(x.get('cost_usd',0) for x in results if x['correction']),
                 llm_calls=sum(x.get('llm_calls',0) for x in results),results=results)
    (run/'summary.json').write_text(json.dumps(summary,indent=2));return summary

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['generate','score']);parser.add_argument('directory',type=Path);parser.add_argument('run',type=Path,nargs='?');args=parser.parse_args()
    if args.action=='generate':generate(args.directory.resolve())
    else:print(json.dumps({k:v for k,v in score(args.directory,args.run).items() if k!='results'}))
