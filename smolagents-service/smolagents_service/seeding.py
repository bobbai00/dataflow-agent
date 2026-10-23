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

"""Seeding: what every account starts with, without importing anything by hand.

A seed is a notebook and its data files. When an account is created (or when an
account made before seeding was switched on opens the page), the files are
copied into the user's files folder and the notebook is imported into a new chat
of their own, in the background: its cells run and become the agent's steps,
traced as a `notebook` run under that user, exactly as an upload would be. The
session then ends. The page opens on a new chat with that one in the chat list,
and a session on a chat restores it from the trace, so the imported work is there
one click after they sign in, and is still there after a reload; the user can
start other chats beside it and come back to it.

The seed definition is one JSON file shared with the BobFlow agent service,
which reads its own section (`AGENT_SEED_FILE`); this service reads
`smolagents`:

    {"name": "scenario-2",
     "smolagents": {"notebook": "~/study/scenario-2/notebook/analysis.ipynb",
                    "files": ["~/study/scenario-2/data/listings.csv"]}}

Paths may start with `~`; relative paths are read against the definition's
folder. `--seed PATH` names it.
"""

import json
import logging
import shutil
import threading
from pathlib import Path
from typing import Callable

from .config import Config, Seed
from .notebook import read_notebook
from .store import Store

log = logging.getLogger("smolagents_service")


def load_seed(path: str | Path | None) -> Seed | None:
    """The seed a definition file describes for this service, or None without a file or section."""
    if not path:
        return None
    file = Path(path).expanduser().resolve()
    data = json.loads(file.read_text(encoding="utf-8"))
    section = data.get("smolagents")
    if not section or not section.get("notebook"):
        return None

    def resolve(value: str) -> Path:
        candidate = Path(value).expanduser()
        return candidate if candidate.is_absolute() else (file.parent / candidate).resolve()

    seed = Seed(name=str(data.get("name") or file.stem), notebook=resolve(section["notebook"]),
                files=tuple(resolve(f) for f in section.get("files", [])))
    for needed in (seed.notebook, *seed.files):
        if not needed.exists():
            raise SystemExit(f"seed file {needed} does not exist ({file})")
    return seed


class Seeder:
    """Gives each account the seed once, in the background; a user's first session waits for it."""

    def __init__(self, store: Store, config: Config, make_session: Callable[[dict], object]):
        self.store = store
        self.config = config
        self.seed = config.seed
        self._make_session = make_session  # a headless ChatSession for the user, not restored from the trace
        self._threads: dict[int, threading.Thread] = {}
        self._lock = threading.Lock()

    def enabled(self) -> bool:
        return self.seed is not None

    def status(self, user_id: int) -> dict:
        if self.seed is None:
            return {"status": "disabled"}
        return self.store.seed_of(user_id, self.seed.name) or {"status": "none", "name": self.seed.name}

    def start(self, user: dict) -> dict:
        """Seed the user unless that is done or under way; says where it stands right away."""
        if self.seed is None:
            return {"status": "disabled"}
        with self._lock:
            row = self.store.seed_of(user["id"], self.seed.name)
            running = user["id"] in self._threads and self._threads[user["id"]].is_alive()
            if row is not None and (row["status"] == "done" or (row["status"] == "running" and running)):
                return row
            self.store.seed_started(user["id"], self.seed.name)
            thread = threading.Thread(target=self._run, args=(user,), daemon=True, name=f"seed-{user['id']}")
            self._threads[user["id"]] = thread
            thread.start()
            return self.store.seed_of(user["id"], self.seed.name)

    def wait(self, user_id: int, timeout: float | None = None) -> None:
        thread = self._threads.get(user_id)
        if thread is not None:
            thread.join(timeout)

    def _run(self, user: dict) -> None:
        seed = self.seed
        try:
            folder = self.config.user_dir(user["id"]) / "files"
            folder.mkdir(parents=True, exist_ok=True)
            for source in (*seed.files, seed.notebook):
                target = folder / source.name
                if not target.exists():
                    shutil.copyfile(source, target)
                    self.store.record_artifact(user["id"], "seed", str(target))
            notebook = read_notebook(folder / seed.notebook.name)
            session = self._make_session(user)
            try:
                with session.busy:
                    for _ in session.import_notebook(notebook, seed.notebook.name):
                        pass
            finally:
                session.close()
                self.store.end_chat_session(session.id, "seed imported")
            run = next((r for r in self.store.list_runs(user["id"], 10) if r["kind"] == "notebook"), None)
            if run is not None and run["status"] == "ok":
                self.store.seed_finished(user["id"], seed.name, "done", run["id"], None)
                log.info("seeded %s with %s (%d steps)", user["username"], seed.notebook.name, run["steps"])
            else:
                error = (run or {}).get("error") or "the notebook did not import"
                self.store.seed_finished(user["id"], seed.name, "failed", run and run["id"], error)
                log.warning("seeding %s failed: %s", user["username"], error)
        except Exception as failure:  # noqa: BLE001 - recorded for the facilitator, never raised into a request
            log.exception("seeding %s failed", user.get("username"))
            self.store.seed_finished(user["id"], seed.name, "failed", None, f"{type(failure).__name__}: {failure}")
        finally:
            with self._lock:
                self._threads.pop(user["id"], None)
