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

"""Chat sessions: one agent, one worker process and one trace per browser session.

A session belongs to the user who opened it, keyed by Gradio's session hash. It
ends when its tab has been gone for the disconnect grace period (the tab's
heartbeat stream, watched by app.HeartbeatWatch, ended and did not come back),
when the user signs in as someone else in that tab, or when it sits idle past the
configured limit. Agents share nothing: each has its own memory, its own
interpreter state and its own trace. The user can also run their own code in the
session's interpreter (`ChatSession.run_python`); the run then joins the agent's
memory as a `UserCodeStep`, so follow-up questions can build on its output and its
variables. A notebook can be imported (`ChatSession.import_notebook`): its cells
run in the interpreter and join the memory as the agent's own steps.
"""

import logging
import shutil
import threading
import time
from dataclasses import dataclass, field

import smolagents.agents
from smolagents import CodeAgent
from smolagents.memory import ActionStep, MemoryStep, TaskStep, ToolCall
from smolagents.models import ChatMessage, MessageRole
from smolagents.monitoring import AgentLogger, LogLevel, Timing
from smolagents.utils import AgentExecutionError, truncate_content

from .config import Config
from .executor import WorkerExecutor
from .notebook import Notebook, observation_of
from .store import Store
from .tracing import TracedModel, Trace

log = logging.getLogger("smolagents_service")

AUTHORIZED_IMPORTS = ["pandas.*", "numpy.*", "scipy.*", "sklearn.*", "statsmodels.*", "matplotlib.*",
                      "seaborn.*", "json", "csv"]


class _NoLive:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def update(self, *args, **kwargs):
        pass


# CodeAgent mirrors each streamed reply into a rich Live display, re-parsing the whole
# reply as Markdown on every token. The server has no terminal, and with many agents
# streaming at once that parsing is CPU every session waits on under the GIL.
smolagents.agents.Live = _NoLive
smolagents.agents.Markdown = lambda *args, **kwargs: None


class SessionLimit(RuntimeError):
    pass


CONTEXT_CHARACTERS = 10_000  # of a user run's code, and of its output, that the agent is shown


def instructions(files: list[str], extra: str = "") -> str:
    """The agent's instructions: how this server runs it, the user's files, and `extra` (the
    server's `--instructions`, such as a study's rules for the agent)."""
    text = ("Your working directory is the user's files folder, private to this user: their uploads are "
            "there, and files you write there persist. "
            "To show a chart, draw it with matplotlib and leave the figure open: after your step the "
            "user sees every open figure, and so do you, as an image. Do not call plt.close().")
    if files:
        text += "\n\nThe user's files, by absolute path:\n" + "\n".join(f"- {path}" for path in files)
    if extra.strip():
        text += "\n\n" + extra.strip()
    return text


def user_files(config: Config, user_id: int) -> list[str]:
    folder = config.user_dir(user_id) / "files"
    if not folder.exists():
        return []
    return sorted(str(path) for path in folder.iterdir() if path.is_file() and not path.name.startswith("."))


OLD_FOLDERS = ("uploads", "workspace")  # before one files folder held both
OLD_SCRATCH = {"tmp", ".matplotlib", "worker.log"}  # the worker's own files in the old workspace


def adopt_old_folders(config: Config, store: Store) -> None:
    """Move each user's files from the old uploads/ and workspace/ folders into files/.

    Data files move (never over a file already there); only the worker's own scratch
    is deleted; upload records follow their files.
    """
    for user_dir in (config.data_dir / "users").glob("*"):
        files = user_dir / "files"
        for old in (user_dir / name for name in OLD_FOLDERS):
            if not old.is_dir():
                continue
            files.mkdir(exist_ok=True)
            for item in old.iterdir():
                if item.name in OLD_SCRATCH:
                    shutil.rmtree(item) if item.is_dir() else item.unlink()
                elif not (files / item.name).exists():
                    item.rename(files / item.name)
                    store.move_artifact(str(item), str(files / item.name))
            if not any(old.iterdir()):
                old.rmdir()
            else:
                log.warning("left %s: its files have namesakes in %s", old, files)


@dataclass
class UserCodeStep(MemoryStep):
    """Code the user ran themselves in the session's interpreter, as the agent's memory shows it."""

    name: str
    code: str
    output: str = ""
    value: str | None = None
    error: str | None = None
    variables: dict = field(default_factory=dict)
    images: list = field(default_factory=list)

    def to_messages(self, summary_mode: bool = False) -> list[ChatMessage]:
        text = (f"The user ran their own code, {self.name}, in this session's Python interpreter. You did not "
                "write it, but its variables are now in your interpreter too.\n"
                f"```python\n{truncate_content(self.code, CONTEXT_CHARACTERS)}\n```\n")
        if self.output:
            text += f"It printed:\n```\n{truncate_content(self.output, CONTEXT_CHARACTERS)}\n```\n"
        if self.value is not None:
            text += f"Its last expression was: {truncate_content(self.value, 2000)}\n"
        if self.error:
            text += f"It failed:\n```\n{truncate_content(self.error, 4000)}\n```\n"
        if self.variables:
            text += "It defined or replaced: " + ", ".join(f"{k} ({v})" for k, v in self.variables.items()) + "\n"
        if self.images:
            text += f"It drew {len(self.images)} chart(s), attached.\n"
        content = [{"type": "text", "text": text}] + [{"type": "image", "image": image} for image in self.images]
        return [ChatMessage(role=MessageRole.USER, content=content)]


@dataclass
class NoteStep(MemoryStep):
    """A note to the agent in its memory, read as a message from the user's side."""

    text: str

    def to_messages(self, summary_mode: bool = False) -> list[ChatMessage]:
        return [ChatMessage(role=MessageRole.USER, content=[{"type": "text", "text": self.text}])]


def import_note(name: str, instructions: str) -> str:
    """What the agent is told once a notebook's steps are in its memory."""
    text = (f"The steps above are your earlier work on this task, brought into this chat from the notebook "
            f"{name}; their variables are in your interpreter. The user may now ask about the work or ask "
            "for changes.")
    return text + ("\n\n" + instructions.strip() if instructions.strip() else "")


class ChatSession:
    def __init__(self, store: Store, config: Config, user: dict):
        self.user = user
        self.config = config
        self.id = store.start_chat_session(user["id"], config.model_id)
        user_dir = config.user_dir(user["id"])
        self.trace = Trace(store, user["id"], self.id, user_dir / "figures")
        self.executor = WorkerExecutor(user_dir=user_dir, data_dir=config.data_dir,
                                       authorized_imports=AUTHORIZED_IMPORTS, timeout=config.exec_timeout,
                                       sandbox=config.sandbox, secret_files=list(config.secret_files),
                                       on_exec=self.trace.record_python)
        self.agent = CodeAgent(
            tools=[],
            model=TracedModel(config.make_model(), self.trace),
            executor=self.executor,
            additional_authorized_imports=AUTHORIZED_IMPORTS,
            instructions=instructions(user_files(config, user["id"]), config.instructions),
            max_steps=config.max_steps,
            stream_outputs=True,
            step_callbacks=[self.trace.on_step],
            logger=AgentLogger(level=LogLevel.OFF),
            name="data_analyst",
        )
        self.trace.agent = self.agent
        self.busy = threading.Lock()  # one run at a time per session
        self.last_active = time.monotonic()
        # Start the interpreter now, while the first model call is still in flight.
        threading.Thread(target=self.executor.warm, daemon=True).start()

    def run_python(self, code: str, name: str) -> tuple[dict, list]:
        """Run the user's own code in this session's interpreter, trace it as a 'script' run, and add
        it to the agent's memory. The caller holds `busy`. Returns the worker's reply and the figures."""
        self.trace.start_run(f"Ran {name}", kind="script")
        reply, figures = self.executor.run_python(code, name)
        self.trace.finish_run("error" if reply.get("error") else "ok", reply.get("value"), reply.get("error"))
        self.agent.memory.steps.append(UserCodeStep(
            name=name, code=code, output=reply.get("output", ""), value=reply.get("value"), error=reply.get("error"),
            variables=reply.get("variables", {}), images=figures))
        return reply, figures

    def import_notebook(self, notebook: Notebook, name: str):
        """Run a notebook's cells in this session's interpreter, in order, and add them to the
        agent's memory as its own steps: the task, one step per cell (its reasoning the markdown
        above the cell, its observation what the cell printed and returned), the answer as the
        final step, and a note on what follows (with the server's notebook instructions). Traced
        as a 'notebook' run. The caller holds `busy`. Yields each step once it has run."""
        self.trace.start_run(f"Imported {name}", kind="notebook")
        steps = self.agent.memory.steps
        steps.append(TaskStep(task=notebook.task or f"Continue the analysis in {name}."))
        status = "ok"
        for cell in notebook.cells:
            self.trace.cell_number = cell.number
            started = time.time()
            reply, _ = self.executor.run_python(cell.code, f"cell {cell.number}")
            error = reply.get("error")
            step = ActionStep(
                step_number=cell.number, timing=Timing(started, time.time()),
                model_output=(f"{cell.thought}\n" if cell.thought else "") + f"<code>\n{cell.code}\n</code>",
                tool_calls=[ToolCall(name="python_interpreter", arguments=cell.code, id=f"call_{len(steps)}")],
                code_action=cell.code, observations=observation_of(reply),
                error=AgentExecutionError(error, self.agent.logger) if error else None)
            steps.append(step)
            self.trace.on_step(step)  # attaches the cell's figures, then records the step
            status = "error" if error else status
            yield step
        if notebook.answer:
            now, code = time.time(), f"final_answer({notebook.answer!r})"
            final = ActionStep(
                step_number=len(notebook.cells) + 1, timing=Timing(now, now),
                model_output=f"<code>\n{code}\n</code>", code_action=code,
                tool_calls=[ToolCall(name="python_interpreter", arguments=code, id=f"call_{len(steps)}")],
                observations=f"Last output from code snippet:\n{notebook.answer}",
                action_output=notebook.answer, is_final_answer=True)
            steps.append(final)
            self.trace.on_step(final)
            yield final
        steps.append(NoteStep(import_note(name, self.config.notebook_instructions)))
        self.trace.cell_number = None
        self.trace.finish_run(status, notebook.answer or None)

    def close(self) -> None:
        self.agent.cleanup()


class Sessions:
    def __init__(self, store: Store, config: Config):
        self.store = store
        self.config = config
        self._sessions: dict[str, ChatSession] = {}
        self._pending: dict[str, list[str]] = {}  # uploads not yet mentioned to the agent, by browser session
        self._streams: dict[str, int] = {}  # open heartbeat streams, by browser session
        self._gone_since: dict[str, float] = {}  # when a browser session's last heartbeat stream ended
        self._lock = threading.Lock()
        threading.Thread(target=self._close_idle, daemon=True).start()

    def get(self, key: str, user: dict) -> ChatSession:
        replaced = None
        with self._lock:
            session = self._sessions.get(key)
            if session is not None and session.user["id"] == user["id"]:
                session.last_active = time.monotonic()
                return session
            if session is not None:  # the same tab, now signed in as someone else
                replaced = self._sessions.pop(key)
            if len(self._sessions) >= self.config.max_sessions:
                raise SessionLimit("The server has as many open sessions as it allows. Try again in a few minutes.")
            session = self._sessions[key] = ChatSession(self.store, self.config, user)
        if replaced is not None:
            self._end(replaced, "replaced by another login")
        self.store.record_event(user["id"], "chat_session_start", session.id)
        log.info("session %s opened for %s (%d open)", session.id, user["username"], len(self._sessions))
        return session

    def heartbeat_opened(self, key: str) -> None:
        with self._lock:
            self._streams[key] = self._streams.get(key, 0) + 1
            self._gone_since.pop(key, None)

    def heartbeat_closed(self, key: str) -> None:
        with self._lock:
            self._streams[key] = self._streams.get(key, 1) - 1
            if self._streams[key] <= 0:
                del self._streams[key]
                self._gone_since[key] = time.monotonic()

    def add_pending(self, key: str, path: str) -> None:
        with self._lock:
            self._pending.setdefault(key, []).append(path)

    def take_pending(self, key: str) -> list[str]:
        with self._lock:
            return self._pending.pop(key, [])

    def close(self, key: str, reason: str) -> None:
        with self._lock:
            session = self._sessions.pop(key, None)
            self._pending.pop(key, None)
            self._gone_since.pop(key, None)
        if session is not None:
            self._end(session, reason)

    def close_all(self, reason: str) -> None:
        for key in list(self._sessions):
            self.close(key, reason)

    def open_count(self) -> int:
        return len(self._sessions)

    def _end(self, session: ChatSession, reason: str) -> None:
        session.close()
        self.store.end_chat_session(session.id, reason)
        self.store.record_event(session.user["id"], "chat_session_end", session.id, reason=reason)
        log.info("session %s of %s closed: %s", session.id, session.user["username"], reason)

    def _close_idle(self) -> None:
        while True:
            time.sleep(min(30.0, self.config.disconnect_grace_seconds / 2))
            self.close_stale()

    def close_stale(self) -> None:
        """Close sessions whose tab is gone or that sat idle too long; never one that is mid-run."""
        now = time.monotonic()
        with self._lock:
            for key in [key for key, gone in self._gone_since.items()
                        if key not in self._sessions and now - gone >= self.config.disconnect_grace_seconds]:
                del self._gone_since[key]  # a tab that closed without ever chatting
            stale = {}
            for key, session in self._sessions.items():
                if session.busy.locked():
                    continue
                gone = self._gone_since.get(key)
                if gone is not None and now - gone >= self.config.disconnect_grace_seconds:
                    stale[key] = "tab closed"
                elif now - session.last_active >= self.config.idle_minutes * 60:
                    stale[key] = "idle"
        for key, reason in stale.items():
            self.close(key, reason)
