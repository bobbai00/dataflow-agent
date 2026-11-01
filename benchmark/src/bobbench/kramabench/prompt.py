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
"""What a KramaBench task's system sees and how its answer is read: the task prompt with its file list and format hint,
and the answer parser (KramaBench's harness wording, kept byte for byte).

The file list is the task's data sources expanded against the workload's input folder, as paths relative to the
KramaBench root (the agent's engine and the Script ReAct sandbox both resolve `data/<workload>/input/...` there).
"""
import json
import os
import re

# The task's last line. With the arm setting answerOnlyReply the line itself asks for the answer alone: Opus 5.5 kept a
# report above the line when only the system prompt said so, and dropped it when the line did (10 replayed PrepBench
# replies: 388 to 157 output tokens, same answers).
ANSWER_LINE = "Your last line MUST BE: **Final Answer: <value>**"
ANSWER_ONLY_LINE = "Your reply MUST BE exactly one line, with nothing before or after it: **Final Answer: <value>**"
# Script ReAct answers through smolagents' final_answer tool: a "Final Answer:" text line contradicts its protocol (the
# model writes the line as text, smolagents rejects it as a parsing error, and Luna ran to the 25-step cap in 45% of
# tasks).
SCRIPT_LAST_LINE = ("When you have the answer, return it by calling `final_answer(<value>)` "
                    "in your code, with the value in the answer format above.")


def task_prompt(query, paths, hint, last_line):
    return f"""You are a data scientist. Answer the following question based on the data files.

Data files available (use these paths to read the data):
{json.dumps(paths, indent=2)}

Note: All paths are relative. Some paths may contain wildcards (e.g., "folder/*" or "file-*.csv"). Use glob patterns to match and read those files.

Question: {query}

Answer format: {hint}

{last_line}"""


def answer_only(prompt):
    """The prompt with its answer line asking for the answer alone (arm setting answerOnlyReply)."""
    assert prompt.count(ANSWER_LINE) == 1, "Answer line drift"
    return prompt.replace(ANSWER_LINE, ANSWER_ONLY_LINE)


def format_hints(path):
    """{task id: format hint} from a format-hint file ({} when there is none)."""
    if not os.path.exists(path):
        return {}
    with open(path) as stream:
        return {hint["id"]: hint.get("format_hint", "") for hint in json.load(stream)}


def dataset_files(directory):
    """Every file under a workload's input folder, relative to it, in os.walk order."""
    return [os.path.relpath(os.path.join(folder, name), directory)
            for folder, _, names in os.walk(directory) for name in names]


def file_paths(subset, dataset_directory, files, root):
    """The task's data sources as paths relative to `root`: exact names (found by name or fuzzily when not at their
    path), folders and wildcards (their folder found by name), "./" for every file; duplicates dropped in order. A task
    without data sources gets the whole folder as one recursive wildcard."""
    if not subset:
        return [os.path.relpath(dataset_directory, root) + "/**/*"]
    relative = []
    for pattern in subset:
        if pattern in ("", "./", "."):
            relative.extend(files)
        elif "*" in pattern or "?" in pattern:
            relative.append(_resolve_wildcard(pattern, files, dataset_directory))
        elif pattern.endswith("/"):
            relative.append(_resolve_wildcard(pattern + "*", files, dataset_directory))
        else:
            relative.extend(_search(pattern, files, dataset_directory) or [pattern])
    return list(dict.fromkeys(os.path.relpath(os.path.join(dataset_directory, p), root) for p in relative))


def _normalized(text):
    return text.lower().replace(" ", "_").replace("-", "_")


def _resolve_wildcard(pattern, files, dataset_directory):
    """`folder/*.csv` with its folder found by name (spaces, dashes and case ignored) when it is not at that path."""
    parts = pattern.rsplit("/", 1)
    if len(parts) == 1:
        return pattern
    folder, wildcard = parts
    if os.path.isdir(os.path.join(dataset_directory, folder)):
        return pattern
    name = os.path.basename(folder)
    found = set()
    for f in files:
        components = os.path.dirname(f).split("/") if os.path.dirname(f) else []
        for i, part in enumerate(components):
            if part == name or _normalized(part) == _normalized(name):
                found.add("/".join(components[:i + 1]))
    return f"{sorted(found)[0]}/{wildcard}" if found else pattern


def _search(pattern, files, dataset_directory):
    """The files a name without wildcards means: the path itself (a folder's files), else by basename, path suffix,
    fuzzy basename or fuzzy substring."""
    exact = os.path.join(dataset_directory, pattern)
    if os.path.exists(exact):
        if os.path.isdir(exact):
            return [f for f in files if f.startswith(pattern + "/") or f.startswith(pattern + os.sep)]
        return [pattern]
    basename = os.path.basename(pattern)
    matched = []
    for f in files:
        name = os.path.basename(f)
        if (name == basename or f.endswith(pattern) or f.endswith("/" + pattern)
                or _normalized(basename) == _normalized(name) or _normalized(pattern) in _normalized(f)):
            matched.append(f)
    return matched


def parse_answer(response):
    """The answer in a reply: the last `Final Answer:` line (Markdown and a repeated label stripped, a trailing period
    dropped, a JSON list kept as is); else the value after a marker ("final answer", "answer:", "the answer is",
    "result:"); else a bold number; else the last plain line."""
    if not response:
        return "No response from agent"
    matches = re.findall(r'\*?\*?Final Answer:\*?\*?\s*(.+?)(?:\n|$)', response, re.IGNORECASE)
    if matches:
        answer = matches[-1].strip()
        while True:
            cleaned = re.sub(r'^\*\*|\*\*$', '', answer).strip()
            cleaned = re.sub(r'^\*?\*?Final Answer:\*?\*?\s*', '', cleaned, flags=re.IGNORECASE).strip()
            if cleaned == answer:
                break
            answer = cleaned
        answer = re.sub(r'^`|`$', '', answer).strip()
        if answer.startswith('[') and answer.endswith(']'):
            return answer
        return answer.rstrip('.')
    lower = response.lower()
    for marker in ["final answer", "answer:", "the answer is", "result:"]:
        if marker in lower:
            after = response[lower.find(marker) + len(marker):]
            array = re.search(r'(\[.*?\])', after, re.DOTALL)
            if array:
                try:
                    json.loads(array.group(1))
                    return array.group(1)
                except json.JSONDecodeError:
                    pass
            number = re.search(r'[*_`:\s]*(-?[\d,]+\.?\d*)[*_`]*', after)
            if number and number.group(1) and number.group(1).replace(',', ''):
                return number.group(1).replace(',', '')
            for line in (line.strip() for line in after.split('\n') if line.strip()):
                if line.startswith('#') or line.startswith('-'):
                    continue
                cleaned = re.sub(r'[*_`]', '', line).strip()
                if cleaned:
                    return cleaned
    number = re.search(r'\*\*(-?[\d,]+\.?\d*)\*\*', response)
    if number:
        return number.group(1).replace(',', '')
    for line in reversed([line.strip() for line in response.strip().split('\n') if line.strip()]):
        if not line.startswith('#') and not line.startswith('-'):
            cleaned = re.sub(r'[*_`]', '', line).strip()
            if cleaned:
                return cleaned
    return response.strip()


def parse_explicit_answer(value):
    """An answer given through an explicit channel (smolagents' final_answer): cleaned like a `Final Answer:` line,
    without parse_answer's free-text search, which keeps only the last line and drops every `_`, `*` and backtick."""
    text = " ".join(str(value).split())
    if not text:
        return parse_answer("")
    if re.search(r"final answer:", text, re.IGNORECASE):
        return parse_answer(text)
    return parse_answer(f"Final Answer: {text}")
