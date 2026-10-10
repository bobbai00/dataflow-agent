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

import ast
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gold_prefix import seed_changes


class RegisteredSeedTests(unittest.TestCase):
    def test_saved_tables_use_registered_scan_syntax_and_literal_paths(self):
        path = 'data/a "quoted" \\ file.parquet'
        changes, skipped = seed_changes(
            [{"name": "records", "format": "parquet", "file": path},
             {"name": "unsupported", "format": "pickle", "file": "ignored.pkl"}], [], Path("unused"))
        self.assertTrue(changes.startswith("set records: scan(files="))
        call = ast.parse(changes.split(": ", 1)[1], mode="eval").body
        self.assertEqual(call.args, [])
        self.assertEqual({arg.arg: ast.literal_eval(arg.value) for arg in call.keywords},
                         {"files": path, "format": "parquet"})
        self.assertEqual(skipped, ["unsupported"])

    def test_materialized_collections_use_same_grammar_and_do_not_duplicate_tables(self):
        with tempfile.TemporaryDirectory() as root:
            collection = Path(root) / 'values "quoted".parquet'
            with patch("gold_prefix.collection_file", return_value=collection) as materialize:
                changes, skipped = seed_changes(
                    [{"name": "existing", "format": "parquet", "file": "existing.parquet"}],
                    [{"name": "existing"}, {"name": "values"}], Path(root))
        self.assertEqual(len(changes.strip().splitlines()), 2)
        self.assertIn("set values: scan(files=", changes)
        self.assertEqual(materialize.call_count, 1)
        self.assertEqual(skipped, [])


if __name__ == "__main__":
    unittest.main()
