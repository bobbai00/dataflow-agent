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
from study import parse_answer


class AnswerNormalizationTest(unittest.TestCase):
    def test_native_objects_and_wrapper_stringified_objects_are_equivalent(self):
        answer = {'regions': ['East'], 'scores': [32.0]}
        self.assertEqual(parse_answer(str(answer)), answer)
        self.assertEqual(parse_answer(answer), answer)
        self.assertEqual(parse_answer('Final: {"regions":["East"],"scores":[32]}'), answer)

    def test_nonliteral_python_is_not_evaluated(self):
        self.assertIsNone(parse_answer("dict(regions=['East'], scores=[32])"))


if __name__ == '__main__':
    unittest.main()
