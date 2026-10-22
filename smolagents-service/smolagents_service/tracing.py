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

"""What a chat session records while its agent works.

A run is one user message and everything the agent does to answer it, one piece
of the user's own code run in the session's interpreter (a 'script' run), or a
notebook imported into the session (a 'notebook' run, one step per cell).
Inside an agent run, `TracedModel` records each model call (request start, first
streamed token, last token, token counts and the exact messages sent), the
executor reports each code execution (round trip, the time measured inside the
worker, and the worker's pid), and `Trace.on_step`, a smolagents step callback,
writes the step itself with smolagents' own step timing and token usage. Calls
and executions carry the agent's current step number, so a step's time splits
into model, code and the rest; the trace also keeps those sums for the chat.
"""

import json
import time
from pathlib import Path

from smolagents.memory import ActionStep
from smolagents.models import agglomerate_stream_deltas

from .store import Store


def messages_json(messages) -> str:
    """The messages a model call was sent, with each image reduced to its size."""
    out = []
    for message in messages:
        # Not ChatMessage.dict(): dataclasses.asdict deep-copies every image on every call.
        role, content = (message.get("role"), message.get("content")) if isinstance(message, dict) else (
            message.role, message.content)
        if isinstance(content, list):
            content = [
                {"type": "image", "size": list(getattr(part.get("image"), "size", ()))}
                if isinstance(part, dict) and part.get("type") == "image" else part
                for part in content
            ]
        out.append({"role": str(getattr(role, "value", role)), "content": content})
    return json.dumps(out, default=str)


def _text(value) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else json.dumps(value, default=str)


class Trace:
    def __init__(self, store: Store, user_id: int, chat_session_id: str, figures_dir: Path):
        self.store = store
        self.user_id = user_id
        self.chat_session_id = chat_session_id
        self.figures_dir = Path(figures_dir)
        self.agent = None  # set once the agent exists; its step_number labels calls and executions
        self.run_id: str | None = None
        self.kind = "agent"
        self.turns = 0
        self.cell_number: int | None = None  # the cell a notebook import is running
        self._figures: list = []
        self.steps: dict[int | None, dict] = {}  # this run's model and code time, and tokens, per step

    @property
    def step_number(self) -> int | None:
        if self.kind == "agent":
            return getattr(self.agent, "step_number", None)
        return self.cell_number if self.kind == "notebook" else None

    def start_run(self, task: str, kind: str = "agent") -> str:
        self.turns += 1
        self.kind, self.steps, self._figures = kind, {}, []
        self.run_id = self.store.start_run(self.user_id, self.chat_session_id, self.turns, task, kind)
        return self.run_id

    def _add(self, **amounts) -> None:
        totals = self.steps.setdefault(self.step_number, {"llm": 0.0, "python": 0.0, "input": 0, "output": 0})
        for key, amount in amounts.items():
            totals[key] += amount or 0

    def totals(self) -> dict:
        """The run so far: model and code seconds, and tokens, summed over its steps."""
        return {key: sum(step[key] for step in self.steps.values()) for key in ("llm", "python", "input", "output")}

    def finish_run(self, status: str, final_answer=None, error: str | None = None) -> None:
        if self.run_id is not None:
            self.store.finish_run(self.run_id, status, _text(final_answer), error)
            self.run_id = None

    def record_llm(self, *, model_id, started, first_token, ended, messages, output, usage, error=None) -> None:
        if self.run_id is None:
            return
        self._add(llm=ended - started, input=getattr(usage, "input_tokens", 0),
                  output=getattr(usage, "output_tokens", 0))
        self.store.record_llm_call(
            run_id=self.run_id, user_id=self.user_id, step_number=self.step_number, model_id=model_id,
            started_at=started, first_token_at=first_token, ended_at=ended,
            input_tokens=getattr(usage, "input_tokens", None), output_tokens=getattr(usage, "output_tokens", None),
            input_messages=messages_json(messages), output_text=output,
            error=None if error is None else f"{type(error).__name__}: {error}")

    def record_python(self, *, started, ended, code, reply, figures, pid=None) -> None:
        """The executor's report of one execution. A step's figures (an agent step's, or an
        imported cell's) wait for the step callback, which shows them to the model; a script
        run's are saved at once."""
        if self.run_id is None:
            return
        self._add(python=ended - started)
        self.store.record_python_exec(
            run_id=self.run_id, user_id=self.user_id, step_number=self.step_number, started_at=started,
            ended_at=ended, worker_seconds=reply.get("seconds"), worker_pid=pid, code=code,
            logs=reply.get("logs") if self.kind == "agent" else reply.get("output"),
            output=_text(reply.get("output") if self.kind == "agent" else reply.get("value")),
            is_final_answer=int(bool(reply.get("is_final_answer"))), figures=len(figures), error=reply.get("error"))
        if self.kind == "script":
            self._save_figures(figures, None)
        else:
            self._figures = figures

    def _save_figures(self, figures, step_number) -> None:
        for index, image in enumerate(figures, start=1):
            label = f"step{step_number}" if step_number is not None else "script"
            path = self.figures_dir / f"{self.run_id}-{label}-{index}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            image.save(path)
            self.store.record_artifact(self.user_id, "figure", str(path), self.run_id, step_number)

    def on_step(self, step: ActionStep) -> None:
        """smolagents step callback: attach the step's figures, then write the step."""
        figures, self._figures = self._figures, []
        if figures:
            # The chat shows observation images, and the model sees them on its next step.
            step.observations_images = (step.observations_images or []) + figures
        if self.run_id is None:
            return
        self._save_figures(figures, step.step_number)
        usage = step.token_usage
        self.store.record_step(
            run_id=self.run_id, user_id=self.user_id, step_number=step.step_number,
            started_at=step.timing.start_time, ended_at=step.timing.end_time,
            input_tokens=getattr(usage, "input_tokens", None), output_tokens=getattr(usage, "output_tokens", None),
            model_output=step.model_output, code=step.code_action, observations=step.observations,
            error=None if step.error is None else str(step.error), is_final_answer=int(bool(step.is_final_answer)),
            figures=len(figures))


class TracedModel:
    """Wraps a smolagents model and records every call to it in the session's trace."""

    def __init__(self, model, trace: Trace):
        self._model = model
        self._trace = trace
        self.model_id = getattr(model, "model_id", None)

    def __getattr__(self, name):
        return getattr(self._model, name)

    def _record(self, started, first_token, messages, output, usage, error=None) -> None:
        self._trace.record_llm(model_id=self.model_id, started=started, first_token=first_token, ended=time.time(),
                               messages=messages, output=output, usage=usage, error=error)

    def generate(self, messages, *args, **kwargs):
        started = time.time()
        try:
            message = self._model.generate(messages, *args, **kwargs)
        except Exception as error:
            self._record(started, None, messages, None, None, error)
            raise
        self._record(started, None, messages, message.content, message.token_usage)
        return message

    __call__ = generate

    def generate_stream(self, messages, *args, **kwargs):
        started, first_token, deltas = time.time(), None, []
        try:
            for delta in self._model.generate_stream(messages, *args, **kwargs):
                if first_token is None and delta.content:
                    first_token = time.time()
                deltas.append(delta)
                yield delta
        except BaseException as error:  # GeneratorExit too: a run stopped mid-stream
            partial = agglomerate_stream_deltas(deltas)
            self._record(started, first_token, messages, partial.content, partial.token_usage, error)
            raise
        message = agglomerate_stream_deltas(deltas)
        self._record(started, first_token, messages, message.content, message.token_usage)
