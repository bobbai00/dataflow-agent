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

"""The chat and trace pages, mounted at /app behind the login.

The chat shows each part of a run once (see render.py). Below it, the user can run
their own code, typed in or loaded from their files, in the chat's Python session;
the agent then sees that run. Every handler resolves the signed-in user from the
request and reads or writes only that user's records and files.
"""

import html
import json
import re
import shutil
import time
from pathlib import Path

import gradio as gr
from smolagents.memory import ActionStep, FinalAnswerStep
from smolagents.models import ChatMessageStreamDelta
from smolagents.utils import AgentMaxStepsError

from .config import Config
from .render import answer_messages, escape_tags, script_messages, step_messages, streaming_message
from .sessions import SessionLimit, Sessions, user_files
from .store import Store

STREAM_SECONDS = 0.15  # a streaming step is redrawn at most this often, not on every token
DATA_SUFFIXES = [".csv", ".tsv", ".json", ".jsonl", ".parquet", ".xlsx", ".xls", ".txt"]
SCRIPT_SUFFIX = ".py"
LATEX_DELIMITERS = [
    {"left": "$$", "right": "$$", "display": True},
    {"left": r"\[", "right": r"\]", "display": True},
    {"left": r"\(", "right": r"\)", "display": False},
]
RUN_COLUMNS = ["started", "turn", "message", "kind", "status", "seconds", "steps", "LLM s", "Python s",
               "input tokens", "output tokens", "run id"]
STEP_COLUMNS = ["step", "started", "seconds", "LLM s", "Python s", "other s", "input tokens", "output tokens",
                "figures", "error"]
SPAN_COLUMNS = ["at (s into run)", "kind", "step", "seconds", "first token (s)", "worker s", "worker pid",
                "input tokens", "output tokens", "error"]


def clock(timestamp: float | None) -> str:
    if timestamp is None:
        return ""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp)) + f".{int(timestamp % 1 * 1000):03d}"


def seconds(value: float | None) -> float | None:
    return None if value is None else round(value, 3)


def clip(text: str | None, width: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= width else text[: width - 1] + "…"


def run_agent(session, task: str, history: list):
    """Run the agent on one message, streaming chat updates and tracing the run."""
    session.trace.start_run(task)
    status, final, error = "error", None, None
    streamed, text, drawn = None, "", 0.0  # the step being written, shown live until it finishes
    started, steps = time.monotonic(), 0
    events = session.agent.run(task, stream=True, reset=False)
    try:
        for event in events:
            if isinstance(event, ChatMessageStreamDelta):
                if not event.content:
                    continue
                if streamed is None:
                    streamed, text = streaming_message(session.agent.step_number), ""
                    history.append(streamed)
                text += event.content
                if time.monotonic() - drawn >= STREAM_SECONDS:
                    streamed.content, drawn = escape_tags(text), time.monotonic()
                    yield history
            elif isinstance(event, ActionStep):
                if streamed is not None:
                    history.remove(streamed)
                    streamed = None
                steps += 1
                history.extend(step_messages(event))
                yield history
            elif isinstance(event, FinalAnswerStep):
                final = event.output
                history.extend(answer_messages(final, steps, time.monotonic() - started, session.trace.totals()))
                yield history
        memory = session.agent.memory.steps
        status = "max_steps" if memory and isinstance(getattr(memory[-1], "error", None), AgentMaxStepsError) else "ok"
    except GeneratorExit:
        status = "cancelled"
        raise
    except Exception as failure:  # noqa: BLE001 - the user sees it in the chat and the trace keeps it
        error = f"{type(failure).__name__}: {failure}"
        history.append(gr.ChatMessage(role="assistant", content=error,
                                      metadata={"title": "💥 The run failed", "status": "done"}))
        yield history
    finally:
        events.close()
        session.trace.finish_run(status, final, error)


def build_ui(store: Store, sessions: Sessions, config: Config) -> gr.Blocks:
    def user_of(request: gr.Request) -> dict:
        user = store.user_by_name(request.username) if request is not None and request.username else None
        if user is None:
            raise gr.Error("You are signed out. Reload the page to sign in again.")
        return user

    def files_markdown(user: dict) -> str:
        files = user_files(config, user["id"])
        if not files:
            return "*No files yet.*"
        return "**Your files**\n" + "\n".join(f"- `{Path(path).name}`" for path in files)

    def scripts_of(user: dict) -> list[str]:
        return [Path(path).name for path in user_files(config, user["id"]) if path.endswith(SCRIPT_SUFFIX)]

    def runs_table(user: dict) -> list[list]:
        return [[clock(r["started_at"]), r["turn"], clip(r["task"], 90), r["kind"], r["status"],
                 seconds(r["seconds"]), r["steps"], seconds(r["llm_seconds"]), seconds(r["python_seconds"]),
                 r["input_tokens"], r["output_tokens"], r["id"]] for r in store.list_runs(user["id"])]

    def on_load(request: gr.Request):
        user = user_of(request)
        who = (f"Signed in as <b>{html.escape(user['username'])}</b> · "
               '<a href="/logout" target="_self">Log out</a>')
        return who, files_markdown(user), runs_table(user), gr.Dropdown(choices=scripts_of(user))

    def open_session(request: gr.Request, user: dict, history: list):
        """The tab's chat session, locked for one run; or None, with the reason added to the chat."""
        try:
            session = sessions.get(request.session_hash, user)
        except SessionLimit as full:
            history.append(gr.ChatMessage(role="assistant", content=str(full)))
            return None
        if not session.busy.acquire(blocking=False):
            history.append(gr.ChatMessage(role="assistant", content="Still working on your previous request."))
            return None
        return session

    def lock_inputs(prompt: str):
        return prompt, gr.Textbox(value="", interactive=False), gr.Button(interactive=False)

    def unlock_inputs():
        return gr.Textbox(interactive=True), gr.Button(interactive=True)

    def chat(prompt: str, history: list, request: gr.Request):
        user = user_of(request)
        history = list(history or [])
        if not prompt.strip():
            yield history
            return
        session = open_session(request, user, history)
        if session is None:
            yield history
            return
        try:
            files = sessions.take_pending(request.session_hash)
            task = prompt + (f"\nYou have been provided with these files: {files}" if files else "")
            attached = "".join(f"\n📎 `{Path(path).name}`" for path in files)  # the agent gets the full paths
            history.append(gr.ChatMessage(role="user", content=prompt + attached))
            yield history
            yield from run_agent(session, task, history)
        finally:
            session.last_active = time.monotonic()
            session.busy.release()

    def run_code(code: str, name: str, loaded: str, history: list, request: gr.Request):
        """Run the user's own code in the chat's Python session, where the agent will see it."""
        user = user_of(request)
        history = list(history or [])
        if not code.strip():
            yield history
            return
        label = (name if code == loaded else f"{name} (edited)") if name else "your code"
        session = open_session(request, user, history)
        if session is None:
            yield history
            return
        try:
            history.append(gr.ChatMessage(role="user", content=f"▶ Ran `{label}`"))
            yield history
            reply, figures = session.run_python(code, label)
            history.extend(script_messages(label, code, reply, figures))
            yield history
        finally:
            session.last_active = time.monotonic()
            session.busy.release()

    def load_script(choice: str | None, request: gr.Request):
        user = user_of(request)
        path = config.user_dir(user["id"]) / "files" / (choice or "")
        if not choice or not path.is_file():
            return gr.update(), gr.update(), gr.update()
        code = path.read_text(errors="replace")
        return code, choice, code

    def upload(file, request: gr.Request):
        """Add a file to the user's files. A script is loaded into the code box; data is
        mentioned to the agent. The upload box empties again, ready for the next file."""
        user = user_of(request)
        unchanged = (gr.update(),) * 5  # the script picker, code, its name, its loaded text, the panel
        if not file:
            return (gr.update(), files_markdown(user)) + unchanged + (None,)
        name = re.sub(r"[^\w\-.]", "_", Path(file).name)
        suffix = Path(name).suffix.lower()
        if suffix not in DATA_SUFFIXES + [SCRIPT_SUFFIX]:
            allowed = ", ".join(DATA_SUFFIXES + [SCRIPT_SUFFIX])
            return (f"`{name}` was not added: allowed types are {allowed}.", files_markdown(user)) + unchanged + (None,)
        folder = config.user_dir(user["id"]) / "files"
        folder.mkdir(parents=True, exist_ok=True)
        destination = folder / name
        shutil.copyfile(file, destination)
        store.record_artifact(user["id"], "upload", str(destination))
        store.record_event(user["id"], "upload", None, file=name, bytes=destination.stat().st_size)
        if suffix == SCRIPT_SUFFIX:
            code = destination.read_text(errors="replace")
            return (f"Added `{name}`. It is loaded below the chat: press Run to run it.", files_markdown(user),
                    gr.Dropdown(choices=scripts_of(user), value=name), code, name, code, gr.Accordion(open=True), None)
        sessions.add_pending(request.session_hash, str(destination))
        return (f"Added `{name}`; the agent hears about it with your next message.", files_markdown(user),
                gr.Dropdown(choices=scripts_of(user)), gr.update(), gr.update(), gr.update(), gr.update(), None)

    def show_run(table, event: gr.SelectData, request: gr.Request):
        user = user_of(request)
        run_id = str(table.iloc[event.index[0], -1])
        run = store.get_run(user["id"], run_id)
        if run is None:
            raise gr.Error("That run is not yours or no longer exists.")
        steps = [[s["step_number"], clock(s["started_at"]), seconds(s["seconds"]), seconds(s["llm_seconds"]),
                  seconds(s["python_seconds"]),
                  seconds((s["seconds"] or 0) - s["llm_seconds"] - s["python_seconds"]) if s["seconds"] else None,
                  s["input_tokens"], s["output_tokens"], s["figures"], clip(s["error"], 120)] for s in run["steps"]]
        start = run["started_at"]
        spans = sorted(
            [[seconds(c["started_at"] - start), "LLM", c["step_number"], seconds(c["ended_at"] - c["started_at"]),
              seconds(c["first_token_at"] - c["started_at"]) if c["first_token_at"] else None, None, None,
              c["input_tokens"], c["output_tokens"], clip(c["error"], 120)] for c in run["llm_calls"]]
            + [[seconds(p["started_at"] - start), "Python", p["step_number"], seconds(p["ended_at"] - p["started_at"]),
                None, seconds(p["worker_seconds"]), p["worker_pid"], None, None, clip(p["error"], 120)]
               for p in run["python_execs"]],
            key=lambda row: row[0])
        return steps, spans, run_id, ""

    def show_context(table, run_id: str, event: gr.SelectData, request: gr.Request):
        user = user_of(request)
        step_number = int(table.iloc[event.index[0], 0])
        context = store.step_context(user["id"], run_id, step_number)
        return json.dumps(context, indent=1) if context is not None else "No model call was recorded for that step."

    def refresh(request: gr.Request):
        return runs_table(user_of(request))

    with gr.Blocks(title="smolagents analyst", fill_height=True) as demo:
        with gr.Sidebar():
            gr.Markdown("# Data analyst")
            who = gr.HTML()
            gr.Markdown(f"A smolagents `CodeAgent` on `{config.model_id}`. Its Python runs in your own "
                        "interpreter, and every step is traced to your account (see **My traces**).")
            with gr.Group():
                prompt = gr.Textbox(lines=3, label="Your request", placeholder="Ask about your data, then Submit")
                submit = gr.Button("Submit", variant="primary")
            upload_file = gr.File(label="Add a data file or a Python script",
                                  file_types=DATA_SUFFIXES + [SCRIPT_SUFFIX])
            upload_status = gr.Markdown()
            files = gr.Markdown()
        with gr.Tab("Chat"):
            chatbot = gr.Chatbot(label="Agent", latex_delimiters=LATEX_DELIMITERS, scale=1, height="65vh")
            with gr.Accordion("Run your own Python", open=False) as python_panel:
                gr.Markdown("Runs in this chat's Python session, beside the agent's variables. The agent sees the "
                            "code, what it printed and what it defined, so you can ask about it next.")
                script_picker = gr.Dropdown(label="Load a script from your files", choices=[], interactive=True)
                code_box = gr.Code(language="python", lines=8, label="Code", interactive=True, elem_id="code-box")
                run_button = gr.Button("Run", elem_id="run-code")
        with gr.Tab("My traces"):
            refresh_runs = gr.Button("Refresh", size="sm")
            runs = gr.Dataframe(headers=RUN_COLUMNS, interactive=False, wrap=True, max_height=320, elem_id="runs-table",
                                column_widths=["170px", "60px", "320px"] + ["90px"] * 7 + ["150px"])
            gr.Markdown("Select a run for its steps and timeline; select a step for the context its model call saw.")
            steps = gr.Dataframe(headers=STEP_COLUMNS, interactive=False, wrap=True, max_height=320,
                                 elem_id="steps-table",
                                 column_widths=["60px", "190px"] + ["90px"] * 4 + ["110px", "120px", "80px", "260px"])
            spans = gr.Dataframe(headers=SPAN_COLUMNS, interactive=False, max_height=320, elem_id="spans-table")
            context = gr.Code(language="json", label="Model input for the selected step", max_lines=40,
                              elem_id="step-context")
        selected_run = gr.State("")
        sent = gr.State("")
        script_name = gr.State("")  # the script loaded into the code box
        script_text = gr.State("")  # its text when loaded, to tell an edited copy apart

        demo.load(on_load, outputs=[who, files, runs, script_picker])
        for trigger in (prompt.submit, submit.click):
            trigger(lock_inputs, [prompt], [sent, prompt, submit]).then(
                chat, [sent, chatbot], [chatbot], concurrency_limit=config.concurrency, concurrency_id="agent").then(
                unlock_inputs, None, [prompt, submit])
        run_button.click(lambda: gr.Button(interactive=False), None, [run_button]).then(
            run_code, [code_box, script_name, script_text, chatbot], [chatbot],
            concurrency_limit=config.concurrency, concurrency_id="agent").then(
            lambda: gr.Button(interactive=True), None, [run_button])
        script_picker.input(load_script, [script_picker], [code_box, script_name, script_text])
        upload_file.upload(upload, [upload_file], [upload_status, files, script_picker, code_box, script_name,
                                                   script_text, python_panel, upload_file])
        refresh_runs.click(refresh, None, [runs])
        runs.select(show_run, [runs], [steps, spans, selected_run, context])
        steps.select(show_context, [steps, selected_run], [context])
    return demo
