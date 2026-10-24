# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
import unittest

from handover import files_named_like_operators


class FilesNamedLikeOperators(unittest.TestCase):
    def test_a_file_the_reply_leaves_out_comes_from_the_operator_named_like_it(self):
        # prepbench-hard-124 (Haiku 5.5): the reply named no file, and output_01 held the right table.
        self.assertEqual(files_named_like_operators(["output_01.csv"], {}, {"output_01": {}, "raw": {}}),
                         {"output_01.csv": "output_01"})

    def test_the_reply_mapping_wins_and_an_operator_without_a_result_is_not_used(self):
        results = {"o1": {}, "output_02": {}}
        self.assertEqual(files_named_like_operators(["output_01.csv", "output_02.csv", "output_03.csv"],
                                                    {"output_01.csv": "o1"}, results),
                         {"output_02.csv": "output_02"})
        self.assertEqual(files_named_like_operators(["output_01.csv"], {"output_01.csv": "missing"}, {"output_01": {}}),
                         {})


if __name__ == "__main__":
    unittest.main()
