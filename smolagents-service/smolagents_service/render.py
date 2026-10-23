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

"""How runs look in the chat: every piece of a reply shown once.

smolagents' own renderer shows a step three times over: the streamed reply (its
reasoning and code), a "Used tool" block repeating the code, and for the last step
a "Final answer" block repeating the answer the code just spelled out. Here a step
is streamed into a temporary "Step N" box, and when it finishes that box is
replaced by what the step did: its reasoning in a sentence, then one folded
"Ran Python" block (the code, what it printed, the step's time and tokens), or
nothing more when the step only delivered the answer. The answer is shown once,
at the end, with the run's totals. The user's own code runs read the same way.
"""

import ast
import re

import gradio as gr
from smolagents.agent_types import AgentImage
from smolagents.memory import ActionStep

FOOTNOTE = '<span style="color: #8b8b93; font-size: 12px;">{}</span>'


def escape_tags(text: str) -> str:
    return text.replace("<", r"\<").replace(">", r"\>")  # raw tags such as <code> break the chatbot


def reasoning_of(model_output: str | None) -> str:
    """The prose a reply opens with, before its code, without the 'Thought:' label."""
    text = re.split(r"<code>|```", model_output or "", maxsplit=1)[0].strip()
    return re.sub(r"^Thought:\s*", "", text).strip()


def only_answers(code: str | None) -> bool:
    """Whether the code does nothing but call final_answer(...)."""
    try:
        body = ast.parse(code or "").body
    except SyntaxError:
        return False
    return (len(body) == 1 and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Call)
            and getattr(body[0].value.func, "id", None) == "final_answer")


def printed_of(observations: str | None) -> str:
    """What the step's code printed and returned, without smolagents' labels for the model."""
    text = (observations or "").replace("Execution logs:\n", "", 1)
    text = re.sub(r"Last output from code snippet:\n(None)?\s*$", "", text)
    return text.replace("Last output from code snippet:\n", "→ ").strip()


def image_message(image) -> gr.ChatMessage:
    return gr.ChatMessage(role="assistant", content={"path": AgentImage(image).to_string(), "mime_type": "image/png"})


def streaming_message(step_number: int) -> gr.ChatMessage:
    """The step being written, shown live until step_messages replaces it."""
    return gr.ChatMessage(role="assistant", content="",
                          metadata={"title": f"✍️ Step {step_number}", "status": "pending"})


def step_messages(step: ActionStep) -> list[gr.ChatMessage]:
    """A finished agent step: its reasoning, then its code and output folded, then its charts."""
    facts = []
    if step.timing.duration:
        facts.append(f"{step.timing.duration:.1f} s")
    if step.token_usage:
        facts.append(f"{step.token_usage.input_tokens:,} → {step.token_usage.output_tokens:,} tokens")
    label = " · ".join([f"step {step.step_number}"] + facts)
    final, code, error = bool(step.is_final_answer), step.code_action, step.error
    messages = []
    reasoning = reasoning_of(step.model_output)
    if reasoning and not final:
        messages.append(gr.ChatMessage(role="assistant", content=escape_tags(reasoning)))
    if code and not (final and error is None and only_answers(code)):
        body = f"```python\n{code}\n```"
        printed = printed_of(step.observations)
        if printed:
            body += f"\n```text\n{printed}\n```"
        if error is not None:
            body += f"\n```text\n{error}\n```"
        title = f"⚠️ Python failed · {label}" if error is not None else f"🐍 Ran Python · {label}"
        messages.append(gr.ChatMessage(role="assistant", content=body, metadata={"title": title, "status": "done"}))
    elif error is not None:  # no code to run: the reply was not in the expected form, or steps ran out
        what = "no code in the reply" if type(error).__name__ == "AgentParsingError" else "stopped"
        messages.append(gr.ChatMessage(role="assistant", content=f"```text\n{error}\n```",
                                       metadata={"title": f"⚠️ {what.capitalize()} · {label}", "status": "done"}))
    messages.extend(image_message(image) for image in step.observations_images or [])
    return messages


def answer_messages(answer, steps: int, seconds: float, totals: dict) -> list[gr.ChatMessage]:
    """The run's answer, once, and a line of what it took."""
    if isinstance(answer, AgentImage):
        content = {"path": answer.to_string(), "mime_type": "image/png"}
    else:
        content = str(answer)
    summary = (f"✓ {steps} step{'s' if steps != 1 else ''} · {seconds:.1f} s · LLM {totals['llm']:.1f} s · "
               f"Python {totals['python']:.1f} s · {totals['input']:,} → {totals['output']:,} tokens")
    return [gr.ChatMessage(role="assistant", content=content),
            gr.ChatMessage(role="assistant", content=FOOTNOTE.format(summary))]


def import_stopped(cell: int, cells: int, error) -> gr.ChatMessage:
    """Why a notebook import ended early: the cell that failed and the last line of its error."""
    after = cells - cell
    text = f"**Cell {cell} failed, so the import stopped there**" + (
        f": the {after} cell{'s' if after != 1 else ''} after it did not run." if after else ".")
    reason = str(error).strip().splitlines()[-1:] if error is not None else []
    if reason:
        text += f"\n```text\n{reason[0]}\n```"
    return gr.ChatMessage(role="assistant", content=text)


def import_footnote(name: str, cells: int, seconds: float, python_seconds: float,
                    stopped_at: int | None = None) -> gr.ChatMessage:
    """What importing a notebook took, after its cells; `stopped_at` is the cell that failed, if one did."""
    ran = cells if stopped_at is None else stopped_at
    facts = [(f"✓ imported {cells} cell{'s' if cells != 1 else ''}" if stopped_at is None
              else f"⚠️ ran {ran} of {cells} cells") + f" from `{name}`", f"{seconds:.1f} s",
             f"Python {python_seconds:.1f} s", "the agent remembers them as its own steps"]
    return gr.ChatMessage(role="assistant", content=FOOTNOTE.format(escape_tags(" · ".join(facts))))


def script_messages(name: str, code: str, reply: dict, figures: list) -> list[gr.ChatMessage]:
    """The user's own code run: the code folded, then what it printed or raised, its charts, and what it left."""
    lines = code.count("\n") + 1
    messages = [gr.ChatMessage(role="assistant", content=f"```python\n{code}\n```",
                               metadata={"title": f"📄 {name} · {lines} line{'s' if lines != 1 else ''}",
                                         "status": "done"})]
    parts = []
    if reply.get("output"):
        parts.append(f"```text\n{reply['output'].rstrip()}\n```")
    if reply.get("value") is not None:
        parts.append(f"→ `{reply['value']}`" if "\n" not in reply["value"] and len(reply["value"]) < 200
                     else f"```text\n{reply['value']}\n```")
    if reply.get("error"):
        parts.append(f"**It failed:**\n```text\n{reply['error'].rstrip()}\n```")
    messages.append(gr.ChatMessage(role="assistant", content="\n".join(parts) or "*No output.*"))
    messages.extend(image_message(image) for image in figures)
    facts = [f"ran in this chat's Python in {reply['seconds']:.1f} s" if reply.get("seconds") is not None
             else "did not finish"]
    if reply.get("variables"):
        facts.append("now defined: " + ", ".join(f"{k} ({v})" for k, v in reply["variables"].items()))
    facts.append("the agent sees this run")
    messages.append(gr.ChatMessage(role="assistant", content=FOOTNOTE.format(escape_tags(" · ".join(facts)))))
    return messages
