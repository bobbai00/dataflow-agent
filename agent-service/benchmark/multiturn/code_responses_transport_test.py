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
import unittest
from types import SimpleNamespace as N
from code_responses_transport import install_responses_transport

class TransportTest(unittest.TestCase):
    def test_preserves_text_roles_and_cache_write_accounting(self):
        requests=[]
        def respond(**kwargs):
            requests.append(kwargs)
            return N(id="response", output_text="print(7)", usage=N(input_tokens=2000,output_tokens=8,
                input_tokens_details=N(cached_tokens=1000,cache_write_tokens=800),output_tokens_details=N(reasoning_tokens=2)))
        model=N(client=N(responses=N(create=respond),chat=N(completions=N(create=None))))
        install_responses_transport(model)
        result=model.client.chat.completions.create(model="gpt-5.6-luna",messages=[
            {"role":"system","content":"rules"},{"role":"user","content":[{"type":"text","text":"question"}]},
            {"role":"assistant","content":"answer"}],reasoning_effort="medium")
        self.assertEqual([m['role'] for m in requests[0]['input']],['developer','user','assistant'])
        self.assertEqual(requests[0]['input'][2]['content'],[{'type':'output_text','text':'answer'}])
        self.assertEqual(requests[0]['reasoning'],{'effort':'medium'})
        self.assertEqual(result.usage.prompt_tokens_details.cache_creation_tokens,800)
        self.assertEqual(result.choices[0].message.content,'print(7)')

if __name__ == '__main__': unittest.main()
