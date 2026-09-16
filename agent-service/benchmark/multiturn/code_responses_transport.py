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
"""Use the same Responses endpoint for ordinary smolagents text/code generation.

Only the transport changes. The existing model still formats its full memory,
trims stop sequences, and records usage; CodeAgent still executes its own code.
"""
from types import SimpleNamespace as N


def install_responses_transport(model, cache_key=None):
    def create(**kwargs):
        messages = kwargs.pop('messages')
        items = []
        for message in messages:
            role = 'developer' if message['role'] == 'system' else message['role']
            if role not in ['developer', 'user', 'assistant']:
                raise ValueError('CodeAgent text replay requires ordinary message roles')
            content = message['content']
            if isinstance(content, str): content = [{'type': 'text', 'text': content}]
            if any(part['type'] != 'text' for part in content):
                raise ValueError('This CodeAgent transport supports text-only tasks')
            items.append({'role': role, 'content': [{'type': 'output_text' if role == 'assistant' else 'input_text',
                'text': part['text']} for part in content]})
        body = dict(model=kwargs.pop('model'), input=items, store=False)
        if 'reasoning_effort' in kwargs: body['reasoning'] = {'effort': kwargs.pop('reasoning_effort')}
        for key in ['max_tokens', 'max_completion_tokens']:
            if key in kwargs: body['max_output_tokens'] = kwargs.pop(key)
        if 'temperature' in kwargs: body['temperature'] = kwargs.pop('temperature')
        if kwargs: raise ValueError('Unexpected CodeAgent request fields: ' + ', '.join(kwargs))
        # Python SDK extra_body merges at the HTTP root. The nested extra_body
        # is for LiteLLM's forwarding of this newer provider parameter.
        body['extra_body'] = {'extra_body': {'prompt_cache_options': {'mode': 'implicit', 'ttl': '30m'}}}
        if cache_key: body['extra_body']['prompt_cache_key'] = cache_key
        response = model.client.responses.create(**body)
        usage = response.usage
        return N(choices=[N(message=N(role='assistant', content=response.output_text, tool_calls=None))],
            usage=N(prompt_tokens=usage.input_tokens, completion_tokens=usage.output_tokens,
                prompt_tokens_details=N(cached_tokens=usage.input_tokens_details.cached_tokens or 0,
                    cache_creation_tokens=getattr(usage.input_tokens_details, 'cache_write_tokens', 0) or 0),
                completion_tokens_details=N(reasoning_tokens=usage.output_tokens_details.reasoning_tokens or 0)))
    model.client.chat.completions.create = create
