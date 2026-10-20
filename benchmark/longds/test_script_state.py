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

from benchmark.longds.script_state import (earlier_reads, render_variable_context, render_variable_index, statements,
                                           upstream, variable_tasks)


def one(code):
    (statement,) = statements(code, 1, 1)
    return statement


class StatementTest(unittest.TestCase):
    def test_assignments_replace_and_in_place_changes_keep_the_earlier_value(self):
        s = one("clean = raw[raw['year'] > 2000]")
        self.assertEqual((s.writes, s.kills, s.reads), ({"clean"}, {"clean"}, {"raw"}))
        s = one("clean['decade'] = clean['year'] // 10")
        self.assertEqual((s.writes, s.kills, s.reads), ({"clean"}, set(), {"clean"}))
        s = one("clean.drop(columns=['x'], inplace=True)")
        self.assertEqual((s.writes, s.kills), ({"clean"}, set()))
        s = one("rows.append(total)")
        self.assertEqual((s.writes, s.reads), ({"rows"}, {"rows", "total"}))
        self.assertEqual(one("ranked = clean.sort_values('score')").writes, {"ranked"})
        s = one("count += len(rows)")
        self.assertEqual((s.writes, s.kills, s.reads), ({"count"}, set(), {"count", "len", "rows"}))

    def test_inner_scopes_contribute_only_the_outer_names_they_read(self):
        s = one("def score(t, *, w=weight):\n    local = t * w\n    return local + offset\n")
        self.assertEqual((s.kind, s.writes, s.kills), ("def", {"score"}, {"score"}))
        self.assertEqual(s.reads, {"weight", "offset"})
        s = one("top = [r for r in rows if r > limit]")
        self.assertEqual((s.writes, s.reads), ({"top"}, {"rows", "limit"}))
        s = one("keep = frame.apply(lambda row: row['a'] > cut, axis=1)")
        self.assertEqual(s.reads, {"frame", "cut"})
        s = one("for name, group in frame.groupby('k'):\n    totals[name] = group['v'].sum()\n")
        self.assertEqual((s.writes, s.kills), ({"name", "group", "totals"}, set()))
        # A loop's variables and a body's own temporaries are not outside reads.
        self.assertEqual(s.reads, {"frame", "totals"})
        s = one("for c in cols:\n    tmp = frame[c]\n    out[c] = tmp.mean() + bias\n")
        self.assertEqual(s.reads, {"cols", "frame", "out", "bias"})
        s = one("with open(path) as f:\n    text = f.read()\n")
        self.assertEqual(s.reads, {"open", "path"})
        s = one("if ok:\n    last = 1\nelse:\n    last = prior\n")
        self.assertEqual((s.reads, s.kills), ({"ok", "prior"}, set()))
        self.assertEqual(one("import pandas as pd, numpy as np").kind, "import")


class UpstreamTest(unittest.TestCase):
    def test_upstream_follows_replacements_changes_and_functions(self):
        code = [
            (1, "raw = pd.read_csv('a.csv')\nother = pd.read_csv('b.csv')"),
            (1, "def clean_rows(frame):\n    return frame[frame['v'] > cutoff]\ncutoff = 3"),
            (2, "clean = clean_rows(raw)\nclean['w'] = clean['v'] * 2\nsummary = other.describe()"),
            (3, "clean = clean[clean['w'] < 50]"),
            (4, "clean.drop(columns=['v'], inplace=True)"),
        ]
        earlier = [s for step, (task, source) in enumerate(code, 1) for s in statements(source, task, step)]
        made = upstream([s for s in earlier], {"clean"})
        self.assertEqual([s.source.split("\n")[0] for s in made], [
            "raw = pd.read_csv('a.csv')",
            "def clean_rows(frame):",
            "cutoff = 3",
            "clean = clean_rows(raw)",
            "clean['w'] = clean['v'] * 2",
            "clean = clean[clean['w'] < 50]",
            "clean.drop(columns=['v'], inplace=True)",
        ])
        # A replacement ends the walk back for that name.
        made = upstream(statements("x = 1\nx = 2\ny = x", 1, 1), {"y"})
        self.assertEqual([s.source for s in made], ["x = 2", "y = x"])
        # A step that failed may not have run, so it replaces nothing.
        made = upstream(statements("x = 1", 1, 1) + statements("x = 2", 2, 1, failed=True), {"x"})
        self.assertEqual([s.source for s in made], ["x = 1", "x = 2"])

    def test_a_request_reads_earlier_variables_until_it_replaces_them(self):
        earlier = statements("clean = raw\nscores = 1\ndef f(t):\n    return t", 1, 1)
        own = statements("clean = clean[clean.v > 0]\nout = f(clean) + scores + len(clean)", 2, 1)
        self.assertEqual(earlier_reads(own, earlier), {"clean", "f", "scores"})


def snapshot(variables, functions=None):
    return {"variables": variables, "functions": functions or {}}


class ContextTest(unittest.TestCase):
    snapshots = {
        1: snapshot({"raw": {"type": "DataFrame", "shape": [40, 3], "fingerprint": "a"},
                     "clean": {"type": "DataFrame", "shape": [30, 4], "fingerprint": "b"}}, {"clean_rows": "(frame)"}),
        2: snapshot({"raw": {"type": "DataFrame", "shape": [40, 3], "fingerprint": "a"},
                     "clean": {"type": "DataFrame", "shape": [28, 4], "fingerprint": "c"},
                     "top": {"type": "list", "shape": 3, "fingerprint": "d"}}, {"clean_rows": "(frame)"}),
    }

    def test_tasks_record_what_they_created_and_changed(self):
        tasks, origin, changed = variable_tasks(self.snapshots)
        self.assertEqual(tasks[1], {"created": ["raw", "clean"], "changed": [], "functions": ["clean_rows"]})
        self.assertEqual(tasks[2], {"created": ["top"], "changed": ["clean"], "functions": []})
        self.assertEqual((origin["clean"], changed["clean"]), (1, 2))
        index = render_variable_index({1: "Load.", 2: "Filter.", 3: "Next."}, {1: '{"n": 30}', 2: "a, b"}, 3,
                                      self.snapshots)
        self.assertEqual(index, "Task 1: Load.\n  answer: {\"n\": 30}\n"
                                "  variables created: raw (DataFrame 40 × 3), clean (DataFrame 30 × 4)\n"
                                "  functions defined: clean_rows\n"
                                "Task 2: Filter.\n  answer: a, b\n  variables created: top (list, 3 items)\n"
                                "  variables changed: clean (DataFrame 28 × 4)")

    def test_the_block_shows_picked_values_and_the_code_that_made_them(self):
        made = statements("clean = raw[raw.v > 1]", 1, 2) + statements("clean = clean.head(28)", 2, 1, failed=True)
        block = render_variable_context("Use the files.", {2: "Filter."}, {1: '{"n": 30}'}, self.snapshots,
                                        ["clean", "nowhere"], {"clean": "DataFrame: 28 rows × 4 columns"}, made)
        self.assertIn("- task 1: `raw` DataFrame 40 × 3; `clean` DataFrame 28 × 4; functions `clean_rows(frame)`", block)
        self.assertIn("- task 2: `top` list, 3 items", block)
        self.assertIn("#### Task 1\nanswered: {\"n\": 30}\n- `clean` (last changed in task 2)\n"
                      "  DataFrame: 28 rows × 4 columns", block)
        self.assertIn("Not in the interpreter: `nowhere`.", block)
        self.assertIn("#### Task 1, step 2\n```python\nclean = raw[raw.v > 1]\n```", block)
        self.assertIn("#### Task 2, step 1 (this step stopped with an error)", block)


if __name__ == "__main__":
    unittest.main()
