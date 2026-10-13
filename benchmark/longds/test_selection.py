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

from benchmark.longds.selection import answer_preview, dataflow_tasks, render_index, request_text, script_tasks


def edit(changes):
    return {"action": {"type": "edit", "changes": changes}, "status": "ok", "output": {}}


def execute(rows):
    return {"action": {"type": "execute"}, "status": "ok",
            "output": {"operators": [{"id": oid, "rows": n} for oid, n in rows.items()]}}


def step(*actions):
    return {"role": "agent", "toolResults": [{"output": {"actions": list(actions)}}]}


class IndexTest(unittest.TestCase):
    def test_requests_lose_the_preamble_and_label_and_answers_keep_their_shape(self):
        self.assertEqual(request_text("You are ...\n\n[Task 1]\nLoad the data.\nQuestion: How many?"),
                         "Load the data.\nQuestion: How many?")
        self.assertEqual(answer_preview('{"leaders": [{"unit": "a", "score": 1}], "n": 8, "note": "ties"}'),
                         '{"leaders": [1 items × {unit, score}], "n": 8, "note": "ties"}')
        self.assertEqual(answer_preview("Final Answer: 60"), "Final Answer: 60")

    def test_the_dataflow_index_lists_each_tasks_tables_and_what_they_built_on(self):
        steps = {
            1: [step(edit("set orders: scan(files='orders.csv')\nset units: unit_table(orders, min_orders=5)"),
                     execute({"orders": 40, "units": 8}))],
            2: [step(edit("set top: limit(units, n=3)\nset units: unit_table(orders, min_orders=10)"),
                     execute({"top": 3}))],
        }
        recorded = dataflow_tasks(steps)
        self.assertEqual(recorded[1], {"tables": [("orders", "scan", [], 40), ("units", "unit_table", ["orders"], 8)],
                                       "built_on": []})
        # An operator set again is not a new table; reading earlier tables makes a dependency.
        self.assertEqual(recorded[2], {"tables": [("top", "limit", ["units"], 3)], "built_on": [1]})
        text = render_index("dataflow", {1: "Load.", 2: "Top three.", 3: "Next."}, {1: '{"n": 8}', 2: "u1, u2, u3"}, 3, recorded)
        self.assertEqual(text, "Task 1: Load.\n  answer: {\"n\": 8}\n  tables: orders = scan() [40 rows], "
                               "units = unit_table(orders) [8 rows]\n"
                               "Task 2: Top three.\n  answer: u1, u2, u3\n  tables: top = limit(units) [3 rows]\n  built on: task 1")

    def test_the_script_index_lists_assigned_names_and_functions_but_not_loop_variables(self):
        code = ("import pandas as pd\nunits = pd.DataFrame()\nfor row in range(3):\n    total = row\n"
                "def score(t):\n    inner = 1\n    return t\nif True:\n    top, rest = units, units\n")
        recorded = script_tasks({1: [{"type": "action", "code_action": code}]})
        self.assertEqual(recorded[1], {"names": ["units", "total", "top", "rest"], "functions": ["score"]})
        text = render_index("script", {1: "Load.", 2: "Next."}, {1: '{"n": 3}'}, 2, recorded)
        self.assertEqual(text, "Task 1: Load.\n  answer: {\"n\": 3}\n  variables assigned: units, total, top, rest\n"
                               "  functions defined: score")
        self.assertEqual(render_index("texts", {1: "Load.", 2: "Next."}, {}, 2), "Task 1: Load.")


if __name__ == "__main__":
    unittest.main()
