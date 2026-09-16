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
args = parser.parse_args()
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
write('config.json', dict(arm='code', transport=args.transport, cache_key=cache_key,
     transport_sha256=hashlib.sha256(Path(__file__).with_name('code_responses_transport.py').read_bytes()).hexdigest(), model='gpt-5.6-luna', max_steps=25, stdout_chars=2000,
     custom_prompt=False, fine_grained_prompt=False, pitfalls_prompt=False, session=spec, wrapper=str(args.kb_root / 'code_agent.py'),
     wrapper_sha256=hashlib.sha256((args.kb_root / 'code_agent.py').read_bytes()).hexdigest(),
     python=sys.version, cost_rates_usd_per_million=dict(input=.2, cached_input=.02, cache_write=.25, output=1.2)))
if args.transport == 'responses':
    from code_responses_transport import install_responses_transport
    install_responses_transport(wrapper._model, cache_key)
prior = 0
for index, turn in enumerate(spec['turns'][:args.turn_limit], 1):
    directory = f't{index:02}'; (out / directory).mkdir()
    prompt = ('We are working through a sequence of analytical tasks in one session. Keep useful state for later requests.\n\n' if index == 1 else '') + turn['prompt']
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
    write(f'{directory}/stats.json', stats)
    print(json.dumps(dict(arm='code', turn=index, **stats)), flush=True)
