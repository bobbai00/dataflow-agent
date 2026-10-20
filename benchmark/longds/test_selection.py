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

    def test_gold_tables_are_the_results_of_the_annotated_dependencies(self):
        from benchmark.longds.run_session import gold_tables
        history = {
            1: [step(edit("set orders: scan(files='orders.csv')\nset units: unit_table(orders, min_orders=5)"))],
            2: [step(edit("set big: filter(units, lambda r: r.n > 3)\nset top: limit(big, n=3)\nset share: ratio(big, units)"))],
            3: [step(edit("set late: filter(orders, lambda r: r.late)"))],
        }
        gold = {"turns": [{"turn_id": 4, "depends_tasks": [2, 4]}, {"turn_id": 5, "depends_tasks": []}]}
        # Task 2's results only (big is read by top and share); task 1 comes in as their upstream.
        self.assertEqual(gold_tables(gold, 4, history)[0], ["top", "share"])
        self.assertEqual(gold_tables(gold, 5, history)[0], [])
        from benchmark.longds.run_session import gold_dependencies
        # Only earlier tasks, in order.
        self.assertEqual(gold_dependencies({"turns": [{"turn_id": 9, "depends_tasks": [7, 9, 12, 1]}]}, 9), [1, 7])

    def test_the_script_index_lists_assigned_names_and_functions_but_not_loop_variables(self):
        code = ("import pandas as pd\nunits = pd.DataFrame()\nfor row in range(3):\n    total = row\n"
                "def score(t):\n    inner = 1\n    return t\nif True:\n    top, rest = units, units\n")
        recorded = script_tasks({1: [{"type": "action", "code_action": code}]})
        self.assertEqual(recorded[1], {"names": ["units", "total", "top", "rest"], "functions": ["score"]})
        text = render_index("script", {1: "Load.", 2: "Next."}, {1: '{"n": 3}'}, 2, recorded)
        self.assertEqual(text, "Task 1: Load.\n  answer: {\"n\": 3}\n  variables assigned: units, total, top, rest\n"
                               "  functions defined: score")
        self.assertEqual(render_index("texts", {1: "Load.", 2: "Next."}, {}, 2), "Task 1: Load.")


class AskTest(unittest.TestCase):
    def test_a_rate_limited_call_is_retried_after_a_wait(self):
        import httpx
        import openai
        from types import SimpleNamespace
        from benchmark.longds.selection import select_tables

        limited = openai.RateLimitError("No deployments available", body=None,
                                        response=httpx.Response(429, request=httpx.Request("POST", "http://gateway")))
        reply = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"tables": ["units"]}'))],
                                usage=SimpleNamespace(prompt_tokens=10, completion_tokens=2, prompt_tokens_details=None,
                                                      completion_tokens_details=None))
        outcomes = [limited, limited, reply]

        def create(**_):
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        waits = []
        import benchmark.longds.selection as selection
        original = selection._ask
        selection._ask = lambda c, m, p: original(c, m, p, sleep=waits.append)
        try:
            tables, usage, _ = select_tables(client, "luna", "Task 1: x", "y")
        finally:
            selection._ask = original
        self.assertEqual((tables, usage["input_tokens"], waits), (["units"], 10, [5, 10]))


if __name__ == "__main__":
    unittest.main()
