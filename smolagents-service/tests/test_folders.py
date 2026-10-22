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

from smolagents_service.config import Config
from smolagents_service.sessions import adopt_old_folders, user_files
from smolagents_service.store import Store


class OldFoldersTest(unittest.TestCase):
    def test_old_uploads_and_workspace_move_into_files(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Config(data_dir=Path(folder))
            store = Store(config.data_dir / "traces.db")
            one, two = (config.user_dir(store.create_user(name, "long enough")) for name in ("one", "two"))
            (one / "uploads").mkdir(parents=True)
            (one / "uploads" / "ratings.csv").write_text("x\n1\n")
            (one / "workspace" / "tmp").mkdir(parents=True)
            (one / "workspace" / "worker.log").write_text("log")
            (one / "workspace" / "summary.csv").write_text("written by the agent")
            store.record_artifact(1, "upload", str(one / "uploads" / "ratings.csv"))
            (two / "uploads").mkdir(parents=True)
            (two / "files").mkdir()
            (two / "uploads" / "same.csv").write_text("old")
            (two / "files" / "same.csv").write_text("new")

            adopt_old_folders(config, store)
            adopt_old_folders(config, store)  # a second start finds nothing to do

            self.assertEqual([Path(p).name for p in user_files(config, 1)], ["ratings.csv", "summary.csv"])
            self.assertFalse((one / "uploads").exists() or (one / "workspace").exists())
            self.assertEqual(store._rows("SELECT path FROM artifacts")[0]["path"], str(one / "files" / "ratings.csv"))
            self.assertEqual((two / "files" / "same.csv").read_text(), "new")  # never overwritten
            self.assertEqual((two / "uploads" / "same.csv").read_text(), "old")  # and the namesake is kept
            store.close()


if __name__ == "__main__":
    unittest.main()
