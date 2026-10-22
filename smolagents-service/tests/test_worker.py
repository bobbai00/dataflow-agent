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
import unittest
from pathlib import Path

from smolagents_service.executor import WorkerExecutor, resolve_sandbox
from smolagents_service.sessions import AUTHORIZED_IMPORTS


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.folder.name).resolve() / "data"
        self.secret = Path(self.folder.name).resolve() / ".env"
        self.secret.write_text("LITELLM_MASTER_KEY=sk-not-for-model-code\n")
        for user in ("1", "2"):
            files = self.data_dir / "users" / user / "files"
            files.mkdir(parents=True)
            (files / "numbers.csv").write_text(f"x\n{user}\n{user}\n")
        (self.data_dir / "traces.db").write_text("not for model code")
        self.reports = []
        self.workers = []

    def tearDown(self):
        for worker in self.workers:
            worker.cleanup()
        self.folder.cleanup()

    def worker(self, user: str = "1", timeout: float = 60, sandbox: str = "auto") -> WorkerExecutor:
        worker = WorkerExecutor(user_dir=self.data_dir / "users" / user, data_dir=self.data_dir,
                                authorized_imports=AUTHORIZED_IMPORTS, timeout=timeout, sandbox=sandbox,
                                secret_files=[self.secret], on_exec=lambda **report: self.reports.append(report))
        self.workers.append(worker)
        return worker

    def test_state_logs_figures_and_final_answer(self):
        worker = self.worker()
        first = worker("import pandas as pd\ndf = pd.read_csv('numbers.csv')\nprint(len(df))")
        self.assertEqual(first.logs.strip(), "2")
        self.assertFalse(first.is_final_answer)
        drawn = worker("import matplotlib.pyplot as plt\nplt.plot(df['x'])\nplt.figure()\nplt.bar([1], [2])")
        self.assertFalse(drawn.is_final_answer)
        self.assertEqual(len(self.reports[-1]["figures"]), 2)
        self.assertGreater(self.reports[-1]["figures"][0].size[0], 100)
        final = worker("final_answer({'total': int(df['x'].sum())})")
        self.assertTrue(final.is_final_answer)
        self.assertEqual(final.output, {"total": 2})
        for report in self.reports:
            self.assertLessEqual(report["started"], report["ended"])
            self.assertLessEqual(report["reply"]["seconds"], report["ended"] - report["started"])

    def test_errors_keep_logs_and_the_session(self):
        worker = self.worker()
        worker("kept = 41")
        with self.assertRaisesRegex(RuntimeError, "ZeroDivisionError|division by zero"):
            worker("print('before')\n1 / 0")
        self.assertIn("before", worker.state["_print_outputs"])
        self.assertIn("error", self.reports[-1]["reply"])
        with self.assertRaisesRegex(RuntimeError, "not allowed"):
            worker("import os")
        self.assertEqual(worker("final_answer(kept + 1)").output, 42)

    def test_a_runaway_execution_is_stopped(self):
        worker = self.worker(timeout=3)
        worker("kept = 1")
        with self.assertRaisesRegex(RuntimeError, "more than 3 s"):
            worker("import time\ntime.sleep(30)")
        # The interpreter restarted: it works, without the old variables.
        with self.assertRaisesRegex(RuntimeError, "kept"):
            worker("print(kept)")
        self.assertEqual(worker("final_answer(2)").output, 2)

    def test_users_own_code_runs_as_plain_python_beside_the_agent(self):
        worker = self.worker()
        worker("shared = 40")  # the agent's variable
        reply, figures = worker.run_python(
            "import os\nimport matplotlib.pyplot as plt\n"
            "class Box:\n    def __init__(self, value):\n        self.value = value\n"
            "box = Box(shared + 2)\n"
            "print('files here:', sorted(name for name in os.listdir('.') if name.endswith('.csv')))\n"
            "plt.plot([1, 2])\nplt.show()\nbox.value * 10", "mine.py")
        self.assertNotIn("error", reply)
        self.assertEqual(reply["output"].strip(), "files here: ['numbers.csv']")  # runs in the user's files folder
        self.assertEqual(reply["value"], "420")
        self.assertEqual(reply["variables"], {"Box": "type", "box": "Box"})  # modules are not listed
        self.assertEqual(len(figures), 1)
        self.assertEqual(worker("final_answer(box.value)").output, 42)  # the agent sees the script's variables
        with self.assertRaisesRegex(RuntimeError, "Forbidden access to module: os"):
            worker("os.listdir('.')")  # ...but not the modules the agent itself may not import

    def test_users_own_code_failing(self):
        worker = self.worker()
        reply, _ = worker.run_python("kept = 1\nraise ValueError('bad input')", "broken.py")
        self.assertIn('File "broken.py", line 2', reply["error"])
        self.assertIn("raise ValueError('bad input')", reply["error"])  # with its source line
        self.assertNotIn("worker.py", reply["error"])  # and none of the worker's own frames
        self.assertEqual(worker("final_answer(kept)").output, 1)  # what ran before the error is kept
        reply, _ = worker.run_python("answer = input('name? ')", "asks.py")
        self.assertIn("EOFError", reply["error"])  # stdin is not the server's pipe
        reply, _ = worker.run_python("import sys\nsys.exit(3)", "exits.py")
        self.assertIn("SystemExit", reply["error"])
        self.assertEqual(worker("final_answer('still here')").output, "still here")

    def test_users_own_code_is_restricted_without_a_sandbox(self):
        worker = self.worker(sandbox="none")
        reply, _ = worker.run_python("import os\nos.listdir('/')", "mine.py")
        self.assertIn("Import of os is not allowed", reply["error"])
        reply, _ = worker.run_python("total = 2 + 3\nprint('total', total)\ntotal", "fine.py")
        self.assertEqual((reply["output"].strip(), reply["value"], reply["variables"]),
                         ("total 5", "5", {"total": "int"}))
        self.assertEqual(worker("final_answer(total)").output, 5)

    @unittest.skipUnless(resolve_sandbox("auto") == "seatbelt", "needs the macOS seatbelt sandbox")
    def test_sandbox_keeps_users_apart(self):
        worker = self.worker("1")
        mine = worker("import pandas as pd\nfinal_answer(int(pd.read_csv("
                      f"{str(self.data_dir / 'users/1/files/numbers.csv')!r})['x'].sum()))")
        self.assertEqual(mine.output, 2)
        for path in (self.data_dir / "users/2/files/numbers.csv", self.secret, self.data_dir / "traces.db"):
            with self.subTest(path=path.name), self.assertRaisesRegex(RuntimeError, "not permitted|Permission"):
                worker(f"import pandas as pd\npd.read_csv({str(path)!r})")
        with self.assertRaisesRegex(RuntimeError, "URLError|nodename|not permitted|Errno"):
            worker("import pandas as pd\npd.read_csv('https://example.com/data.csv')")
        # The user's own code is plain Python, so the sandbox is what stops it.
        peek, _ = worker.run_python(f"open({str(self.data_dir / 'users/2/files/numbers.csv')!r}).read()", "peek.py")
        self.assertIn("Operation not permitted", peek["error"])
        worker("import pandas as pd\npd.DataFrame({'a': [1]}).to_csv('mine.csv')")  # its own folder is writable
        self.assertTrue((self.data_dir / "users/1/files/mine.csv").exists())

    def test_without_sandbox_still_separate_processes(self):
        one, two = self.worker("1", sandbox="none"), self.worker("2", sandbox="none")
        one("secret = 'one'")
        with self.assertRaisesRegex(RuntimeError, "secret"):
            two("print(secret)")
        self.assertNotEqual(one.process.pid, two.process.pid)


if __name__ == "__main__":
    unittest.main()
