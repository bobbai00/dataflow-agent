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

import unittest
import pandas as pd
from script_catalog import ScriptCatalog


class CatalogTest(unittest.TestCase):
    def test_statistics_default_off_preserves_shape_and_schema_without_values(self):
        cat = ScriptCatalog({'pd': pd})
        receipt = cat.execute(1, 'table = pd.DataFrame({"private": [9123456789], "label": ["PRIVATE_VALUE"]})')
        summary = receipt['written_bindings']['table']['summary']
        self.assertIn('1 row', summary)
        self.assertIn('private:int64', summary)
        self.assertNotIn('9123456789', summary)
        self.assertNotIn('PRIVATE_VALUE', summary)
        self.assertNotIn('stats full', summary)

    def test_overwrite_and_alias_mutation_have_new_versions(self):
        ns = {'pd': pd}
        cat = ScriptCatalog(ns)
        cat.execute(1, 'table = pd.DataFrame({"n": [1]})\nalias = table')
        first = cat.bindings['table']['version']
        cat.execute(2, 'alias.loc[0, "n"] = 2')
        self.assertNotEqual(first, cat.bindings['table']['version'])
        self.assertEqual(cat.bindings['table']['changed_task'], 2)
        self.assertIn('table', cat.scripts[-1]['writes'])

    def test_no_automatic_copy_in_ordinary_condition(self):
        ns = {'pd': pd}
        cat = ScriptCatalog(ns)
        cat.execute(1, 'table = pd.DataFrame({"n": [1]})')
        cat.execute(2, 'table = pd.DataFrame({"n": [2]})')
        self.assertEqual(ns['table'].iloc[0]['n'], 2)
        self.assertNotIn('table_t1', ns)
        self.assertIn('DataFrame', cat.inspect_task(1))

    def test_manual_copy_is_preserved_and_inspection_does_not_execute(self):
        ns = {'pd': pd}
        cat = ScriptCatalog(ns)
        cat.execute(1, 'table = pd.DataFrame({"n": [1]})\ntable_t1 = table.copy()\nprint(123)')
        cat.execute(2, 'table.loc[0, "n"] = 2')
        text = cat.inspect_task(1, include_outputs=True)
        self.assertIn('print(123)', text)
        self.assertIn('123', text)
        self.assertEqual(ns['table_t1'].iloc[0]['n'], 1)
        self.assertEqual(len(cat.scripts), 2)
        with self.assertRaises(KeyError):
            cat.inspect_task(99)

    def test_partial_failures_and_bounded_outputs_are_recorded(self):
        ns = {}
        cat = ScriptCatalog(ns, output_limit=30)
        receipt = cat.execute(1, 'x = 5\nprint("a" * 200)\nraise ValueError("bad")')
        self.assertFalse(receipt['success'])
        self.assertEqual(ns['x'], 5)
        self.assertIn('clipped', receipt['observation'])
        self.assertIn('x', receipt['writes'])

    def test_future_tasks_are_not_retrievable(self):
        cat = ScriptCatalog({})
        cat.execute(1, 'x = 1')
        with self.assertRaises(KeyError):
            cat.inspect_task(2)

    def test_helper_reads_and_output_versions_preserve_provenance(self):
        ns = {'pd': pd}
        cat = ScriptCatalog(ns)
        cat.execute(1, 'table = pd.DataFrame({"n": [1]})\ndef helper():\n return table.copy()')
        receipt = cat.execute(2, 'result = helper()')
        self.assertIn('table', receipt['reads'])
        self.assertEqual(receipt['written_bindings']['result']['changed_task'], 2)
        parents = receipt['written_bindings']['result']['parents']
        self.assertIn({'name': 'table', 'version': cat.bindings['table']['version'], 'task_id': 1}, parents)

    def test_catalog_statistics_describe_the_written_version_without_sample_rows(self):
        ns = {'pd': pd}
        cat = ScriptCatalog(ns, statistics=True)
        first = cat.execute(1, 'table = pd.DataFrame({"amount": [1., None, 3.], "label": ["PRIVATE_RECORD", "b", "c"]})')
        summary = first['written_bindings']['table']['summary']
        self.assertIn('3 rows', summary)
        self.assertIn('null=1/3', summary)
        self.assertIn('range=1..3', summary)
        self.assertNotIn('PRIVATE_RECORD', summary)
        cat.execute(2, 'table = pd.DataFrame({"amount": [10.]})')
        self.assertEqual(first['written_bindings']['table']['summary'], summary)
        self.assertIn('1 row', cat.bindings['table']['summary'])

    def test_summary_handles_empty_and_unhashable_tables(self):
        ns = {'pd': pd}
        cat = ScriptCatalog(ns, statistics=True)
        receipt = cat.execute(1, 'empty = pd.DataFrame({"amount": pd.Series(dtype="float64")})\nobjects = pd.DataFrame({"value": [[1], [2]]})')
        self.assertTrue(receipt['success'])
        self.assertIn('0 rows', receipt['written_bindings']['empty']['summary'])
        self.assertIn('distinct=unknown', receipt['written_bindings']['objects']['summary'])


if __name__ == '__main__':
    unittest.main()
