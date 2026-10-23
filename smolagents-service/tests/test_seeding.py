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

"""Seeding a new account with a notebook, and a new session continuing from the trace."""

import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx
from gradio_client import Client

from smolagents_service.app import COOKIE, create_app
from smolagents_service.config import Config
from smolagents_service.seeding import load_seed
from tests.helpers import ScriptedModel, ServerThread

NOTEBOOK = {"cells": [
    {"cell_type": "markdown", "source": ["# Totals\n", "\n", "How many rows are there?"]},
    {"cell_type": "code", "source": ["import pandas as pd\n", "df = pd.read_csv('rows.csv')\n",
                                     "print('rows', len(df))\n", "df.head()"]},
    {"cell_type": "markdown", "source": ["## Check"]},
    {"cell_type": "code", "source": ["total = int(df['x'].sum())\n", "total"]},
    {"cell_type": "markdown", "source": ["## Answer\n", "\n", "There are 3 rows; x sums to 6."]},
]}


def register(base: str, username: str, password: str = "long enough") -> httpx.Response:
    return httpx.post(f"{base}/register", data={"username": username, "password": password}, follow_redirects=False)


def wait_for_seed(base: str, cookie: str, seconds: float = 60.0) -> dict:
    deadline = time.monotonic() + seconds
    while True:
        status = httpx.get(f"{base}/api/seed", cookies={COOKIE: cookie}).json()
        if status["status"] in ("done", "failed") or time.monotonic() > deadline:
            return status
        time.sleep(0.2)


class SeedingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        folder = Path(cls.folder.name)
        (folder / "rows.csv").write_text("x\n1\n2\n3\n")
        (folder / "totals.ipynb").write_text(json.dumps(NOTEBOOK))
        (folder / "seed.json").write_text(json.dumps({
            "name": "totals", "bobflow": {"ignored": True},
            "smolagents": {"notebook": "totals.ipynb", "files": ["rows.csv"]}}))
        cls.config = Config(data_dir=folder / "data", concurrency=16, disconnect_grace_seconds=2,
                            notebook_instructions="Answer what is asked; change the work only when told to.",
                            seed=load_seed(folder / "seed.json"), model_factory=lambda: ScriptedModel())
        cls.app = create_app(cls.config)
        cls.server = ServerThread(cls.app).__enter__()
        cls.base = cls.server.url

    @classmethod
    def tearDownClass(cls):
        cls.app.state.sessions.close_all("tests done")
        cls.server.__exit__()
        cls.folder.cleanup()

    def test_the_seed_definition_resolves_its_files_beside_it(self):
        seed = self.config.seed
        self.assertEqual(seed.name, "totals")
        self.assertEqual(seed.notebook.name, "totals.ipynb")
        self.assertEqual([f.name for f in seed.files], ["rows.csv"])
        self.assertIsNone(load_seed(None))

    def test_a_new_account_gets_the_notebook_and_every_session_continues_from_it(self):
        """Registering imports the seed into a chat of the account's trace; the page opens on it, and the session
        restores it, with the notebook's variables back in its interpreter; so does the next tab, with the user's
        own run too."""
        cookie = register(self.base, f"seeded{int(time.time())}").cookies[COOKIE]
        status = wait_for_seed(self.base, cookie)
        self.assertEqual(status["status"], "done", status)
        runs = httpx.get(f"{self.base}/api/runs", cookies={COOKIE: cookie}).json()
        self.assertEqual([(r["kind"], r["status"], r["steps"]) for r in runs], [("notebook", "ok", 3)])
        files = sorted(p.name for p in (self.config.data_dir / "users").glob("*/files/*"))
        self.assertIn("rows.csv", files)
        self.assertIn("totals.ipynb", files)
        # Asking again changes nothing: the seed is given once.
        self.assertEqual(httpx.post(f"{self.base}/api/seed", cookies={COOKIE: cookie}).json()["status"], "done")

        first = Client(f"{self.base}/app/", headers={"Cookie": f"{COOKIE}={cookie}"}, verbose=False)
        *_, chat, picker = first.predict(api_name="/on_load")  # what a browser does: open the latest chat
        [seeded] = httpx.get(f"{self.base}/api/chats", cookies={COOKIE: cookie}).json()
        self.assertEqual((seeded["title"], picker["value"]), ("📓 totals.ipynb", seeded["id"]))
        self.assertIn("from your trace", str(chat))
        # The notebook's variables are in the new session's interpreter, replayed from the trace.
        self.assertIn("12", str(first.predict("print(total * 2)", [], api_name="/run_code")))
        session = self.app.state.sessions._sessions[first.session_hash]
        kinds = [type(step).__name__ for step in session.agent.memory.steps]
        self.assertEqual(kinds, ["TaskStep", "ActionStep", "ActionStep", "ActionStep", "NoteStep", "UserCodeStep"])
        self.assertTrue(session.agent.memory.steps[3].is_final_answer)
        self.assertIn("Answer what is asked", session.agent.memory.steps[4].text)
        self.assertEqual(session.restored["runs"], 1)
        first.close()

        # A second tab (another session) continues from everything so far, the user's own run included.
        second = Client(f"{self.base}/app/", headers={"Cookie": f"{COOKIE}={cookie}"}, verbose=False)
        second.predict(api_name="/on_load")
        self.assertIn("6", str(second.predict("print(total)", [], api_name="/run_code")))
        session = self.app.state.sessions._sessions[second.session_hash]
        kinds = [type(step).__name__ for step in session.agent.memory.steps]
        self.assertEqual(kinds[:6], ["TaskStep", "ActionStep", "ActionStep", "ActionStep", "NoteStep", "UserCodeStep"])
        self.assertEqual(kinds[-1], "UserCodeStep")
        self.assertEqual(session.restored["runs"], 2)
        second.close()
        # Only the seed's import and the user's two runs were traced: restoring traced nothing new.
        runs = httpx.get(f"{self.base}/api/runs", cookies={COOKIE: cookie}).json()
        self.assertEqual(sorted(r["kind"] for r in runs), ["notebook", "script", "script"])
        events = httpx.get(f"{self.base}/api/events", cookies={COOKIE: cookie}).json()
        self.assertEqual(sum(1 for e in events if e["kind"] == "restore"), 2)


if __name__ == "__main__":
    unittest.main()
