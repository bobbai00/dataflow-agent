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

import tempfile
import threading
import time
import unittest
from pathlib import Path

from smolagents_service.store import AuthError, Store


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.folder.name) / "traces.db")

    def tearDown(self):
        self.store.close()
        self.folder.cleanup()

    def test_accounts(self):
        user_id = self.store.create_user("alice", "correct horse")
        self.assertEqual(self.store.authenticate("alice", "correct horse"), {"id": user_id, "username": "alice"})
        self.assertIsNone(self.store.authenticate("alice", "wrong password"))
        self.assertIsNone(self.store.authenticate("nobody", "correct horse"))
        with self.assertRaisesRegex(AuthError, "taken"):
            self.store.create_user("ALICE", "another password")  # usernames are case-insensitive
        with self.assertRaisesRegex(AuthError, "username"):
            self.store.create_user("a b", "long enough")
        with self.assertRaisesRegex(AuthError, "password"):
            self.store.create_user("bob", "short")
        stored = self.store._rows("SELECT password_hash FROM users WHERE id = ?", (user_id,))[0]["password_hash"]
        self.assertNotIn("correct horse", stored)

    def test_logins(self):
        user_id = self.store.create_user("alice", "correct horse")
        token = self.store.create_login(user_id, days=1)
        self.assertEqual(self.store.user_for_token(token)["username"], "alice")
        self.assertIsNone(self.store.user_for_token(token + "x"))
        self.store.delete_login(token)
        self.assertIsNone(self.store.user_for_token(token))
        expired = self.store.create_login(user_id, days=-1)
        self.assertIsNone(self.store.user_for_token(expired))
        stored = self.store._rows("SELECT token_hash FROM logins")
        self.assertTrue(all(row["token_hash"] not in (token, expired) for row in stored))

    def _run(self, user_id: int, started: float) -> str:
        session = self.store.start_chat_session(user_id, "scripted")
        run_id = self.store.start_run(user_id, session, 1, "how many rows?")
        self.store.record_llm_call(run_id=run_id, user_id=user_id, step_number=1, model_id="m", started_at=started,
                                   first_token_at=started + 0.2, ended_at=started + 1.0, input_tokens=100,
                                   output_tokens=20, input_messages='[{"role": "user", "content": "hi"}]',
                                   output_text="code")
        self.store.record_python_exec(run_id=run_id, user_id=user_id, step_number=1, started_at=started + 1.1,
                                      ended_at=started + 1.6, worker_seconds=0.4, code="print(1)", logs="1",
                                      output="None", figures=0)
        self.store.record_step(run_id=run_id, user_id=user_id, step_number=1, started_at=started,
                               ended_at=started + 2.0, input_tokens=100, output_tokens=20, code="print(1)")
        self.store.finish_run(run_id, "ok", "42", None)
        return run_id

    def test_reads_are_scoped_to_the_owner(self):
        alice = self.store.create_user("alice", "correct horse")
        bob = self.store.create_user("bob", "battery staple")
        run_id = self._run(alice, time.time())

        [summary] = self.store.list_runs(alice)
        self.assertEqual((summary["steps"], summary["llm_calls"], summary["input_tokens"]), (1, 1, 100))
        self.assertAlmostEqual(summary["llm_seconds"], 1.0, places=3)
        self.assertAlmostEqual(summary["python_seconds"], 0.5, places=3)
        run = self.store.get_run(alice, run_id)
        [step] = run["steps"]
        self.assertAlmostEqual(step["seconds"] - step["llm_seconds"] - step["python_seconds"], 0.5, places=3)
        self.assertNotIn("input_messages", run["llm_calls"][0])
        self.assertIn("input_messages", self.store.get_run(alice, run_id, context=True)["llm_calls"][0])
        self.assertEqual(self.store.step_context(alice, run_id, 1), [{"role": "user", "content": "hi"}])

        self.assertEqual(self.store.list_runs(bob), [])
        self.assertIsNone(self.store.get_run(bob, run_id))
        self.assertIsNone(self.store.step_context(bob, run_id, 1))
        self.assertIsNone(self.store.delete_run(bob, run_id))
        self.assertIsNotNone(self.store.get_run(alice, run_id))

        self.assertEqual(self.store.delete_run(alice, run_id), [])
        self.assertIsNone(self.store.get_run(alice, run_id))
        for table in ("steps", "llm_calls", "python_execs"):
            self.assertEqual(self.store._rows(f"SELECT COUNT(*) AS n FROM {table}")[0]["n"], 0)

    def test_runs_from_before_chats_become_one_chat_per_user(self):
        alice = self.store.create_user("alice", "correct horse")
        bob = self.store.create_user("bob", "battery staple")
        for user, task, kind in ((alice, "Imported totals.ipynb", "notebook"), (bob, "how many rows?", "agent"),
                                 (alice, "and the mean?", "agent")):
            self.store.start_run(user, self.store.start_chat_session(user, "m"), 1, task, kind)  # no chat yet
        self.store.close()
        self.store = Store(Path(self.folder.name) / "traces.db")  # the next start adopts them
        [alices], [bobs] = self.store.list_chats(alice), self.store.list_chats(bob)
        self.assertEqual((alices["title"], alices["runs"]), ("📓 totals.ipynb", 2))
        self.assertEqual((bobs["title"], bobs["runs"]), ("how many rows?", 1))
        self.assertIsNone(self.store.get_chat(bob, alices["id"]))  # chats are scoped to their owner too
        self.assertEqual({r["chat_title"] for r in self.store.list_runs(alice)}, {"📓 totals.ipynb"})

    def test_concurrent_writers(self):
        users = [self.store.create_user(f"user{i}", "long enough") for i in range(10)]
        threads = [threading.Thread(target=lambda u=u: [self._run(u, time.time()) for _ in range(20)]) for u in users]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        for user in users:
            self.assertEqual(len(self.store.list_runs(user)), 20)


if __name__ == "__main__":
    unittest.main()
