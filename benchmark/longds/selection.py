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
"""Indexes of a session's earlier tasks, and a model call that selects from one.

An index describes each earlier task in a few lines, from what the agent
recorded while doing it:
- `texts`: the task's request text, the same for every agent;
- `answers`: the request text and a preview of the agent's answer;
- `script`: `answers`, plus the names the script's code assigned and the
  functions it defined, which is all a script records about its state;
- `dataflow`: `answers`, plus the tables the task created (`id = op(inputs)`
  with their row counts) and the earlier tasks those tables read from.

`select_tasks` asks a model which earlier tasks a new request builds on;
`select_tables` asks which tables (dataflow only). Steps are read in the
formats the runners save: run_session's react steps and
smolagents_session's step traces.
"""
import ast
import json
import re

SET = re.compile(r"^\s*set\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\((.*)\)\s*$", re.M)
IDENT = re.compile(r"\b[A-Za-z_]\w*\b")
LIST_LIMIT = 25


def request_text(prompt):
    """A request without the session preamble (before `[Task 1]`) or its own label."""
    return re.sub(r"^[\s\S]*?\[Task \d+\]\s*", "", prompt).strip()


def answer_preview(text, limit=240):
    """An answer at depth one: scalars, list lengths with the keys of their items, object keys."""
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        flat = re.sub(r"\s+", " ", text or "").strip()
        return flat[:limit - 1] + "…" if len(flat) > limit else flat

    def brief(v):
        if isinstance(v, list):
            if v and isinstance(v[0], dict):
                return f"[{len(v)} items × {{{', '.join(list(v[0])[:6])}}}]"
            items = ", ".join(json.dumps(x)[:30] for x in v[:3])
            return f"[{items}{', …' if len(v) > 3 else ''}]" if v else "[]"
        if isinstance(v, dict):
            return "{" + ", ".join(list(v)[:6]) + (", …" if len(v) > 6 else "") + "}"
        return json.dumps(v)[:40]

    text = ("{" + ", ".join(f"{json.dumps(k)}: {brief(v)}" for k, v in value.items()) + "}") if isinstance(value, dict) \
        else brief(value)
    return text[:limit - 1] + "…" if len(text) > limit else text


def _listed(names):
    names = list(dict.fromkeys(names))
    shown = names[:LIST_LIMIT]
    return ", ".join(shown) + (f", +{len(names) - LIST_LIMIT} more" if len(names) > LIST_LIMIT else "")


# ---------------------------------------------------------------------------
# What each agent recorded per task


def dataflow_tasks(steps_by_task):
    """Per task: the tables it created (id, operator, inputs, rows) and the earlier tasks they read."""
    origin, rows, out = {}, {}, {}
    for task in sorted(steps_by_task):
        created, built_on = [], set()
        for step in steps_by_task[task]:
            for result in step.get("toolResults") or []:
                for action in (result.get("output") or {}).get("actions", []):
                    if action["status"] != "ok":
                        continue
                    if action["action"]["type"] == "edit":
                        for oid, op, args in SET.findall(action["action"].get("changes") or ""):
                            inputs = [name for name in dict.fromkeys(IDENT.findall(args.split("lambda")[0]))
                                      if name in origin]
                            built_on |= {origin[name] for name in inputs if origin[name] < task}
                            if oid not in origin:
                                origin[oid] = task
                                created.append((oid, op, inputs))
                    elif action["action"]["type"] == "execute" and isinstance(action.get("output"), dict):
                        for operator in action["output"].get("operators", []):
                            if operator.get("rows") is not None:
                                rows[operator["id"]] = operator["rows"]
        out[task] = {"tables": [(oid, op, inputs, rows.get(oid)) for oid, op, inputs in created],
                     "built_on": sorted(built_on)}
    return out


def _script_names(tree):
    """Names a code block binds as results (assignments outside functions and loop headers), and its functions."""
    names, functions = [], []

    def visit(body):
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.append(node.name)
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    for leaf in ast.walk(target):
                        if isinstance(leaf, ast.Name) and isinstance(leaf.ctx, ast.Store):
                            names.append(leaf.id)
            for field in ("body", "orelse", "finalbody", "handlers"):
                inner = getattr(node, field, None)
                if isinstance(inner, list) and not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    visit(inner)

    visit(tree.body)
    return names, functions


def script_tasks(steps_by_task):
    """Per task: the names its code assigned and the functions it defined."""
    out = {}
    for task in sorted(steps_by_task):
        names, functions = [], []
        for step in steps_by_task[task]:
            code = step.get("code_action") if step.get("type") == "action" else None
            if not code:
                continue
            try:
                tree = ast.parse(code)
            except SyntaxError:
                continue
            n, f = _script_names(tree)
            names += n
            functions += f
        out[task] = {"names": list(dict.fromkeys(names)), "functions": list(dict.fromkeys(functions))}
    return out


# ---------------------------------------------------------------------------
# Indexes


def render_index(kind, texts, answers, upto, recorded=None):
    """The index of tasks 1 .. upto-1. `recorded` is dataflow_tasks or script_tasks output."""
    lines = []
    for task in range(1, upto):
        lines.append(f"Task {task}: {texts[task]}")
        if kind == "texts":
            continue
        lines.append(f"  answer: {answer_preview(answers.get(task, ''))}")
        info = (recorded or {}).get(task, {})
        if kind == "script":
            if info.get("names"):
                lines.append(f"  variables assigned: {_listed(info['names'])}")
            if info.get("functions"):
                lines.append(f"  functions defined: {_listed(info['functions'])}")
        elif kind == "dataflow":
            tables = [f"{oid} = {op}({', '.join(inputs)})" + (f" [{rows:,} rows]" if rows is not None else "")
                      for oid, op, inputs, rows in info.get("tables", [])]
            if tables:
                lines.append(f"  tables: {_listed(tables)}")
            if info.get("built_on"):
                lines.append(f"  built on: {', '.join(f'task {t}' for t in info['built_on'])}")
    return "\n".join(lines)


TASKS_PROMPT = """You choose the context for a data analyst who works through a long session of requests about the same data. Below are the session's earlier tasks, then a new request.

Pick the earlier tasks the new request builds on: those whose rules, tables or results must be in view to answer it. Leave out tasks it does not use. Answer with JSON only: {{"tasks": [task numbers]}}.

Earlier tasks:
{index}

New request:
{request}"""

TABLES_PROMPT = """You choose the context for a data analyst who works through a long session of requests about the same data. Below are the session's earlier tasks with the tables each created, then a new request.

Pick the earlier tables the new request builds on: those it reads or must compare with. Leave out tables it does not use. Answer with JSON only: {{"tables": [table names]}}.

Earlier tasks:
{index}

New request:
{request}"""


def _ask(client, model, prompt):
    response = client.chat.completions.create(model=model, messages=[{"role": "user", "content": prompt}])
    text = response.choices[0].message.content or ""
    usage = response.usage
    details = getattr(usage, "prompt_tokens_details", None)
    reasoning = getattr(getattr(usage, "completion_tokens_details", None), "reasoning_tokens", 0) or 0
    match = re.search(r"\{[\s\S]*\}", text)
    try:
        parsed = json.loads(match.group(0)) if match else {}
    except ValueError:
        parsed = {}
    return parsed, {"input_tokens": usage.prompt_tokens, "output_tokens": usage.completion_tokens,
                    "cached_tokens": getattr(details, "cached_tokens", 0) or 0, "reasoning_tokens": reasoning}, text


def select_tasks(client, model, index, request, upto):
    """Earlier task numbers the model picks (always within 1 .. upto-1), with its usage."""
    parsed, usage, text = _ask(client, model, TASKS_PROMPT.format(index=index, request=request))
    tasks = sorted({int(t) for t in parsed.get("tasks", []) if str(t).isdigit() and 1 <= int(t) < upto})
    return tasks, usage, text


def select_tables(client, model, index, request):
    parsed, usage, text = _ask(client, model, TABLES_PROMPT.format(index=index, request=request))
    return sorted({str(t) for t in parsed.get("tables", []) if isinstance(t, str)}), usage, text
