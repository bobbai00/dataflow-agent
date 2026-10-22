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

"""Serve smolagents' Gradio chat UI as a data-analysis agent on the stack's LiteLLM gateway.

The agent is the benchmark's script baseline: smolagents' `CodeAgent` with its own
system prompt and no tools, running model-written Python in its local interpreter,
here with the data-science libraries authorized. The UI is the `GradioUI` of the
pinned smolagents 1.23, with these adjustments:

- gradio 6 removed `Chatbot(type=...)`, renamed `resizeable` to `resizable` and moved
  `theme` from `Blocks` to `launch()`, so the stock `create_app` raises a TypeError.
  `create_app` below adapts those arguments for the duration of the call. (smolagents
  1.26 rebuilt the UI on `ChatInterface` and runs on gradio 6 as is.)
- The chat no longer treats a single `$` as a math delimiter: in answers about data it
  is a currency sign, and "$1.33M ... $1.11M" rendered as one italic formula.
- Uploads accept data files; the stock list is .pdf/.docx/.txt.
- matplotlib figures a step leaves open become that step's observation images: the chat
  shows them inline (the stock UI folds them under "Output Image"), and the model sees
  them on its next step.

Model-written code runs in this process, as in the benchmark, so the agent can read
any file this process can: keep the default 127.0.0.1 bind. Every browser tab drives
the same agent, so this is a single-user tool.

Usage, from the repository root with the gateway up (bin/local-dev.sh):
    .venv/bin/python bin/smolagents_ui.py [--model claude-sonnet-5.5] [--data-dir DIR]
"""

import argparse
import io
import os
from pathlib import Path

import matplotlib

# Agent code runs on gradio's worker threads, where a GUI backend cannot draw.
matplotlib.use("Agg")
import gradio as gr  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from dotenv import load_dotenv  # noqa: E402
from PIL import Image  # noqa: E402
from smolagents import CodeAgent, GradioUI, OpenAIServerModel  # noqa: E402
from smolagents.memory import ActionStep  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]

AUTHORIZED_IMPORTS = ["pandas.*", "numpy.*", "scipy.*", "sklearn.*", "statsmodels.*", "matplotlib.*",
                      "seaborn.*", "json", "csv"]
UPLOAD_SUFFIXES = [".csv", ".tsv", ".json", ".jsonl", ".parquet", ".xlsx", ".xls", ".txt", ".pdf", ".docx"]


def show_figures(step: ActionStep) -> None:
    """Move the figures the step left open into its observation images."""
    images = []
    for number in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(number).savefig(buffer, format="png", dpi=100, bbox_inches="tight")
        images.append(Image.open(buffer).convert("RGB"))
    plt.close("all")
    if images:
        step.observations_images = (step.observations_images or []) + images


def instructions(data_dir: Path | None) -> str:
    text = ("To show a chart, draw it with matplotlib and leave the figure open: after your step the "
            "user sees every open figure, and so do you, as an image. Do not call plt.close().")
    if data_dir:
        files = "\n".join(f"- {path}" for path in sorted(data_dir.resolve().rglob("*")) if path.is_file())
        text += f"\n\nData files you can read, by absolute path:\n{files}"
    return text


class DataAnalysisUI(GradioUI):
    """smolagents 1.23's GradioUI, on gradio 6, taking data files."""

    def create_app(self):
        chatbot, blocks = gr.Chatbot, gr.Blocks

        def gradio6_chatbot(*args, **kwargs):
            kwargs.pop("type", None)  # gradio 6 speaks only the messages format
            kwargs["resizable"] = kwargs.pop("resizeable", True)
            kwargs["latex_delimiters"] = [d for d in kwargs.get("latex_delimiters", []) if d["left"] != "$"]
            return chatbot(*args, **kwargs)

        def gradio6_blocks(*args, **kwargs):
            kwargs.pop("theme", None)  # passed to launch() instead
            return blocks(*args, **kwargs)

        gr.Chatbot, gr.Blocks = gradio6_chatbot, gradio6_blocks
        try:
            return super().create_app()
        finally:
            gr.Chatbot, gr.Blocks = chatbot, blocks

    def interact_with_agent(self, prompt, messages, session_state):
        for history in super().interact_with_agent(prompt, messages, session_state):
            for message in history:
                # Without a title the image is a plain message, shown instead of folded away.
                if isinstance(message, gr.ChatMessage) and "Output Image" in message.metadata.get("title", ""):
                    del message.metadata["title"]
            yield history

    def upload_file(self, file, file_uploads_log, allowed_file_types=None):
        return super().upload_file(file, file_uploads_log, allowed_file_types or UPLOAD_SUFFIXES)


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve smolagents' chat UI as a data-analysis agent.")
    parser.add_argument("--model", default="claude-sonnet-5.5", help="a model id the gateway serves")
    parser.add_argument("--data-dir", type=Path, help="list the files under DIR in the agent's instructions")
    parser.add_argument("--upload-dir", type=Path, default=REPO_ROOT / "logs" / "smolagents-ui" / "uploads")
    parser.add_argument("--max-steps", type=int, default=20, help="code steps per message (smolagents' default)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7860)
    args = parser.parse_args()

    # Credentials as bin/local-dev.sh reads them: the repo-root .env, shell-exported values first.
    load_dotenv(REPO_ROOT / ".env")
    gateway = os.environ.get("LITELLM_BASE_URL", "http://localhost:4000").rstrip("/") + "/v1"
    model = OpenAIServerModel(model_id=args.model, api_base=gateway, api_key=os.environ["LITELLM_MASTER_KEY"])
    agent = CodeAgent(
        tools=[],
        model=model,
        additional_authorized_imports=AUTHORIZED_IMPORTS,
        instructions=instructions(args.data_dir),
        max_steps=args.max_steps,
        stream_outputs=True,
        step_callbacks=[show_figures],
        name="data_analyst",
        description=f"smolagents `CodeAgent` on `{args.model}` through {gateway}",
    )
    DataAnalysisUI(agent, file_upload_folder=str(args.upload_dir)).launch(
        share=False, theme="ocean", server_name=args.host, server_port=args.port)


if __name__ == "__main__":
    main()
