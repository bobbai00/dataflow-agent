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
import importlib.util
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location("state_study",Path(__file__).with_name("state-study.py"))
study=importlib.util.module_from_spec(spec);spec.loader.exec_module(study)
class ScoringTests(unittest.TestCase):
    def test_json_and_python_final_answers_with_nested_regions(self):
        expected={"total":3,"regional":{"East":1,"West":2},"units":4}
        self.assertTrue(study.equal(expected,study.parse(str(expected))))
        self.assertTrue(study.equal(expected,study.parse('```json\n{"total":3,"regional":{"East":1,"West":2},"units":4}\n```')))
    def test_rejects_missing_wrong_extra_and_nonfinite_values(self):
        for actual in [{},{"total":None},{"total":4},{"total":float("nan")},{"total":3,"extra":7}]:
            self.assertFalse(study.equal({"total":3},actual))
        self.assertTrue(study.equal({"total":3},{"total":3.00001}))
if __name__=="__main__":unittest.main()
