#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
#
"""Ordered definition replay and the registered-Python graph grammar.

The definition namespace is rebuilt for validation and for every invocation.
Only source cells and binding descriptions cross the subprocess boundary.
"""

REGISTERED_RESERVED = frozenset((
    "scan", "project", "cast", "aggregate", "join", "union", "distinct",
    "sort", "limit", "window", "unpivot", "pivot", "filter", "map", "process",
))


def _validate_definition_tree(tree):
    """Keep registration declarative; arbitrary computation belongs in functions.

    This guard is not a security sandbox: importing installed modules can run
    their initialization. It prevents authored top-level computations and writes
    from escaping a subsequently rejected graph transaction.
    """
    import ast

    def expression(node):
        if node is None:
            return
        if any(isinstance(part, (ast.Call, ast.NamedExpr, ast.Lambda, ast.Await,
                                 ast.Yield, ast.YieldFrom, ast.ListComp, ast.SetComp,
                                 ast.DictComp, ast.GeneratorExp)) for part in ast.walk(node)):
            raise ValueError("Definition initializers, defaults, and annotations cannot call functions; put computation inside an operator function.")

    def statement(node):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Pass)):
            return
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            return
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(any(isinstance(part, (ast.Attribute, ast.Subscript)) for part in ast.walk(target)) for target in targets):
                raise ValueError("Definition assignments may bind names, not mutate objects or imported modules.")
            expression(node.value)
            if isinstance(node, ast.AnnAssign):
                expression(node.annotation)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.decorator_list:
                raise ValueError("Definition-time decorators are not supported; put behavior inside the function.")
            for value in [*node.args.defaults, *node.args.kw_defaults, node.returns]:
                expression(value)
            for arg in [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                        *([node.args.vararg] if node.args.vararg else []),
                        *([node.args.kwarg] if node.args.kwarg else [])]:
                expression(arg.annotation)
            return
        if isinstance(node, ast.ClassDef):
            if node.bases or node.keywords or node.decorator_list:
                raise ValueError("Definition classes must be plain classes without bases, metaclasses, or decorators.")
            for child in node.body:
                statement(child)
            return
        raise ValueError("Definition cells contain imports, functions, plain classes, and constant assignments only; put execution inside functions.")

    for node in tree.body:
        statement(node)


def _registered_declarations(cells):
    import ast

    declarations = {}
    for index, cell in enumerate(cells):
        tree = ast.parse(cell, filename=f"<definitions:{index + 1}>")
        _validate_definition_tree(tree)
        for node in tree.body:
            names = []
            kind = "constant"
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names = [node.name]
                kind = "class" if isinstance(node, ast.ClassDef) else "function"
                if isinstance(node, ast.AsyncFunctionDef):
                    raise ValueError(f"{node.name}: async functions cannot be registered operators.")
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [alias.asname or alias.name.split('.')[0] for alias in node.names]
                if '*' in names:
                    raise ValueError("Wildcard imports are not supported in definition cells.")
                kind = "import"
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                names = [child.id for target in targets for child in ast.walk(target) if isinstance(child, ast.Name)]
            for name in names:
                if name in REGISTERED_RESERVED:
                    raise ValueError(f"{name!r} is a reserved operator name.")
                declarations[name] = {
                    "name": name, "kind": kind, "source": ast.get_source_segment(cell, node) or "",
                    "cell": index + 1,
                }
    return declarations


def registered_namespace(cells):
    import contextlib
    import inspect
    import os

    declarations = _registered_declarations(cells)
    scope = {"__name__": "__registered_operator__"}
    # Initializer output is not part of the JSON registration protocol or table.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        for index, cell in enumerate(cells):
            exec(compile(cell, f"<definitions:{index + 1}>", "exec"), scope)
    for name in REGISTERED_RESERVED:
        if name in scope:
            raise ValueError(f"{name!r} is a reserved operator name.")
    functions = {}
    for name, declaration in declarations.items():
        if declaration["kind"] != "function":
            continue
        function = scope.get(name)
        if not inspect.isfunction(function) or inspect.iscoroutinefunction(function):
            raise ValueError(f"{name!r} must remain a synchronous Python function.")
        functions[name] = {
            "name": name,
            "signature": str(inspect.signature(function)),
            "doc": inspect.getdoc(function) or "",
            "source": declaration["source"],
            "exported": not name.startswith("_"),
        }
    return scope, functions, declarations


def parse_registered_changes(source):
    import ast
    import math
    import re
    import tokenize
    from graph_parser import _blocks
    from program_parser import _encode

    statements = []
    seen = set()
    try:
        blocks = _blocks(source)
    except tokenize.TokenError as error:
        message, (line, _) = error.args
        raise ValueError(f"Changes line {line}: {message}") from error
    except SyntaxError as error:
        raise ValueError(f"Changes line {error.lineno}: {error.msg}") from error
    for line, block in blocks:
        text = "\n".join(block)
        deletion_text = "\n".join(part for part in block if part.strip() and not part.lstrip().startswith("#"))
        deletion = re.fullmatch(r"delete\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?", deletion_text.strip())
        if deletion:
            identifier = deletion[1]
            statement = {"kind": "delete", "id": identifier, "line": line}
        else:
            match = re.match(r"set\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*", text)
            if not match:
                raise ValueError(f"Line {line}: use set id: type(inputs, settings) or delete id.")
            identifier = match[1]
            expression = text[match.end():]
            try:
                node = ast.parse(expression, mode="eval").body
            except SyntaxError as error:
                error_line = line + text[:match.end()].count("\n") + (error.lineno or 1) - 1
                raise ValueError(f"Changes line {error_line}, operator {identifier}: {error.msg}") from error
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                raise ValueError(f"Line {line}: the definition must call an operator type by name.")
            if any(not isinstance(arg, ast.Name) for arg in node.args):
                raise ValueError(f"Line {line}: positional arguments must be input operator IDs; settings use keywords. "
                                 "Declare a nested call as its own set statement and pass its ID.")
            if any(kw.arg is None for kw in node.keywords):
                raise ValueError(f"Line {line}: keyword unpacking is not supported.")
            keys = [kw.arg for kw in node.keywords]
            if len(keys) != len(set(keys)):
                raise ValueError(f"Line {line}: a setting is supplied more than once.")
            for keyword in node.keywords:
                for value in ast.walk(keyword.value):
                    if isinstance(value, ast.Constant):
                        if type(value.value) is int and abs(value.value) > 2 ** 53 - 1:
                            raise ValueError(f"Line {line}: integer settings must be faithfully representable (within ±(2**53-1)).")
                        if type(value.value) is float and not math.isfinite(value.value):
                            raise ValueError(f"Line {line}: numeric settings must be finite.")
            statement = {
                "kind": "set", "id": identifier, "op": node.func.id, "line": line,
                "source": text, "inputs": [arg.id for arg in node.args],
                "kwargs": {kw.arg: _encode(expression, kw.value) for kw in node.keywords},
            }
        if identifier in seen:
            raise ValueError(f"Line {line}: operator {identifier!r} appears more than once in this edit.")
        if not identifier.isidentifier() or __import__('keyword').iskeyword(identifier):
            raise ValueError(f"Line {line}: invalid operator ID {identifier!r}.")
        seen.add(identifier)
        statements.append(statement)
    return statements


def registered_request(request):
    import inspect

    try:
        cells = request.get("cells", [])
        if request["phase"] == "parse":
            declarations = _registered_declarations(cells)
            try:
                statements = parse_registered_changes(request.get("changes", ""))
            except Exception as error:
                # The cells parsed: report what the rejected edit would have registered.
                return {"ok": False, "error": f"{type(error).__name__}: {error}", "declarations": declarations}
            return {"ok": True, "statements": statements, "declarations": declarations}
        scope, functions, bindings = registered_namespace(cells)
        for node in request.get("operators", []):
            name = node["entry"]
            if name not in functions or not functions[name]["exported"]:
                raise ValueError(f"{node['id']}: {name!r} is not a registered public function.")
            try:
                inspect.signature(scope[name]).bind(*[object() for _ in node["inputs"]], **node["settings"])
            except TypeError as error:
                raise ValueError(f"{node['id']}: invalid inputs/settings for {name}{functions[name]['signature']}: {error}") from error
        return {"ok": True, "functions": functions, "bindings": bindings}
    except Exception as error:
        return {"ok": False, "error": f"{type(error).__name__}: {error}"}


def registered_callable(spec):
    """Bind a fresh namespace once per operator invocation, never per row."""
    import copy
    import functools

    registration = spec["properties"]["registered"]
    scope, _, _ = registered_namespace(registration["cells"])
    return functools.partial(scope[registration["entry"]], **copy.deepcopy(registration["settings"]))


def execute_registered(spec, inputs):
    """Replay definitions afresh; mutable defaults and globals cannot leak runs."""
    return registered_callable(spec)(*inputs)
