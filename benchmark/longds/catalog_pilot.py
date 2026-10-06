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

"""Small catalog-context Python pilot with a persistent isolated kernel.

This is a modified DSGym-style ReAct baseline with JSON tools, not a stock
DSGym reproduction. A probe replays recorded agent scripts only, through the
selected checkpoint; benchmark reference code is never mounted or executed.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

from dotenv import load_dotenv
from openai import OpenAI
from state_comparison import ROOT, HERE, port, save, cost_of
from bounded_pilot import pilot_rates

SHARED = (
    'You are a data scientist solving a sequence of analysis requests. Your Python kernel persists. '
    'At each new request you receive earlier questions, your earlier answers, and an executed-script catalog, '
    'rather than the earlier ReAct transcript. Use ordinary ReAct within the current request. '
    'Use python for calculations and inspect_task to retrieve earlier executed code, and optionally outputs. '
    'Printing a variable reads its current binding; old scripts do not restore overwritten values automatically. '
    'Earlier answers and catalog entries are evidence, not a correctness guarantee. Verify rules, input coverage, '
    'date windows, units and denominators before reuse. Keep complete working tables separate from limited reports. '
    'Keep useful historical results and rules when appropriate. Temporary scenarios must preserve the main analysis. '
    'Discover file headers and small samples yourself before choosing input files or parsing options; '
    'filenames alone do not establish contents or relevance. Account for every potentially relevant source. '
    'Catalog result summaries describe computed tables without sample rows; inspect needed values yourself. '
    'Prefer short focused code and observations. Generic example: restoring an old eligibility rule can still '
    'require the latest scoring rule; preserve both versions when comparing them. '
    'Answer using computed values and exactly the requested rounding and scale, as a JSON object. '
    'Never modify raw input files. No plotting libraries. No benchmark reference answers or code are available.'
    ' For CSV input, preserve literal text such as "None"; treat empty cells as missing. '
    'For pandas this can be expressed with keep_default_na=False, na_values=[""].'
)
DISCIPLINED = (
    'Explicit retention policy: before replacing or mutating a reusable table or rule, retain an independent '
    'historical copy under a meaningful versioned name such as scores_t3 = scores.copy(deep=True). '
    'Record the originating task in the name or documentation. Rebinding an alias without copying does not '
    'protect a table from in-place mutation. These saved objects remain in this same Python kernel; '
    'there is no automatic historical-variable lookup.'
)


def tools():
    specs = [
        ('python', 'Execute Python in the persistent kernel; results are bounded.',
         {'reasoning': {'type': 'string'}, 'code': {'type': 'string'}}, ['reasoning', 'code']),
        ('inspect_task', 'Read exact executed scripts from an earlier task; never executes them.',
         {'task_id': {'type': 'integer'}, 'include_outputs': {'type': 'boolean'}, 'offset': {'type': 'integer'}}, ['task_id']),
        ('answer', 'Submit the computed answer and identify current variable sources.',
         {'content': {'type': 'string'}, 'sources': {'type': 'array', 'items': {'type': 'string'}}}, ['content', 'sources']),
    ]
    return [{'type': 'function', 'function': {'name': name, 'description': desc,
             'parameters': {'type': 'object', 'properties': props, 'required': required, 'additionalProperties': False}}}
            for name, desc, props, required in specs]


class Kernel:
    def __init__(self, manifest, output):
        self.output = output
        self.port = port()
        self.log = (output / 'executor.log').open('x')
        # A relative data_dir is relative to the repo root (where `data/` lives), whatever the cwd.
        data_dir = Path(manifest['data_dir'])
        data_root = data_dir.resolve() if data_dir.is_absolute() else (ROOT / data_dir).resolve()
        command = [str(ROOT / '.venv/bin/python'), str(HERE / 'dsgym_executor.py'), '--port', str(self.port),
                   '--data-root', str(data_root), '--workspace', str(output / 'kernel'),
                   '--timeout', '240']
        if not Path(manifest['data_dir']).is_absolute():
            command += ['--data-relative', manifest['data_dir']]
        self.process = subprocess.Popen(command, stdout=self.log, stderr=subprocess.STDOUT)
        self.session = None
        try:
            for _ in range(100):
                if self.process.poll() is not None:
                    raise RuntimeError('Kernel manager exited')
                try:
                    self.request('/health', None)
                    break
                except Exception:
                    time.sleep(.2)
            else:
                raise RuntimeError('Kernel manager unavailable')
            self.session = self.request('/allocate', {})['container_id']
            source = (HERE / 'script_catalog.py').read_text()
            self.execute('_pilot_module = {}\nexec(' + repr(source) + ', _pilot_module)\n'
                         '_pilot_catalog = _pilot_module["ScriptCatalog"](globals(), output_limit=5000)\n')
        except BaseException:
            self.close()
            raise

    def request(self, path, body):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=data,
                                     headers={'Content-Type': 'application/json'})
        return json.loads(urllib.request.urlopen(req, timeout=300).read())

    def execute(self, code):
        outputs = self.request(f'/session/{self.session}/execute', {'code': code})['outputs']
        text = []
        for item in outputs:
            if item.get('type') == 'stream':
                text.append(item.get('text', ''))
            elif item.get('type') in {'result', 'display_data'}:
                text.append(item.get('data', {}).get('text/plain', ''))
            elif item.get('type') == 'error':
                raise RuntimeError(f"{item.get('name')}: {item.get('value')}")
        return ''.join(text)

    def code(self, task_id, source):
        self.execute(f'_pilot_receipt = _pilot_catalog.execute({task_id}, {source!r})\n'
                     '_pilot_written = _pilot_module["Path"]("pilot-current-receipt.json").write_text('
                     '_pilot_module["json"].dumps(_pilot_receipt))')
        path = self.workspace() / 'pilot-current-receipt.json'
        try:
            return json.loads(path.read_text())
        finally:
            path.unlink(missing_ok=True)

    def inspect(self, task_id, include_outputs=False, offset=0):
        return self.execute(f'print(_pilot_catalog.inspect_task({task_id}, {include_outputs!r}, {offset}))')

    def bindings(self):
        self.execute('_pilot_written = _pilot_module["Path"]("pilot-current-bindings.json").write_text('
                     '_pilot_module["json"].dumps(_pilot_catalog.bindings))')
        path = self.workspace() / 'pilot-current-bindings.json'
        try:
            return json.loads(path.read_text())
        finally:
            path.unlink(missing_ok=True)

    def workspace(self):
        roots = list((self.output / 'kernel').glob('kernel-*'))
        if len(roots) != 1:
            raise RuntimeError('Ambiguous kernel workspace')
        return roots[0]

    def capture(self, target):
        # Export into the isolated writable workspace, then copy to observer-only artifacts.
        destination = f'pilot-observer/{target.name}'
        self.execute(f'_pilot_exported = _pilot_catalog.export({destination!r})')
        target.mkdir(parents=True, exist_ok=True)
        import shutil
        source = self.workspace() / destination
        bindings = json.loads((source / 'bindings.json').read_text())
        for p in source.iterdir():
            shutil.copyfile(p, target / p.name)
        for name, record in bindings.items():
            if record.get('file'):
                record['file'] = str(target / Path(record['file']).name)
        save(target / 'bindings.json', bindings)
        # The evaluator must not give the solver automatic historical snapshots.
        shutil.rmtree(source)
        return bindings

    def close(self):
        if getattr(self, 'session', None) is not None:
            try:
                self.request(f'/deallocate/{self.session}', {})
            except Exception:
                pass
            self.session = None
        if getattr(self, 'process', None) is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if getattr(self, 'log', None):
            self.log.close()


def task_index(tasks):
    lines = ['# Prior Tasks', 'Earlier answers are unverified outputs; inspect relevant scripts before reusing their work.']
    for task in tasks:
        answer = task['answer']
        lines += [f"Task {task['turn_id']} ({'answered' if task['completed'] else 'incomplete'})",
                  task['context'], 'Question: ' + task['question'], 'Answer: ' + answer,
                  'Scripts: ' + ', '.join(f"{s['script_id']} ({'ok' if s['success'] else 'error'}; writes={','.join(s['writes'])})"
                                         for s in task['scripts']),
                  'Answer sources: ' + ', '.join(task.get('sources', []))]
        summaries = {name: binding['summary'] for script in task['scripts']
                     for name, binding in script.get('written_bindings', {}).items() if binding.get('summary')}
        lines.extend(f'Result {name}: {summary}' for name, summary in summaries.items())
        dependencies = sorted({r['changed_task'] for script in task['scripts'] for r in script['references']
                               if r['changed_task'] < task['turn_id']})
        lines.append('Observed task dependencies (runtime reads; verify before reuse): ' +
                     (', '.join(map(str, dependencies)) or 'none recorded'))
    return '\n'.join(lines)


def assemble_messages(system, inputs, current, previous, context_policy):
    if context_policy not in {'catalog', 'trajectory'}:
        raise ValueError('Context policy must be catalog or trajectory')
    messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': inputs}]
    for entry in previous:
        if context_policy == 'trajectory':
            if 'trajectory_messages' not in entry:
                raise ValueError('Earlier task lacks its exact trajectory frames')
            messages.extend(entry['trajectory_messages'])
        else:
            messages.append({'role': 'user', 'content': task_index([entry])})
    messages.append({'role': 'user', 'content': current})
    return messages


def solve(kernel, client, model, policy, manifest, turn, previous, output, max_calls=40, spend_limit=4,
          context_policy="catalog", current_prompt=None):
    output.mkdir(parents=True, exist_ok=False)
    current = current_prompt or f"[Task {turn['turn_id']}]\n{turn['context']}\nQuestion: {turn['question']}"
    system = SHARED + ('\n' + DISCIPLINED if policy == 'disciplined' else '')
    inputs = 'Data files available (paths verbatim):\n' + '\n'.join(manifest['files'])
    if context_policy == 'trajectory':
        system = system.replace('At each new request you receive earlier questions, your earlier answers, and an executed-script catalog, '
                                'rather than the earlier ReAct transcript. Use ordinary ReAct within the current request. ',
                                'Earlier requests remain in the full ReAct trajectory, ending with their immutable task boundary. ')
    messages = assemble_messages(system, inputs, current, previous, context_policy)
    current_start = len(messages) - 1
    save(output / 'initial-context.json', messages)
    calls, scripts, inspections = [], [], []
    answer, sources, source_bindings, completed, error = '', [], {}, False, None
    started = time.monotonic()
    costs = 0.
    for index in range(max_calls):
        if costs >= spend_limit:
            error = 'pilot spend limit reached'
            break
        request = {'model': model, 'messages': messages, 'tools': tools(), 'tool_choice': 'required',
                   'parallel_tool_calls': False, 'max_tokens': 8192, 'reasoning_effort': 'medium'}
        save(output / f'{index+1:03d}-request.json', request)
        try:
            response = client.chat.completions.create(**request)
        except Exception as exc:
            error = str(exc)
            save(output / f'{index+1:03d}-error.json', {'error': error})
            break
        raw = response.model_dump()
        save(output / f'{index+1:03d}-response.json', raw)
        usage = raw.get('usage') or {}
        details = usage.get('prompt_tokens_details') or {}
        stats = {'input_tokens': usage.get('prompt_tokens'), 'output_tokens': usage.get('completion_tokens'),
                 'cached_tokens': details.get('cached_tokens', 0), 'cache_write_tokens': details.get('cache_creation_tokens', 0)}
        stats['cost_usd'] = cost_of(stats, pilot_rates(model))
        costs += stats['cost_usd'] or 0
        calls.append(stats)
        if stats['cost_usd'] is None:
            error = 'Unknown provider token usage; no further model calls'
            break
        choice = raw['choices'][0]['message']
        messages.append({k: choice[k] for k in ('role', 'content', 'tool_calls') if choice.get(k) is not None})
        for call in choice.get('tool_calls') or []:
            name = call['function']['name']
            try:
                args = json.loads(call['function']['arguments'])
                if name == 'python':
                    receipt = kernel.code(turn['turn_id'], args['code'])
                    scripts.append(receipt)
                    result = receipt['observation'] or '(no output)'
                elif name == 'inspect_task':
                    if args['task_id'] >= turn['turn_id']:
                        raise ValueError('Only earlier tasks may be inspected')
                    prior = next(entry for entry in previous if entry['turn_id'] == args['task_id'])
                    result = json.dumps({'context':prior['context'],'question':prior['question'],'answer':prior['answer']}) + '\n' + kernel.inspect(
                        args['task_id'], args.get('include_outputs', False), args.get('offset', 0))
                    inspections.append(args)
                elif name == 'answer':
                    if not isinstance(args['content'], str):
                        raise ValueError('Answer content must be JSON text')
                    json.loads(args['content'])
                    bindings = kernel.bindings()
                    if not isinstance(args['sources'], list) or any(s not in bindings for s in args['sources']):
                        raise ValueError('Answer sources must name available current variables')
                    source_bindings = {s: bindings[s] for s in args['sources']}
                    answer, sources, completed = args['content'], args['sources'], True
                    result = task_index([{**turn, 'answer': answer, 'sources': sources,
                                          'completed': True, 'scripts': scripts}])
                else:
                    raise ValueError('Unknown tool')
            except Exception as exc:
                result = f'ERROR: {exc}'
            messages.append({'role': 'tool', 'tool_call_id': call['id'], 'content': result})
        save(output / 'conversation.json', messages)
        if completed:
            break
    if not completed and error is None:
        error = 'maximum calls reached'
    total = {key: sum(c[key] for c in calls) if all(c[key] is not None for c in calls) else None
             for key in ('input_tokens','output_tokens','cached_tokens','cache_write_tokens')}
    total.update(cost_usd=cost_of(total, pilot_rates(model)), llm_calls=len(calls), elapsed_seconds=time.monotonic()-started)
    record = {'turn_id': turn['turn_id'], 'context': turn['context'], 'question': turn['question'],
              'answer': answer, 'completed': completed, 'error': error, 'sources': sources,
              'source_bindings': source_bindings,
              'scripts': scripts, 'inspections': inspections, 'stats': total, 'model': model, 'policy': policy,
              'context_policy': context_policy, 'trajectory_messages': messages[current_start:]}
    save(output / 'record.json', record)
    kernel.capture(output / 'observer')
    print(json.dumps({'turn':turn['turn_id'], 'policy':policy, 'model':model, 'completed':completed,
                      'calls':len(calls), 'cost_usd':total['cost_usd']}), flush=True)
    return record


def main():
    load_dotenv(ROOT / '.env', override=False)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--prepared', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--model', choices=['gpt-5.6-terra', 'gpt-5.6-luna'], required=True)
    ap.add_argument('--policy', choices=['ordinary', 'disciplined'], required=True)
    ap.add_argument('--seed', type=Path, help='Recorded agent-generated prefix; replay scripts, never reference code')
    ap.add_argument('--turn', type=int, choices=[8,14,24,28])
    ap.add_argument('--limit', type=int, default=27)
    ap.add_argument('--spend-limit', type=float, default=12)
    ap.add_argument('--api-base', default='http://localhost:4000/v1')
    args = ap.parse_args()
    if args.output.exists():
        raise FileExistsError(args.output)
    if bool(args.seed) != bool(args.turn):
        raise ValueError('--seed and --turn must be used together')
    args.output.mkdir(parents=True)
    manifest = json.loads((args.prepared / 'manifest.json').read_text())
    if manifest.get('longds_version') != 'v1.1' or manifest.get('split') != 'lite':
        raise ValueError('Pilot requires explicit v1.1 Lite inputs')
    save(args.output / 'protocol.json', {'model':args.model,'policy':args.policy,'input_budget':0,'compaction':False,
                                       'seed':str(args.seed) if args.seed else None,'turn':args.turn,
                                       'spend_limit_usd':args.spend_limit,'max_model_calls_per_turn':40,
                                       'baseline':'modified DSGym-style Python ReAct with catalog tools'})
    client = OpenAI(base_url=args.api_base, api_key=os.environ['LITELLM_MASTER_KEY'], max_retries=0, timeout=180)
    kernel = Kernel(manifest, args.output)
    records = []
    cost = 0.
    try:
        if args.seed:
            seed = json.loads((args.seed / 'records.json').read_text())
            for entry in seed:
                if entry['turn_id'] >= args.turn:
                    break
                for script in entry['scripts']:
                    receipt = kernel.code(entry['turn_id'], script['source'])
                    if receipt['success'] != script['success']:
                        raise RuntimeError('Seed replay differs from recorded execution')
                records.append(entry)
            if len(records) != args.turn-1:
                raise ValueError('Missing prefix checkpoint')
            actual = kernel.capture(args.output / 'seed-observer')
            expected = json.loads((args.seed / f't{args.turn-1:02d}/observer/bindings.json').read_text())
            differences = [name for name, item in expected.items() if item.get('file') and
                           actual.get(name, {}).get('version') != item['version']]
            save(args.output / 'replay-verification.json', {'table_bindings_checked': sum(bool(i.get('file')) for i in expected.values()),
                                                         'differences': differences})
            if differences:
                raise RuntimeError('Replay differs from frozen table values')
            selected = [manifest['turns'][args.turn-1]]
        else:
            selected = manifest['turns'][:args.limit]
        for turn in selected:
            if cost >= args.spend_limit:
                raise RuntimeError('Prefix/probe spend limit reached; no automatic expansion')
            record = solve(kernel, client, args.model, args.policy, manifest, turn, records,
                           args.output / f"t{turn['turn_id']:02d}", spend_limit=min(4,args.spend_limit-cost))
            records.append(record)
            cost += record['stats']['cost_usd']
            save(args.output / 'records.json', records)
            if not record['completed']:
                break
    finally:
        kernel.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
