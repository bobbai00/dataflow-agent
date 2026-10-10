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
"""Source audit regressions for mixed Excel values and published schemas."""
import json
from pathlib import Path
import tempfile
import unittest

import pandas as pd

from benchmark.retrieval.verify_source_profiles import verify


class SourceProfileTests(unittest.TestCase):
    def check_mixed_column(self, zero_count):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "mixed.xlsx"
            pd.DataFrame({"id": [1, 2, 3, 4, 5], "flag": [0, "0", 1, "NA", None]}).to_excel(source, index=False)
            column = {
                "type": "str", "rowsProcessed": 5, "nullCount": 1,
                "nonnullCount": 4, "distinctCount": 3, "min": None, "max": None,
                "frequencies": {"values": [
                    {"value": {"type": "str", "value": "0"}, "count": zero_count},
                    {"value": {"type": "str", "value": "1"}, "count": 1},
                    {"value": {"type": "str", "value": "NA"}, "count": 1},
                ]},
            }
            snapshot = {
                "workflow": {"operators": [{"operatorID": "source", "nativeOp": {
                    "type": "Scan", "properties": {"files": str(source)},
                }}]},
                "results": {"source": {"tableProfile": {
                    "rowCount": 5, "coverage": {"rowsProcessed": 5}, "columns": {"flag": column},
                }}},
            }
            task = root / "system_scratch" / "SUT" / "task"
            task.mkdir(parents=True)
            (task / "snapshot.json").write_text(json.dumps(snapshot))
            return verify(root, "SUT", ["task:source"])

    def test_mixed_excel_cells_are_compared_in_the_published_string_schema(self):
        result = self.check_mixed_column(2)
        self.assertEqual(result["failures"], [])
        self.assertEqual(result["sources"][0]["checks"], 6)

    def test_incorrect_frequency_still_fails_after_schema_conversion(self):
        result = self.check_mixed_column(3)
        self.assertEqual(result["failures"], [{
            "task": "task", "operator": "source", "column": "flag",
            "metric": "frequency", "actual": 2, "recorded": 3,
        }])


if __name__ == "__main__":
    unittest.main()
