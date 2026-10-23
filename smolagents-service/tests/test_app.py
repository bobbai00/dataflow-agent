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

"""The server over HTTP: accounts, the login wall, per-user isolation, and many users at once.

The chat is driven through gradio's own client, as a browser drives it, with the
scripted model standing in for the LLM so the test needs no gateway.
"""

import json
import os
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from gradio_client import Client, handle_file

from smolagents_service.app import COOKIE, create_app
from smolagents_service.config import Config

from tests.helpers import ScriptedModel, ServerThread

USERS = 12
LATENCY = 1.0  # seconds per scripted model call; a run makes two


def register(base: str, username: str, password: str = "long enough") -> httpx.Response:
    return httpx.post(f"{base}/register", data={"username": username, "password": password}, follow_redirects=False)


class AppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["GRADIO_IS_E2E_TEST"] = "1"  # Gradio's heartbeat every 0.25 s instead of 15 s
        cls.folder = tempfile.TemporaryDirectory()
        cls.config = Config(data_dir=Path(cls.folder.name) / "data", concurrency=16, disconnect_grace_seconds=2,
                            notebook_instructions="Answer what is asked; change the work only when told to.",
                            model_factory=lambda: ScriptedModel(latency=LATENCY))
        cls.app = create_app(cls.config)
        cls.server = ServerThread(cls.app).__enter__()
        cls.base = cls.server.url

    @classmethod
    def tearDownClass(cls):
        cls.app.state.sessions.close_all("tests done")
        cls.server.__exit__()
        cls.folder.cleanup()
        os.environ.pop("GRADIO_IS_E2E_TEST", None)

    def test_accounts_and_the_login_wall(self):
        wall = httpx.get(f"{self.base}/app/", follow_redirects=False)
        self.assertEqual((wall.status_code, wall.headers["location"]), (303, "/login"))
        self.assertEqual(httpx.get(f"{self.base}/api/runs").status_code, 401)
        with self.assertRaises(Exception):
            Client(f"{self.base}/app/", verbose=False)  # gradio itself refuses an anonymous client

        created = register(self.base, "walter")
        self.assertEqual((created.status_code, created.headers["location"]), (303, "/app/"))
        cookie = created.cookies[COOKIE]
        self.assertIn("HttpOnly", created.headers["set-cookie"])
        self.assertEqual(register(self.base, "walter").status_code, 400)
        self.assertIn("taken", register(self.base, "WALTER").text)
        wrong = httpx.post(f"{self.base}/login", data={"username": "walter", "password": "nope nope"})
        self.assertEqual(wrong.status_code, 400)

        signed_in = httpx.post(f"{self.base}/login", data={"username": "walter", "password": "long enough"},
                               follow_redirects=False)
        second_cookie = signed_in.cookies[COOKIE]
        self.assertNotEqual(second_cookie, cookie)
        self.assertEqual(httpx.get(f"{self.base}/api/me", cookies={COOKIE: cookie}).json()["username"], "walter")
        self.assertEqual(httpx.get(f"{self.base}/app/", cookies={COOKIE: cookie}).status_code, 200)

        httpx.get(f"{self.base}/logout", cookies={COOKIE: cookie})
        self.assertEqual(httpx.get(f"{self.base}/api/me", cookies={COOKIE: cookie}).status_code, 401)
        self.assertEqual(httpx.get(f"{self.base}/api/me", cookies={COOKIE: second_cookie}).status_code, 200)
        kinds = [e["kind"] for e in httpx.get(f"{self.base}/api/events", cookies={COOKIE: second_cookie}).json()]
        self.assertEqual(sorted(set(kinds)), ["login", "logout", "register"])

    def test_running_your_own_code(self):
        cookie = register(self.base, f"coder{int(time.time())}").cookies[COOKIE]
        client = Client(f"{self.base}/app/", headers={"Cookie": f"{COOKIE}={cookie}"}, verbose=False)
        chat = client.predict("rows = [3, 4]\nprint('sum', sum(rows))\nlen(rows)", [], api_name="/run_code")
        shown = str(chat)
        self.assertIn("Ran `your code`", shown)
        self.assertIn("sum 7", shown)
        self.assertIn("→ `2`", shown)
        self.assertIn("now defined: rows (list, length 2)", shown)
        [run] = httpx.get(f"{self.base}/api/runs", cookies={COOKIE: cookie}).json()
        self.assertEqual((run["kind"], run["status"], run["steps"], run["llm_calls"]), ("script", "ok", 0, 0))
        client.close()

    def test_importing_a_notebook(self):
        """A notebook's cells run in the session and become the agent's own steps."""
        cookie = register(self.base, f"importer{int(time.time())}").cookies[COOKIE]
        client = Client(f"{self.base}/app/", headers={"Cookie": f"{COOKIE}={cookie}"}, verbose=False)
        folder = Path(self.folder.name)
        csv = folder / "rows.csv"
        csv.write_text("x\n1\n2\n3\n")
        notebook = folder / "totals.ipynb"
        notebook.write_text(json.dumps({"cells": [
            {"cell_type": "markdown", "source": ["# Totals\n", "\n", "How many rows are there?"]},
            {"cell_type": "code", "source": ["import pandas as pd\n", "df = pd.read_csv('rows.csv')\n",
                                             "print('rows', len(df))\n", "df.head()"]},
            {"cell_type": "markdown", "source": ["## Check"]},
            {"cell_type": "code", "source": ["total = int(df['x'].sum())\n", "total"]},
            {"cell_type": "markdown", "source": ["## Answer\n", "\n", "There are 3 rows; x sums to 6."]},
        ]}))
        client.predict(handle_file(str(csv)), [], api_name="/upload")
        *_, chat = client.predict(handle_file(str(notebook)), [], api_name="/upload")
        shown = str(chat)
        for text in ("📓 `totals.ipynb`", "How many rows are there?", "rows 3", "→ 6", "step 2",
                     "There are 3 rows; x sums to 6.", "imported 2 cells"):
            self.assertIn(text, shown)
        # The cells' variables are in the session, for the user's code and the agent's.
        self.assertIn("12", str(client.predict("print(total * 2)", [], api_name="/run_code")))
        session = self.app.state.sessions._sessions[client.session_hash]
        kinds = [type(step).__name__ for step in session.agent.memory.steps]
        self.assertEqual(kinds, ["TaskStep", "ActionStep", "ActionStep", "ActionStep", "NoteStep", "UserCodeStep"])
        self.assertTrue(session.agent.memory.steps[3].is_final_answer)
        self.assertIn("Answer what is asked", session.agent.memory.steps[4].text)
        runs = httpx.get(f"{self.base}/api/runs", cookies={COOKIE: cookie}).json()
        self.assertEqual([(r["status"], r["steps"]) for r in runs if r["kind"] == "notebook"], [("ok", 3)])
        # The agent goes on from there, reading the imported steps as its own.
        client.predict("Sum x in my file.", api_name="/lock_inputs")
        chat = client.predict([], api_name="/chat")
        texts = [part["text"] for message in chat for part in message["content"]
                 if isinstance(part, dict) and part.get("type") == "text"]
        self.assertEqual(texts[-2], "6")
        client.close()

    def test_a_notebook_import_stops_where_it_cannot_go_on(self):
        """A notebook whose data is missing is not imported; one with a failing cell stops at that cell."""
        cookie = register(self.base, f"stopper{int(time.time())}").cookies[COOKIE]
        client = Client(f"{self.base}/app/", headers={"Cookie": f"{COOKIE}={cookie}"}, verbose=False)
        folder = Path(tempfile.mkdtemp(dir=self.folder.name))
        unread = folder / "prices.ipynb"
        unread.write_text(json.dumps({"cells": [
            {"cell_type": "code", "source": ["import pandas as pd\n", "listings = pd.read_csv('listings.csv')"]},
            {"cell_type": "code", "source": ["len(listings)"]},
        ]}))
        status, *_, chat = client.predict(handle_file(str(unread)), [], api_name="/upload")
        self.assertIn("did not import it: it reads `listings.csv`, which is not in your files", status)
        self.assertEqual(chat, [])
        self.assertNotIn(client.session_hash, self.app.state.sessions._sessions)  # nothing ran

        broken = folder / "broken.ipynb"
        broken.write_text(json.dumps({"cells": [
            {"cell_type": "markdown", "source": ["What is the total?"]},
            {"cell_type": "code", "source": ["%matplotlib inline\n", "rows = [1, 2]"]},
            {"cell_type": "code", "source": ["total = sum(rows) / 0"]},
            {"cell_type": "code", "source": ["print(total)"]},
            {"cell_type": "markdown", "source": ["The total is 3."]},
        ]}))
        status, *_, chat = client.predict(handle_file(str(broken)), [], api_name="/upload")
        self.assertIn("Cell 2 of `broken.ipynb` failed, so the import stopped there", status)
        shown = str(chat)
        for text in ("the 1 cell after it did not run", "ZeroDivisionError: division by zero", "ran 2 of 3 cells"):
            self.assertIn(text, shown)
        for text in ("NameError", "The total is 3."):  # neither the next cell nor the answer
            self.assertNotIn(text, shown)
        session = self.app.state.sessions._sessions[client.session_hash]
        memory = session.agent.memory.steps
        self.assertEqual([type(step).__name__ for step in memory], ["TaskStep", "ActionStep", "ActionStep", "NoteStep"])
        self.assertIn("The import stopped at cell 2 of 3", memory[-1].text)
        self.assertIn("→ `[1, 2]`", str(client.predict("rows", [], api_name="/run_code")))  # cell 1 ran
        runs = httpx.get(f"{self.base}/api/runs", cookies={COOKIE: cookie}).json()
        self.assertEqual([(r["status"], r["steps"]) for r in runs if r["kind"] == "notebook"], [("error", 2)])
        client.close()

    def test_a_closed_tab_ends_its_session(self):
        cookie = register(self.base, f"closer{int(time.time())}").cookies[COOKIE]
        # Like a browser tab, the client holds a heartbeat stream for its session.
        client = Client(f"{self.base}/app/", headers={"Cookie": f"{COOKIE}={cookie}"}, verbose=False)
        client.predict("Say done.", api_name="/lock_inputs")
        client.predict([], api_name="/chat")
        sessions = self.app.state.sessions
        worker = sessions._sessions[client.session_hash].executor.process
        self.assertIsNone(worker.poll())

        client.close()  # the tab closes
        with httpx.stream("GET", f"{self.base}/app/gradio_api/heartbeat/{client.session_hash}",
                          cookies={COOKIE: cookie}, timeout=10) as stream:
            # ...and its heartbeat comes back within the grace period: the session stays.
            lines = stream.iter_lines()  # kept: a discarded line iterator closes the response
            next(lines)
            time.sleep(2 * self.config.disconnect_grace_seconds)
            self.assertIn(client.session_hash, sessions._sessions)
        # Gone for good: once the grace period passes, the session and its worker end.
        deadline = time.monotonic() + 10 * self.config.disconnect_grace_seconds
        while client.session_hash in sessions._sessions and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertNotIn(client.session_hash, sessions._sessions)
        self.assertIsNotNone(worker.wait(timeout=10), "the session's worker process ended")

    def test_many_users_at_once(self):
        """Each user uploads their own numbers and asks for the sum, all at the same time."""
        stamp = int(time.time())
        cookies, folder = {}, Path(self.folder.name)
        for i in range(USERS):
            cookies[i] = register(self.base, f"user{stamp}_{i}").cookies[COOKIE]

        def one_user(i: int) -> dict:
            client = Client(f"{self.base}/app/", headers={"Cookie": f"{COOKIE}={cookies[i]}"}, verbose=False)
            csv = folder / f"numbers{i}.csv"
            csv.write_text("x\n" + "\n".join(str(i * 100 + k) for k in range(5)) + "\n")
            client.predict(handle_file(str(csv)), [], api_name="/upload")
            started = time.monotonic()
            # The browser's chain: the prompt goes into session state, then the chat runs on it.
            client.predict("Sum x in my file.", api_name="/lock_inputs")
            chat = client.predict([], api_name="/chat")
            return {"seconds": time.monotonic() - started, "chat": chat}

        started = time.monotonic()
        with ThreadPoolExecutor(USERS) as pool:
            results = list(pool.map(one_user, range(USERS)))
        wall = time.monotonic() - started

        for i, result in enumerate(results):
            expected = str(sum(i * 100 + k for k in range(5)))
            texts = [part["text"] for message in result["chat"] for part in message["content"]
                     if isinstance(part, dict) and part.get("type") == "text"]
            self.assertEqual(texts[-2], expected, f"user {i} got someone else's answer")  # the answer, then totals
            self.assertIn("✓ 2 steps", texts[-1])
        one_run = min(r["seconds"] for r in results)
        self.assertGreaterEqual(one_run, 2 * LATENCY)
        # Run one after another, twelve runs would take twelve times as long.
        self.assertLess(wall, 0.3 * USERS * one_run, f"{USERS} users took {wall:.1f} s; one run takes {one_run:.1f} s")

        runs = {}
        for i in range(USERS):
            listed = httpx.get(f"{self.base}/api/runs", cookies={COOKIE: cookies[i]}).json()
            self.assertEqual(len(listed), 1, f"user {i} sees {len(listed)} runs")
            runs[i] = listed[0]
            self.assertEqual((runs[i]["status"], runs[i]["steps"], runs[i]["llm_calls"]), ("ok", 2, 2))
        # Every run overlapped with every other: the latest start precedes the earliest end.
        self.assertLess(max(r["started_at"] for r in runs.values()), min(r["ended_at"] for r in runs.values()))
        for i in range(USERS):
            other = runs[(i + 1) % USERS]["id"]
            mine = {COOKIE: cookies[i]}
            self.assertEqual(httpx.get(f"{self.base}/api/runs/{other}", cookies=mine).status_code, 404)
            self.assertEqual(httpx.delete(f"{self.base}/api/runs/{other}", cookies=mine).status_code, 404)
            detail = httpx.get(f"{self.base}/api/runs/{runs[i]['id']}?context=true", cookies=mine).json()
            self.assertEqual(len(detail["artifacts"]), 1)
            self.assertIn("input_messages", detail["llm_calls"][0])
        print(f"\n{USERS} users at once: {wall:.1f} s wall, one run {one_run:.1f} s")


if __name__ == "__main__":
    unittest.main()
