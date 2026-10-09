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

"""Native half of the small state pilot: one paid prefix, exact action replay.

Snapshot bodies are observer-only. A replay uses original agent-authored
actions and requests, not evaluator references, and makes no model calls.
"""
import argparse
import gzip
import json
import os
from pathlib import Path
import subprocess
import time

from dotenv import load_dotenv
from state_comparison import ROOT, save, cost_of, arm_settings
from bounded_pilot import pilot_rates

SETTINGS = {**arm_settings('history'), 'taskContext': 'dependencies', 'nativePromptDetail': 'full'}


class Native:
    def __init__(self, output, model, settings=None, complete_observer_tables=False):
        self.output = output
        self.complete_observer_tables = complete_observer_tables
        self.log = (output / 'bridge.log').open('x')
        env = dict(os.environ)
        env['TEXERA_SERVICE_LOG_LEVEL'] = 'ERROR'
        self.process = subprocess.Popen(['bun', 'run', str(ROOT / 'agent-service/benchmark/multiturn/state-pilot-rpc.ts')],
                                        cwd=ROOT / 'agent-service', env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=self.log, text=True, bufsize=1)
        self.counter = 0
        try:
            created = self.rpc('create', model=model, settings={**SETTINGS, **(settings or {})})
        except BaseException:
            self.close()
            raise
        self.resource = created['resource']
        self.agent_id = self.resource['agentId']
        save(output / 'resource.json', self.resource)
        save(output / 'system-info.json', created['system'])
        save(output / 'settings.json', created['settings'])
        if created['system']['inputBudget']['tokens'] != 0:
            self.close()
            raise RuntimeError('Native pilot must not have an added input token budget')
        self.model = model

    def rpc(self, action, **kwargs):
        self.counter += 1
        payload = {'id':self.counter, 'action':action, 'outputDir':str(self.output.resolve()), **kwargs}
        if hasattr(self,'agent_id'):
            payload['agentId'] = self.agent_id
        with (self.output / 'rpc-journal.jsonl').open('a') as out:
            out.write(json.dumps({'id': self.counter, 'action': action, 'phase': 'request'}) + '\n')
        self.process.stdin.write(json.dumps(payload)+'\n')
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError('Native RPC bridge exited; preserve resource.json')
            if not line.startswith('PILOT_RPC:'):
                self.log.write(line)
                self.log.flush()
                continue
            envelope = json.loads(line[len('PILOT_RPC:'):])
            if 'artifact' in envelope:
                path = Path(envelope['artifact'])
                if path.parent != self.output.resolve() / 'rpc-responses':
                    raise RuntimeError('RPC artifact outside the owned output directory')
                response = json.loads(path.read_text())
            else:
                response = envelope
            with (self.output / 'rpc-journal.jsonl').open('a') as out:
                out.write(json.dumps({'id': response['id'], 'action': action, 'phase': 'response',
                                      'error': response.get('error')}) + '\n')
            if response['id'] != self.counter:
                raise RuntimeError('RPC response mismatch')
            if response.get('error'):
                raise RuntimeError(response['error'])
            return response['result']

    def capture(self, directory):
        capture = self.rpc('capture', completeTables=self.complete_observer_tables)
        directory.mkdir(parents=True, exist_ok=True)
        with gzip.open(directory / 'capture.json.gz', 'wt') as out:
            json.dump(capture,out)
        return capture

    def solve(self, turn, prompt, directory):
        directory.mkdir(parents=True, exist_ok=False)
        (directory / 'prompt.txt').write_text(prompt)
        started = time.monotonic()
        result = self.rpc('message', content=prompt)
        with gzip.open(directory / 'react_steps.json.gz','wt') as out:
            json.dump({'steps':result['steps']},out)
        models = [s for s in result['steps'] if s['role']=='agent']
        fields = {'input_tokens':'inputTokens','output_tokens':'outputTokens',
                  'cached_tokens':'cachedInputTokens','cache_write_tokens':'cacheCreationInputTokens'}
        stats = {key:sum(s['usage'][field] for s in models) if all(s.get('usage',{}).get(field) is not None for s in models)
                 else None for key,field in fields.items()}
        stats.update(llm_calls=len(models),elapsed_seconds=time.monotonic()-started)
        stats['cost_usd'] = cost_of(stats,pilot_rates(self.model))
        calls = [c for s in result['steps'] for c in s.get('toolCalls',[]) if c['toolName']=='dataflow']
        record = {'turn_id':turn['turn_id'],'question':turn['question'],'context':turn['context'],
                  'prompt':prompt, 'answer':result['answer'],'completed':result['completed'],
                  'headId':result['headId'],'native_actions':[c['input'] for c in calls],
                  'stats':stats,'model':self.model,'policy':'dataflow'}
        save(directory / 'record.json',record)
        self.capture(directory / 'observer')
        print(json.dumps({'turn':turn['turn_id'],'policy':'dataflow','model':self.model,
                          'completed':result['completed'],'calls':len(models),'cost_usd':stats['cost_usd']}),flush=True)
        return record

    def replay(self, records, upto):
        checkpoints = {}
        for entry in records:
            if entry['turn_id'] > upto:
                break
            result = self.rpc('debug',content=entry['prompt'])
            for action in entry['native_actions']:
                result = self.rpc('debug',tool='dataflow',args=action)
            checkpoints[entry['turn_id']] = result['headId']
            print(f"REPLAYED native Q{entry['turn_id']}",flush=True)
        return checkpoints

    def close(self):
        if getattr(self,'agent_id',None):
            try:
                self.rpc('delete')
                save(self.output/'cleanup.json',{'status':'removed','resource':self.resource})
            except Exception as exc:
                save(self.output/'cleanup.json',{'status':'failed','error':str(exc),'resource':self.resource})
            self.agent_id = None
        if getattr(self,'process',None):
            self.process.stdin.close()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=10)
        if getattr(self,'log',None):
            self.log.close()


def main():
    load_dotenv(ROOT / '.env',override=False)
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--prepared',type=Path,required=True)
    ap.add_argument('--output',type=Path,required=True)
    ap.add_argument('--model',choices=['gpt-5.6-terra','gpt-5.6-luna'],required=True)
    ap.add_argument('--seed',type=Path)
    ap.add_argument('--turn',type=int,choices=[8,14,24,28])
    ap.add_argument('--turns',type=int,nargs='+',choices=[8,14,24,28])
    ap.add_argument('--limit',type=int,default=27)
    ap.add_argument('--spend-limit',type=float,default=12)
    args=ap.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    probe_turns = args.turns or ([args.turn] if args.turn else [])
    if bool(args.seed)!=bool(probe_turns) or args.turn and args.turns:
        raise ValueError('--seed requires --turn or --turns')
    args.output.mkdir(parents=True)
    manifest=json.loads((args.prepared/'manifest.json').read_text())
    if manifest.get('longds_version')!='v1.1' or manifest.get('split')!='lite':
        raise ValueError('Pilot requires explicit v1.1 Lite inputs')
    prompts={p['turn_id']:p['prompt'] for p in json.loads((args.prepared/'prompts.json').read_text())}
    save(args.output/'protocol.json',{'model':args.model,'input_budget':0,'compaction':False,
                                    'seed':str(args.seed) if args.seed else None,'turns':probe_turns,
                                    'spend_limit_usd':args.spend_limit,'settings':SETTINGS})
    native=None
    records=[]
    cost=0.
    try:
        if args.seed:
            seed=json.loads((args.seed/'records.json').read_text())
            maximum = max(probe_turns)-1
            if len([r for r in seed if r['turn_id']<=maximum])!=maximum:
                raise ValueError('Incomplete seed checkpoint')
            selected=[manifest['turns'][n-1] for n in probe_turns]
        else:
            native=Native(args.output,args.model)
            selected=manifest['turns'][:args.limit]
        for turn in selected:
            if cost>=args.spend_limit:
                raise RuntimeError('Prefix/probe spend limit reached; no automatic expansion')
            if args.seed:
                # Checkout preserves the archive's other branches. A fresh
                # replayed prefix is needed to exclude later tasks completely.
                if native is not None:
                    native.close()
                resource_dir=args.output/f"resources-t{turn['turn_id']:02d}"
                resource_dir.mkdir()
                native=Native(resource_dir,args.model)
                native.replay(seed,turn['turn_id']-1)
                before=native.capture(args.output/f"seed-observer-t{turn['turn_id']:02d}")
                if [t['task_id'] for t in before['history']['tasks']]!=list(range(1,turn['turn_id'])):
                    raise RuntimeError('Seed catalog contains missing or future tasks')
            records.append(native.solve(turn,prompts[turn['turn_id']],args.output/f"t{turn['turn_id']:02d}"))
            amount=records[-1]['stats']['cost_usd']
            if amount is None:
                raise RuntimeError('Unknown cost: stop before further paid turns')
            cost+=amount
            save(args.output/'records.json',records)
            if not records[-1]['completed']:
                break
    finally:
        if native is not None:
            native.close()
    return 0


if __name__=='__main__':
    raise SystemExit(main())
