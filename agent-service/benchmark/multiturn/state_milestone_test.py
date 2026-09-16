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
"""Validate all 48 controlled answers with a separate pandas implementation."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest

import pandas as pd

HERE = Path(__file__).resolve().parent
generate = runpy.run_path(str(HERE / 'state-milestone.py'))['generate']
equal = runpy.run_path(str(HERE / 'task-study.py'))['equal']


class GoldTest(unittest.TestCase):
    def test_all_reference_answers_and_public_private_split(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); generate(root)
            checked = 0
            def data(family, filename): return pd.read_csv(root/family/filename)
            def check(family, expected):
                nonlocal checked
                gold = json.loads((root/family/'gold.json').read_text())
                session = json.loads((root/family/'session.json').read_text())
                private = json.loads((root/family/'checks.json').read_text())
                self.assertEqual(len(gold),8); self.assertEqual(len(private),8)
                self.assertTrue(all(set(t)=={'id','prompt'} for t in session['turns']))
                for i,(a,b) in enumerate(zip(gold,expected),1):
                    self.assertTrue(equal(a,b),f'{family} task {i}: {a} != {b}'); checked+=1
            def profit(df, returns=False, fee=0):
                df=df.assign(profit=(df.units-(df.returned if returns else 0))*df.price-df.units*(df.cost+fee))
                return dict(total=int(df.profit.sum()),regional=df.groupby('region').profit.sum().to_dict(),units=int(df.units.sum()))
            d=data('fanout_correction','orders.csv'); initial=profit(d); east=profit(d[d.region=='East']); fixed=profit(d,True)
            check('fanout_correction',[initial,east,fixed,dict(campaign_total=42),{**profit(d,True,2),'baseline_total':initial['total'],'temporary_total':east['total']},fixed,dict(west_total=fixed['regional']['West'],units=fixed['units'],temporary_total=east['total']),{**fixed,'baseline_total':initial['total']}])
            def energy(df, tariff): return dict(bill=round(float(df.kwh.sum()*tariff),6),intensity=round(float(df.kwh.sum()/df.area.sum()),6))
            d=data('temporary_scope','energy.csv'); initial=energy(d,.2); south=energy(d[d.zone=='South'],.5); north=energy(d[d.zone=='North'],.2)
            check('temporary_scope',[initial,energy(d,.3),south,north,{**energy(d,.3),'baseline_bill':initial['bill'],'stress_bill':south['bill']},energy(d,.4),dict(kwh=int(d.kwh.sum())),{**energy(d,.4),'baseline_bill':initial['bill'],'stress_bill':south['bill'],'north_bill':north['bill']}])
            def patients(df): return dict(count=len(df),value=int(df.value.sum()))
            old=data('membership_values','old.csv'); new=data('membership_values','new.csv'); first=old[old.risk>=7]; baseline={'baseline_count':len(first),'baseline_value':int(first.value.sum())}
            check('membership_values',[patients(first),patients(old[old.risk>=5]),patients(new[new.id.isin(first.id)]),patients(new[new.risk>=7]),{**patients(new[new.risk>=5]),**baseline},patients(new[new.id.isin(first.id)&(new.clinic=='A')]),patients(new[new.risk>=6]),{**patients(new[new.risk>=6]),**baseline}])
            old=data('scope_expansion','old.csv'); new=data('scope_expansion','new.csv')
            old['gain']=old.current-old.base;new['gain']=new.current-new.base
            def gains(df): return dict(names=sorted(df.name.tolist()),count=len(df),gain=int(df.gain.sum()))
            leaders=old.nlargest(2,'gain')
            check('scope_expansion',[gains(leaders),dict(count=len(old)),gains(old[old.gain>0]),dict(names=sorted(old.nlargest(3,'current').name.tolist())),gains(new[new.name.isin(leaders.name)]),gains(new.nlargest(2,'gain')),gains(new[new.gain>0]),dict(old_gain=int(old.gain.sum()),new_gain=int(new.gain.sum()),published_gain=int(leaders.gain.sum()))])
            def revenue(df, latest=False, fee=0):
                df=df.sort_values('updated').drop_duplicates('id',keep='last' if latest else 'first').copy()
                df['net']=df.units*(df.price-fee)
                return dict(total=int(df.net.sum()),regional=df.groupby('region').net.sum().to_dict(),units=int(df.units.sum()))
            d=data('repair_descendants','orders.csv'); initial=revenue(d); corrected=revenue(d,True); net=revenue(d,True,1); revised=revenue(data('repair_descendants','revised.csv'),True,1)
            check('repair_descendants',[initial,dict(east_total=initial['regional']['East']),{**corrected,'baseline_total':initial['total']},net,dict(baseline_total=initial['total'],east_total=initial['regional']['East']),revenue(data('repair_descendants','reordered.csv'),True,1),revised,{**revised,'baseline_total':initial['total']}])
            controls=[]
            for i in range(8):
                d=data('independent_control',f'independent_{i}.csv');controls.append(dict(count=len(d),total=int(d.value.sum())))
            check('independent_control',controls)
            self.assertEqual(checked,48)


if __name__ == '__main__':
    unittest.main()
