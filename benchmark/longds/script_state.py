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
"""What a script agent's code did to its session's variables, and the context
built from chosen variables: the script's counterpart of a dataflow's tables.

One interpreter serves a whole smolagents session, so a variable's value is
whatever every earlier code action did to its name: assignments, in-place
changes (`df['x'] = ...`, `df.drop(..., inplace=True)`, `rows.append(...)`)
and functions that read it when they run. `statements` splits a code action
into its top-level statements and records, for each, the names it writes, the
names it replaces outright and the names it reads. `upstream` walks back from
chosen variables to every earlier statement that made them, as a dataflow's
upstream walks a table's inputs. It reads the code only, so changes made
through aliases or inside functions are missed, and the result is a lower
bound of what made a value.

The interpreter reports its variables after every request (`describe` in
smolagents_worker.py); `variable_tasks` turns those snapshots into what each
task created and changed, `render_variable_index` into the index a model picks
variables from, and `render_variable_context` into the block a request is
shown instead of the earlier requests.
"""
import ast
from dataclasses import dataclass

from benchmark.longds.selection import answer_preview

# Methods that change the object they are called on. A pandas method changes
# its frame only with `inplace=True`, which is checked separately.
MUTATORS = frozenset({
    "append", "extend", "insert", "pop", "popitem", "remove", "clear", "update", "setdefault", "add", "discard",
    "sort", "reverse", "difference_update", "intersection_update", "symmetric_difference_update",
})
LIST_LIMIT = 25


@dataclass(frozen=True)
class Statement:
    task: int
    step: int
    source: str
    kind: str  # "import", "def" or "code"
    writes: frozenset  # names whose value it sets or changes
    kills: frozenset  # names it replaces outright: their earlier values stop mattering
    reads: frozenset  # names it reads, including globals a function it defines reads when called
    failed: bool = False  # its code action stopped with an error, so it may not have run


def _base(node):
    """The variable at the root of `a`, `a.b`, `a[0]` or `a.b[0].c`."""
    while isinstance(node, (ast.Attribute, ast.Subscript, ast.Starred)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


class _Names(ast.NodeVisitor):
    """Names a piece of module-level code writes and reads. Function bodies,
    lambdas and comprehensions have their own scopes: only the outer names
    they read count."""

    def __init__(self):
        self.writes, self.reads = set(), set()

    def visit_Name(self, node):
        (self.reads if isinstance(node.ctx, ast.Load) else self.writes).add(node.id)

    def _store(self, target):
        if isinstance(target, ast.Name):
            self.writes.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for element in target.elts:
                self._store(element)
        elif isinstance(target, ast.Starred):
            self._store(target.value)
        else:  # a[...] = or a.b = changes `a` in place, and reads it
            base = _base(target)
            if base:
                self.writes.add(base)
                self.reads.add(base)
            self.visit(target)

    def visit_Assign(self, node):
        self.visit(node.value)
        for target in node.targets:
            self._store(target)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            self.visit(node.value)
            self._store(node.target)

    def visit_AugAssign(self, node):
        self.visit(node.value)
        self._store(node.target)
        base = _base(node.target)
        if base:
            self.reads.add(base)

    def visit_For(self, node):
        self.visit(node.iter)
        self._store(node.target)
        for child in node.body + node.orelse:
            self.visit(child)

    visit_AsyncFor = visit_For

    def visit_withitem(self, node):
        self.visit(node.context_expr)
        if node.optional_vars is not None:
            self._store(node.optional_vars)

    def visit_Delete(self, node):
        for target in node.targets:
            self._store(target)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Attribute):
            base = _base(node.func.value)
            in_place = any(k.arg == "inplace" and isinstance(k.value, ast.Constant) and k.value.value is True
                           for k in node.keywords)
            if base and (node.func.attr in MUTATORS or in_place):
                self.writes.add(base)
        self.generic_visit(node)

    def _scope(self, node, own):
        """An inner scope: the outer names it reads, without its own names."""
        inner = _Names()
        for child in own:
            inner.visit(child)
        params = set()
        args = getattr(node, "args", None)
        if isinstance(args, ast.arguments):
            params = {a.arg for a in args.posonlyargs + args.args + args.kwonlyargs}
            params |= {a.arg for a in (args.vararg, args.kwarg) if a}
            for default in args.defaults + [d for d in args.kw_defaults if d is not None]:
                self.visit(default)
        self.reads |= inner.reads - inner.writes - params

    def visit_FunctionDef(self, node):
        for decorator in node.decorator_list:
            self.visit(decorator)
        self.writes.add(node.name)
        self._scope(node, node.body)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        for expression in node.bases + node.decorator_list:
            self.visit(expression)
        self.writes.add(node.name)
        self._scope(node, node.body)

    def visit_Lambda(self, node):
        self._scope(node, [node.body])

    def _comprehension(self, node, parts):
        inner = _Names()
        targets = set()
        for generator in node.generators:
            inner.visit(generator.iter)
            for leaf in ast.walk(generator.target):
                if isinstance(leaf, ast.Name):
                    targets.add(leaf.id)
            for condition in generator.ifs:
                inner.visit(condition)
        for part in parts:
            inner.visit(part)
        self.reads |= inner.reads - targets
        self.writes |= inner.writes - targets  # a walrus inside binds an outer name

    def visit_ListComp(self, node):
        self._comprehension(node, [node.elt])

    visit_SetComp = visit_GeneratorExp = visit_ListComp

    def visit_DictComp(self, node):
        self._comprehension(node, [node.key, node.value])

    def visit_Import(self, node):
        for alias in node.names:
            self.writes.add(alias.asname or alias.name.split(".")[0])

    def visit_ImportFrom(self, node):
        for alias in node.names:
            self.writes.add(alias.asname or alias.name)


def _killed(node):
    """Names a top-level statement replaces outright: `x = ...` and `del x`
    (not `x[0] = ...`, `x += ...` or an assignment inside a branch or loop)."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return {node.name}
    if isinstance(node, (ast.Import, ast.ImportFrom)):
        return {alias.asname or alias.name.split(".")[0] for alias in node.names}
    targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else \
        [node.target] if isinstance(node, ast.AnnAssign) and node.value is not None else []
    out = set()
    for target in targets:
        stack = [target]
        while stack:
            leaf = stack.pop()
            if isinstance(leaf, ast.Name):
                out.add(leaf.id)
            elif isinstance(leaf, (ast.Tuple, ast.List)):
                stack.extend(leaf.elts)
            elif isinstance(leaf, ast.Starred):
                stack.append(leaf.value)
    return out


def _reads(node):
    names = _Names()
    names.visit(node)
    return names.reads


def _bound(target):
    return {leaf.id for leaf in ast.walk(target) if isinstance(leaf, ast.Name) and isinstance(leaf.ctx, ast.Store)}


def _exposed(body, defined=frozenset()):
    """Names a block reads before it sets them itself: a loop's variable, or a
    temporary assigned earlier in the same body, is not an outside read.
    Assignments inside a branch or loop may not run, so they define nothing
    for the statements after it."""
    defined, out = set(defined), set()
    for node in body:
        if isinstance(node, (ast.For, ast.AsyncFor)):
            out |= _reads(node.iter) - defined
            out |= _exposed(node.body, defined | _bound(node.target)) | _exposed(node.orelse, defined)
        elif isinstance(node, (ast.While, ast.If)):
            out |= _reads(node.test) - defined
            out |= _exposed(node.body, defined) | _exposed(node.orelse, defined)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            bound = set()
            for item in node.items:
                out |= _reads(item.context_expr) - defined
                if item.optional_vars is not None:
                    bound |= _bound(item.optional_vars)
            out |= _exposed(node.body, defined | bound)
        elif isinstance(node, ast.Try) or type(node).__name__ == "TryStar":
            out |= _exposed(node.body, defined)
            for handler in node.handlers:
                if handler.type is not None:
                    out |= _reads(handler.type) - defined
                out |= _exposed(handler.body, defined | ({handler.name} if handler.name else set()))
            out |= _exposed(node.orelse, defined) | _exposed(node.finalbody, defined)
        else:
            out |= _reads(node) - defined
            defined |= _killed(node)
    return out


def statements(code, task, step, failed=False):
    """The top-level statements of one code action, in order."""
    try:
        tree = ast.parse(code or "")
    except SyntaxError:
        return []
    out = []
    for node in tree.body:
        names = _Names()
        names.visit(node)
        kind = "import" if isinstance(node, (ast.Import, ast.ImportFrom)) else \
            "def" if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) else "code"
        out.append(Statement(task=task, step=step, source=ast.get_source_segment(code, node) or ast.unparse(node),
                             kind=kind, writes=frozenset(names.writes), kills=frozenset(_killed(node)),
                             reads=frozenset(_exposed([node])), failed=failed))
    return out


def trace_statements(steps, task):
    """A request's statements from its step trace (smolagents_session's steps.json)."""
    out, number = [], 0
    for step in steps:
        if step.get("type") != "action" or not step.get("code_action"):
            continue
        number += 1
        out += statements(step["code_action"], task, number, failed=bool(step.get("error")))
    return out


def imported(earlier):
    return {name for s in earlier if s.kind == "import" for name in s.writes}


def upstream(earlier, names):
    """The earlier statements that made `names`, in order. Walking back from
    the last one, a statement that writes a needed name is kept; the names it
    replaces outright stop being needed (unless its code action failed, when
    it may not have run) and the names it reads become needed. A function
    reads its globals when it is called, so a statement that calls one also
    needs what the function (and the functions it calls) read. Imported names
    are the interpreter's, not state."""
    modules = imported(earlier)
    defs = {}
    for index, statement in enumerate(earlier):
        if statement.kind == "def":
            for name in statement.kills:
                defs.setdefault(name, []).append(index)

    def called(index, names):
        out, pending, seen = set(), list(names & defs.keys()), set()
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            latest = max((j for j in defs[name] if j < index), default=None)
            if latest is not None:
                out |= earlier[latest].reads
                pending += list(earlier[latest].reads & defs.keys())
        return out

    needed = set(names) - modules
    kept = []
    for index in range(len(earlier) - 1, -1, -1):
        statement = earlier[index]
        if statement.kind == "import":
            continue
        hit = needed & statement.writes
        if not hit:
            continue
        kept.append(statement)
        if not statement.failed:
            needed -= hit & statement.kills
        needed |= (statement.reads | called(index, statement.reads)) - modules
    return kept[::-1]


def earlier_reads(own, earlier):
    """The earlier variables a request's own statements read before they set them themselves."""
    known = {name for s in earlier if s.kind != "import" for name in s.writes}
    mine, out = set(), set()
    for statement in own:
        out |= (statement.reads - mine) & known
        mine |= statement.kills
    return out


# ---------------------------------------------------------------------------
# What each task left in the interpreter


def variable_tasks(snapshots):
    """Per task: the variables it created and changed (by fingerprint) and the
    functions it defined, from the interpreter's snapshots after each task.
    Also each variable's task of origin and the last task that changed it."""
    out, origin, changed, previous, functions_seen = {}, {}, {}, {}, set()
    for task in sorted(snapshots):
        now = snapshots[task].get("variables", {})
        created, updated = [], []
        for name, info in now.items():
            if name not in previous:
                created.append(name)
                origin.setdefault(name, task)
                changed[name] = task
            elif previous[name].get("fingerprint") != info.get("fingerprint"):
                updated.append(name)
                changed[name] = task
        functions = [f for f in snapshots[task].get("functions", {}) if f not in functions_seen]
        functions_seen |= set(functions)
        out[task] = {"created": created, "changed": updated, "functions": functions}
        previous = now
    return out, origin, changed


def shape_text(info):
    kind, shape = info.get("type", "?"), info.get("shape")
    if isinstance(shape, list) and len(shape) == 2:
        return f"{kind} {shape[0]:,} × {shape[1]:,}"
    if isinstance(shape, int):
        return f"{kind}, {shape:,} items"
    return kind


def _listed(items):
    items = list(dict.fromkeys(items))
    shown = items[:LIST_LIMIT]
    return ", ".join(shown) + (f", +{len(items) - LIST_LIMIT} more" if len(items) > LIST_LIMIT else "")


def render_variable_index(texts, answers, upto, snapshots):
    """The index of tasks 1 .. upto-1 with the variables each created or
    changed, in the dataflow index's layout (selection.render_index)."""
    tasks, _, _ = variable_tasks({t: s for t, s in snapshots.items() if t < upto})
    lines = []
    for task in range(1, upto):
        lines.append(f"Task {task}: {texts[task]}")
        lines.append(f"  answer: {answer_preview(answers.get(task, ''))}")
        info, now = tasks.get(task, {}), snapshots.get(task, {}).get("variables", {})
        if info.get("created"):
            lines.append(f"  variables created: {_listed(f'{n} ({shape_text(now[n])})' for n in info['created'])}")
        if info.get("changed"):
            lines.append(f"  variables changed: {_listed(f'{n} ({shape_text(now[n])})' for n in info['changed'])}")
        if info.get("functions"):
            lines.append(f"  functions defined: {_listed(info['functions'])}")
    return "\n".join(lines)


def _fence(code):
    ticks = 3
    while "`" * ticks in code:
        ticks += 1
    return "`" * ticks


def render_variable_context(instructions, texts, answers, snapshots, picked, rendered, made):
    """The block a request sees instead of the earlier requests: the session's
    instructions, every variable in the interpreter (one line each, by the task
    that created it), the picked variables with their current values, and the
    earlier statements that made them (`upstream`)."""
    upto = max(snapshots) + 1 if snapshots else 1
    tasks, origin, changed = variable_tasks(snapshots)
    now = snapshots[max(snapshots)].get("variables", {}) if snapshots else {}
    functions = snapshots[max(snapshots)].get("functions", {}) if snapshots else {}
    sections = [
        "## Context for this request",
        "Earlier requests are not shown. Below are the session's instructions, every variable the earlier "
        "requests left in the interpreter, the variables picked for this request with their current values, and "
        "the earlier code that made them. Every variable still exists: use any of them by name, and print any "
        "that is not shown.",
        f"### Session instructions (task 1)\n{instructions}",
    ]
    listed = {}
    for name, info in now.items():
        listed.setdefault(origin.get(name, upto - 1), []).append(f"`{name}` {shape_text(info)}")
    defined, function_origin = {}, {}
    for task in sorted(tasks):
        for function in tasks[task]["functions"]:
            function_origin.setdefault(function, task)
            if function in functions:
                defined.setdefault(task, []).append(f"`{function}{functions[function]}`")
    if listed or defined:
        lines = []
        for task in sorted(set(listed) | set(defined)):
            parts = listed.get(task, []) + ([f"functions {', '.join(defined[task])}"] if task in defined else [])
            lines.append(f"- task {task}: " + "; ".join(parts))
        sections.append("### Variables in the interpreter\n" + "\n".join(lines))
    present = [name for name in dict.fromkeys(picked) if name in now or name in functions]
    missing = [name for name in dict.fromkeys(picked) if name not in present]
    groups = {}
    for name in present:
        groups.setdefault(origin.get(name) or function_origin.get(name, 1), []).append(name)
    detail = []
    for task in sorted(groups):
        lines = [f"#### Task {task}"]
        if task != 1:
            lines.append(f"asked: {texts.get(task, '')}")
        lines.append(f"answered: {answer_preview(answers.get(task, ''))}")
        for name in groups[task]:
            if name in functions and name not in now:
                lines.append(f"- function `{name}{functions[name]}` (its code is below)")
                continue
            note = f" (last changed in task {changed[name]})" if changed.get(name, task) != task else ""
            lines.append(f"- `{name}`{note}")
            lines += [f"  {line}" for line in (rendered.get(name) or shape_text(now[name])).splitlines()]
        detail.append("\n".join(lines))
    sections.append("### Variables picked for this request\n" + ("\n\n".join(detail) if detail else "None.") +
                    (f"\nNot in the interpreter: {', '.join(f'`{n}`' for n in missing)}." if missing else ""))
    if made:
        blocks, current = [], None
        for statement in made:
            key = (statement.task, statement.step)
            if key != current:
                label = f"#### Task {statement.task}, step {statement.step}" + \
                    (" (this step stopped with an error)" if statement.failed else "")
                blocks.append([label, []])
                current = key
            blocks[-1][1].append(statement.source)
        code = []
        for label, sources in blocks:
            body = "\n".join(sources)
            fence = _fence(body)
            code.append(f"{label}\n{fence}python\n{body}\n{fence}")
        sections.append("### The earlier code that made them\nOnly the statements that made the picked variables, "
                        "and the statements those read from, in the order they ran.\n\n" + "\n\n".join(code))
    return "\n\n".join(sections)
