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
"""Use the existing matched LongDS CodeAgent wrapper, preserving full traces."""
import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from pathlib import Path
from dotenv import load_dotenv

parser = argparse.ArgumentParser()
parser.add_argument('session', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--kb-root', type=Path, required=True)
parser.add_argument('--env-file', type=Path, required=True)
parser.add_argument('--transport', choices=['chat', 'responses'], default=os.getenv('TASK_CODE_TRANSPORT', 'chat'))
parser.add_argument('--turn-limit', type=int, default=100)
parser.add_argument('--retention', action='store_true',
                    help='Control arm: snapshot every DataFrame when a task ends, address it as retained(task, name), '
                         'and index new or changed tables in the next prompt. No gold, no function library.')
args = parser.parse_args()
ARM = 'coderetain' if args.retention else 'code'
load_dotenv(args.env_file, override=False)
sys.path.insert(0, str(args.kb_root.resolve()))
from code_agent import CodeAgentWrapper
out = args.out.resolve(); out.mkdir(parents=True, exist_ok=False)
spec = json.loads(args.session.read_text())

def write(path, value):
    (out / path).write_text(json.dumps(value, indent=2, default=str))

wrapper = CodeAgentWrapper(model_type='gpt-5.6-luna', max_steps=25,
    max_print_outputs_length=2000, use_custom_prompt=False, use_fine_grained_prompt=False, use_pitfalls_prompt=False, verbosity_level=0,
    api_base=os.getenv('CODE_AGENT_API_BASE', 'http://localhost:4000'),
    api_key=os.getenv('LITELLM_MASTER_KEY', 'dummy')).setup()
cache_key = 'code-' + uuid.uuid4().hex
write('config.json', dict(arm=ARM, retention=args.retention, transport=args.transport, cache_key=cache_key,
     transport_sha256=hashlib.sha256(Path(__file__).with_name('code_responses_transport.py').read_bytes()).hexdigest(), model='gpt-5.6-luna', max_steps=25, stdout_chars=2000,
     custom_prompt=False, fine_grained_prompt=False, pitfalls_prompt=False, session=spec, wrapper=str(args.kb_root / 'code_agent.py'),
     wrapper_sha256=hashlib.sha256((args.kb_root / 'code_agent.py').read_bytes()).hexdigest(),
     python=sys.version, cost_rates_usd_per_million=dict(input=.2, cached_input=.02, cache_write=.25, output=1.2)))
if args.transport == 'responses':
    from code_responses_transport import install_responses_transport
    install_responses_transport(wrapper._model, cache_key)
else:
    # Preserve ordinary Chat generation while isolating its cache accounting.
    wrapper._model.kwargs["extra_body"] = {"prompt_cache_key": cache_key}
# Retention control: the same kind of task-addressable state the dataflow arm
# gets from `atTask`, provided to ordinary Python. Every data variable the
# agent itself created — tables, arrays, lists, dicts, scalars — is kept
# exactly as it stood when the task ended; the index names new or changed
# variables so the prompt carries what a catalog card carries (name, kind,
# shape) and is charged the same way. No gold, no function library.
retained_root = out / 'retained'
retained_index = []      # one line per (task, variable) first seen or changed
retained_digests = {}    # variable name -> sha256 of its last snapshot
RETAINED_KINDS = (list, dict, tuple, set, int, float, str, bool)


def retained(task, name):
    """Exact copy of variable `name` as it was when task `task` finished."""
    import pickle
    path = retained_root / f't{int(task):02}' / f'{name}.pkl'
    if not path.exists():
        raise KeyError(f'no retained variable {name!r} at task {task}; use a task listed in the retained-state index')
    with path.open('rb') as handle:
        return pickle.load(handle)


def describe_retained(value):
    import pandas as pd
    if isinstance(value, pd.DataFrame):
        columns = ', '.join(map(str, value.columns[:12])) + (', ...' if value.shape[1] > 12 else '')
        return f'table {value.shape[0]} rows x {value.shape[1]} cols: {columns}'
    if isinstance(value, pd.Series):
        return f'series of {len(value)}'
    if hasattr(value, 'shape') and hasattr(value, 'dtype'):
        return f'array shape {tuple(value.shape)}'
    if isinstance(value, (list, tuple, set)):
        inner = type(next(iter(value))).__name__ if value else 'empty'
        return f'{type(value).__name__} of {len(value)} {inner}'
    if isinstance(value, dict):
        keys = ', '.join(map(str, list(value)[:8])) + (', ...' if len(value) > 8 else '')
        return f'dict of {len(value)}: {keys}'
    preview = repr(value)
    return f'{type(value).__name__} = {preview[:60]}' + ('...' if len(preview) > 60 else '')


def snapshot_state(directory):
    import pickle
    import types
    import pandas as pd
    folder = retained_root / directory
    folder.mkdir(parents=True, exist_ok=True)
    kept, changed, total_bytes = 0, [], 0
    for name, value in list(wrapper._agent.python_executor.state.items()):
        if name.startswith('_') or name == 'retained' or isinstance(value, (types.ModuleType, type)) or callable(value):
            continue
        data = isinstance(value, (pd.DataFrame, pd.Series)) or (hasattr(value, 'shape') and hasattr(value, 'dtype'))
        if not data and not isinstance(value, RETAINED_KINDS):
            continue
        path = folder / f'{name}.pkl'
        try:
            with path.open('wb') as handle:
                pickle.dump(value, handle)
        except Exception:
            path.unlink(missing_ok=True)
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        total_bytes += path.stat().st_size
        kept += 1
        if retained_digests.get(name) != digest:
            retained_digests[name] = digest
            changed.append(name)
            retained_index.append(f'task {int(directory[1:])}: {name} ({describe_retained(value)})')
    return dict(retained_variables=kept, retained_changed=changed, retained_bytes=total_bytes)


def retained_preamble():
    if not retained_index:
        return ''
    return ('Retained state from earlier tasks. Each entry is the variable exactly as it stood when that task '
            'ended; load one with retained(task, name). An entry listed at an earlier task and not listed again '
            'is unchanged since then.\n' + '\n'.join(retained_index) + '\n\n')


if args.retention:
    retained_root.mkdir()
prior = 0
for index, turn in enumerate(spec['turns'][:args.turn_limit], 1):
    directory = f't{index:02}'; (out / directory).mkdir()
    prompt = ('We are working through a sequence of analytical tasks in one session. Keep useful state for later requests.\n\n' if index == 1 else '') + turn['prompt']
    if args.retention:
        prompt = retained_preamble() + prompt
        wrapper._agent.python_executor.send_variables({'retained': retained})
    write(f'{directory}/prompt.json', dict(id=turn['id'], prompt=prompt))
    wrapper._model.reset_usage()
    started = time.monotonic()
    try:
        result = wrapper._agent.run(prompt, reset=index == 1, return_full_result=True)
        answer = result.output
        if hasattr(answer, 'to_raw'): answer = answer.to_raw()
        write(f'{directory}/answer.json', dict(answer=answer, error=None))
    except (Exception, SystemExit) as error:
        write(f'{directory}/answer.json', dict(answer='', error=str(error)))
    memory = wrapper._agent.memory.steps
    steps = memory[prior:]; prior = len(memory)
    trace = []
    for step in steps:
        item = {'type': type(step).__name__}
        for name in ['step_number', 'model_output', 'code_action', 'observations', 'action_output', 'error', 'is_final_answer']:
            value = getattr(step, name, None)
            if value is not None: item[name] = value
        trace.append(item)
    write(f'{directory}/react_steps.json', trace)
    usage = wrapper._model.usage_acc
    input_tokens, output_tokens, cached_tokens = [int(usage.get(k, 0) or 0) for k in ['input', 'output', 'cached']]
    written = int(usage.get('cache_creation', 0) or 0)
    stats = dict(cache_write_tokens=written, input_tokens=input_tokens, output_tokens=output_tokens, cached_tokens=cached_tokens,
        reasoning_tokens=int(usage.get('reasoning', 0) or 0),
        llm_calls=int(usage.get('calls', 0) or 0), memory_steps=len(memory),
        cost_usd=((input_tokens-cached_tokens-written)*.2 + cached_tokens*.02 + written*.25 + output_tokens*1.2)/1e6,
        elapsed_seconds=time.monotonic()-started)
    if args.retention:
        stats.update(snapshot_state(directory))
    write(f'{directory}/stats.json', stats)
    print(json.dumps(dict(arm=ARM, turn=index, **stats)), flush=True)
