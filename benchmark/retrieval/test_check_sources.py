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

import os
from pathlib import Path
import tempfile
import unittest

from benchmark.retrieval.check_sources import KB, corrected, unresolved


class CheckSourcesTests(unittest.TestCase):
    def test_wrong_declared_names_are_corrected_for_suffixed_task_ids(self):
        self.assertEqual(corrected("astronomy-hard-9", ["omni2_low_res/omni2.txt", "other.csv"]),
                         ["omni2_low_res/omni2.text", "other.csv"])
        self.assertEqual(corrected("astronomy-hard-9-2", ["omni2_low_res/omni2.txt"]), ["omni2_low_res/omni2.text"])
        self.assertEqual(corrected("environment-easy-1", ["omni2_low_res/omni2.txt"]), ["omni2_low_res/omni2.txt"])

    def test_missing_paths_and_paths_outside_the_data_root_are_reported(self):
        present = "data/environment/input/water-body-testing-2013.csv"
        self.assertTrue((KB / present).exists())
        self.assertEqual(unresolved([present], roots=[KB]), [])
        self.assertEqual(unresolved(["data/environment/input/missing.csv"], roots=[KB]),
                         [f"data/environment/input/missing.csv (from {KB})"])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data").mkdir()
            outside = root / "outside.csv"
            outside.write_text("x\n1\n")
            os.symlink(outside, root / "data" / "linked.csv")
            problems = unresolved(["data/linked.csv"], roots=[root])
            self.assertEqual(len(problems), 1)
            self.assertIn("outside the data root", problems[0])


if __name__ == "__main__":
    unittest.main()
