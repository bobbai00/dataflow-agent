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
"""Three small mechanism fixtures. Independent loop-based gold; not LongDS scores."""
import argparse, ast, csv, json, math
from pathlib import Path


def save(root, name, files, turns):
    d=root/name;d.mkdir(parents=True,exist_ok=False)
    paths={}
    for filename, rows in files.items():
        p=d/filename
        with p.open('w') as f:
            w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
        paths[filename]=str(p)
    public=[];gold=[]
    for ident,prompt,expected in turns:
        for filename,path in paths.items():prompt=prompt.replace('{'+filename+'}',path)
        public.append(dict(id=ident,prompt=prompt));gold.append(expected)
    (d/'session.json').write_text(json.dumps(dict(family=name,files=list(paths.values()),turns=public),indent=2))
    (d/'gold.json').write_text(json.dumps(gold,indent=2))


def generate(root):
    orders=[dict(id=i+1,region=['East','West'][i%2],units=q,price=p,cost=c,returned=r)
            for i,(q,p,c,r) in enumerate([(10,30,12,2),(8,25,10,1),(15,20,8,4),(6,50,20,0),(12,15,5,3),(5,80,30,1)])]
    def profit(data,returns=False,extra=0):
        regional={}
        for row in data:
            v=(row['units']-(row['returned'] if returns else 0))*row['price']-row['units']*(row['cost']+extra)
            regional[row['region']]=regional.get(row['region'],0)+v
        return dict(total=sum(regional.values()),regional=regional,units=sum(r['units'] for r in data))
    initial=profit(orders);temporary=profit([r for r in orders if r['region']=='East'])
    campaign=[dict(channel='email',leads=19),dict(channel='search',leads=23)]
    save(root,'fanout_correction',{'orders.csv':orders,'campaign.csv':campaign},[
      ('establish', 'Use {orders.csv}. Establish a default operating report with (1) total profit, (2) profit by region, and (3) total units. Initially profit per row is units*(price-cost); sum it for the first two reports. Units is sum(units). Preserve this original published baseline. Return JSON total, regional (object), units.',initial),
      ('temporary','Temporarily compute the same reports for East only. Leave the default and original published baseline unchanged. Return JSON total, regional, units.',temporary),
      ('correction','Correct the default profit formula: returned units earn no revenue, but their costs were already incurred. Profit per row is (units-returned)*price-units*cost. Update both profit reports on the full original data; keep the units report. Return JSON total, regional, units.',profit(orders,True)),
      ('distractor','Separately, sum leads in {campaign.csv}. Return JSON campaign_total. Keep the operating report default unchanged.',dict(campaign_total=42)),
      ('propagate','Raise cost per unit by 2 in our current default profit calculation, retaining the returns correction. Update the operating reports. Return JSON total, regional, units, baseline_total (original publication), and temporary_total (the earlier East-only check as originally calculated).',{**profit(orders,True,2),'baseline_total':initial['total'],'temporary_total':temporary['total']}),
    ])
    buildings=[dict(id=i+1,zone=z,kwh=k,area=a) for i,(z,k,a) in enumerate([('North',120,10),('South',300,20),('North',180,30),('South',250,25),('North',90,15),('South',500,50)])]
    def energy(data,tariff):return dict(bill=round(sum(r['kwh'] for r in data)*tariff,6),intensity=round(sum(r['kwh'] for r in data)/sum(r['area'] for r in data),6))
    initial=energy(buildings,.2);south=energy([r for r in buildings if r['zone']=='South'],.5)
    north=energy([r for r in buildings if r['zone']=='North'],.2)
    save(root,'temporary_scope',{'energy.csv':buildings},[
      ('establish','Use {energy.csv}. Establish the default portfolio bill at tariff 0.20 per kWh, and portfolio intensity=sum(kwh)/sum(area). Use all buildings. Preserve the original published report for future comparisons. Return JSON bill, intensity.',initial),
      ('adopt_tariff','Adopt tariff 0.30 as our default. Keep the portfolio and intensity definition. Return JSON bill, intensity.',energy(buildings,.3)),
      ('temporary','For a temporary stress case, use South buildings only and tariff 0.50. Preserve this temporary result, but leave the default unchanged. Return JSON bill, intensity.',south),
      ('historical','A separate temporary comparison should apply the INITIAL report definition to North buildings only. Keep the active default and earlier South stress case unchanged. Return JSON bill, intensity.',north),
      ('resume','Return to our active default over all buildings. Return JSON bill, intensity, baseline_bill from the original publication, and stress_bill from the South-only stress case.',{**energy(buildings,.3),'baseline_bill':initial['bill'],'stress_bill':south['bill']}),
    ])
    old=[dict(id=i+1,clinic=c,risk=k,value=v) for i,(c,k,v) in enumerate([('A',9,100),('B',4,200),('A',7,300),('B',8,400),('A',2,500),('B',6,600)])]
    new=[{**r,'risk':10-r['risk'],'value':r['value']*2+7} for r in old]
    def values(data,members=None,cutoff=7):
        kept=[r for r in data if (r['id'] in members if members is not None else r['risk']>=cutoff)]
        return dict(count=len(kept),value=sum(r['value'] for r in kept))
    ids={r['id'] for r in old if r['risk']>=7};initial=values(old)
    save(root,'membership_values',{'old.csv':old,'new.csv':new},[
      ('establish','Use {old.csv}. Each id is a unique patient. Our default cohort is risk >= 7. Report its patient count and total value. Preserve the initial patient membership and the original publication. Return JSON count, value.',initial),
      ('broaden','Broaden default eligibility to risk >= 5 on the original data. Return JSON count, value.',values(old,cutoff=5)),
      ('new_values','A new export is {new.csv}. For a temporary check, use exactly the ORIGINAL cohort patient IDs, but take all values from the new export. Do not re-evaluate risk from the new export. Leave the default unchanged. Return JSON count, value.',values(new,members=ids)),
      ('new_eligibility','Separately, apply our INITIAL eligibility rule to the new export, re-evaluating risk from the new values. This is temporary too. Return JSON count, value.',values(new)),
      ('adopt','Adopt the new export as default and recompute membership using our CURRENT default eligibility rule. Also repeat the original publication for comparison. Return JSON count, value, baseline_count, baseline_value.',{**values(new,cutoff=5),'baseline_count':initial['count'],'baseline_value':initial['value']}),
    ])
    print(root)


def parse(value):
    if isinstance(value,dict):return value
    text=str(value);decoder=json.JSONDecoder();found=[]
    for i,c in enumerate(text):
        if c=='{':
            try:
                v,_=decoder.raw_decode(text[i:])
                if isinstance(v,dict):found.append(v)
            except ValueError:pass
    # Prefer the outermost final JSON object, not its nested regional object.
    if found:return max(found,key=lambda x:len(x))
    try:
        v=ast.literal_eval(text.strip());return v if isinstance(v,dict) else None
    except (ValueError,SyntaxError):return None


def equal(expected,actual):
    if isinstance(expected,dict):return isinstance(actual,dict) and set(expected)==set(actual) and all(equal(v,actual[k]) for k,v in expected.items())
    if isinstance(expected,(int,float)):
        try:return math.isfinite(float(actual)) and abs(expected-float(actual))<=.0001
        except (ValueError,TypeError):return False
    return expected==actual


def score(task,run):
    gold=json.loads((task/'gold.json').read_text());rows=[]
    for i,expected in enumerate(gold,1):
        d=run/f't{i:02}'
        if not (d/'answer.json').exists():continue
        a=json.loads((d/'answer.json').read_text());actual=parse(a.get('answer',''))
        result=dict(turn=i,passed=equal(expected,actual),actual=actual,expected=expected)
        (d/'evaluation.json').write_text(json.dumps(result,indent=2))
        rows.append({**result,**json.loads((d/'stats.json').read_text())})
    summary=dict(turns=len(rows),passed=sum(r['passed'] for r in rows),cost_usd=sum(r['cost_usd'] for r in rows),llm_calls=sum(r['llm_calls'] for r in rows),results=rows)
    (run/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps({k:v for k,v in summary.items() if k!='results'}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['generate','score']);p.add_argument('directory',type=Path);p.add_argument('run',type=Path,nargs='?');a=p.parse_args()
    if a.action=='generate':generate(a.directory.resolve())
    else:score(a.directory,a.run)
