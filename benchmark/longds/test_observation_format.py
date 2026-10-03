#!/usr/bin/env python
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

"""Request indexes use the same observation vocabulary as native receipts."""
import unittest
from gold_prefix import column_entries, columns_text, state_listing


class ObservationIndexTests(unittest.TestCase):
    def frames(self):
        return [
            {
                "name": "child",
                "rows": 10012,
                "cols": 2,
                "parents": ["source"],
                "changed_turn": 3,
                "columns": ["a|b", "value"],
            },
            {"name": "source", "rows": 20, "cols": 1, "parents": [], "changed_turn": 1, "columns": ["id"]},
        ]

    def test_markdown_order_and_shape(self):
        text = state_listing(self.frames(), {"scale": "100"}, 3)
        self.assertIn("| operator | kind | inputs | result | task | columns |", text)
        self.assertLess(text.index("| source |"), text.index("| child |"))
        self.assertIn("10,012 × 2", text)
        self.assertIn("a\\|b", text)
        self.assertIn("Constants in force: scale = 100", text)

    def test_tsv_has_no_markdown_separator(self):
        text = state_listing(self.frames(), {}, 3, table_format="tsv")
        self.assertIn("operator\tkind\tinputs\tresult\ttask\tcolumns", text)
        self.assertNotIn("|---|", text)

    def test_compressed_columns_and_physical_omissions(self):
        columns = ["id"] + [f"Q6_{n}" for n in range(1, 21)]
        self.assertEqual(columns_text({"columns": columns, "cols": 25}, 1), "id, … +24 more")
        self.assertEqual(columns_text({"columns": columns, "cols": 21}, 0), "id, Q6_1..Q6_20")
        self.assertEqual(column_entries(["id01", "id02", "id03"]), ["id01", "id02", "id03"])

    def test_empty_and_cycle_are_bounded(self):
        self.assertIn("No operators", state_listing([], {}, 1))
        rows = self.frames()
        rows[1]["parents"] = ["child"]
        self.assertEqual(state_listing(rows, {}, 3).count("\n| child |"), 1)


if __name__ == "__main__":
    unittest.main()
