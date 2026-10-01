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

"""Run smolagents' own persistent local interpreter with only task data mounted.

The host owns the model connection. A separate process owns the standard
LocalPythonExecutor, including its normal import restrictions and final_answer
semantics. Reference answers, other runs and provider credentials are absent
from that process. This adapter changes access, not the code interpreter.
"""
import json
import os
from pathlib import Path
import select
import subprocess
import sys

from smolagents.local_python_executor import CodeOutput, PythonExecutor


class IsolatedSmolExecutor(PythonExecutor):
    def __init__(self, data_root, data_relative, workspace, authorized_imports,
                 max_print_outputs_length, timeout=180):
        from execution_isolation import isolated_command

        workspace = Path(workspace)
        workspace.mkdir(parents=True, exist_ok=True)
        script = Path(__file__).resolve()
        command = isolated_command(
            [sys.executable, "/opt/smolagents_executor.py", "--worker"],
            python=sys.executable, data_roots=[data_root], workspace=workspace,
            read_only=[(script, "/opt/smolagents_executor.py"),
                       (Path(data_root).resolve(), str(Path('/workspace') / data_relative))],
        )
        self.timeout = timeout
        self.state = {}
        self._stderr = (workspace.parent / 'smol-executor.log').open('w')
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self._stderr, text=True, bufsize=1)
        try:
            self._request({'method': 'initialize', 'imports': authorized_imports,
                           'print_limit': max_print_outputs_length})
        except BaseException:
            self.cleanup()
            raise

    def _request(self, payload):
        if self.process.poll() is not None:
            raise RuntimeError('The isolated smolagents interpreter exited; its state is unavailable.')
        self.process.stdin.write(json.dumps(payload, default=str) + '\n')
        self.process.stdin.flush()
        ready, _, _ = select.select([self.process.stdout], [], [], self.timeout)
        if not ready:
            self.cleanup()
            raise RuntimeError(f'Python execution exceeded {self.timeout}s; the interpreter was stopped and its state is unavailable.')
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('The isolated smolagents interpreter closed its response stream.')
        response = json.loads(line)
        self.state['_print_outputs'] = response.get('logs', '')
        if response.get('error'):
            raise RuntimeError(response['error'])
        return response

    def send_tools(self, tools):
        if set(tools) != {'final_answer'}:
            raise ValueError('This benchmark adapter supports only the standard final_answer tool.')

    def send_variables(self, variables):
        self._request({'method': 'variables', 'variables': variables})

    def __call__(self, code_action):
        response = self._request({'method': 'execute', 'code': code_action})
        return CodeOutput(output=response.get('output'), logs=response.get('logs', ''),
                          is_final_answer=response.get('is_final_answer', False))

    def cleanup(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for stream in [self.process.stdin, self.process.stdout, self._stderr]:
            if stream and not stream.closed:
                stream.close()


def worker():
    from smolagents.default_tools import FinalAnswerTool
    from smolagents.local_python_executor import LocalPythonExecutor

    # Keep the RPC stream separate from library output, including native
    # writes to fd 1. smolagents captures its print tool in CodeOutput.logs;
    # other library output normally goes to the runner log, unseen by the LLM.
    protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), 'w', buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    executor = None
    for line in sys.stdin:
        try:
            request = json.loads(line)
            method = request['method']
            if method == 'initialize':
                executor = LocalPythonExecutor(request['imports'], request['print_limit'],
                                                additional_functions={'open': open})
                executor.send_tools({'final_answer': FinalAnswerTool()})
                response = {'ready': True}
            elif method == 'variables':
                executor.send_variables(request['variables'])
                response = {'ready': True}
            elif method == 'execute':
                result = executor(request['code'])
                response = {'output': result.output, 'logs': result.logs,
                            'is_final_answer': result.is_final_answer}
            else:
                raise ValueError(f'Unknown method: {method}')
        except BaseException as error:
            response = {'error': f'{type(error).__name__}: {error}',
                        'logs': str(executor.state.get('_print_outputs', '')) if executor else ''}
        print(json.dumps(response, default=str), file=protocol_output, flush=True)


if __name__ == '__main__':
    if sys.argv[1:] != ['--worker']:
        raise SystemExit('This module is launched by IsolatedSmolExecutor.')
    worker()
