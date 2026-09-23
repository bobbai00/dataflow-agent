#
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
#

"""Parse a native dataflow program into a neutral JSON syntax tree.

The model writes the dataflow as a Python-subset program: top-level `def`
functions and one `name = operator(...)` assignment per operator. This module
only parses that surface with the standard library's `ast`; it never imports
pandas, never executes anything, and knows nothing about operator semantics.
The TypeScript catalog decides which operators exist and what their arguments
mean. Keeping the two apart means a syntax error is reported here with a line
number, and an argument error is reported there against the catalog.

Values are encoded as small tagged objects:

    {"kind": "const",  "value": 3}                literals, incl. None/True/-2.5
    {"kind": "list",   "items": [...], "tuple": bool}
    {"kind": "dict",   "entries": [[key, value], ...]}   keys are string constants
    {"kind": "name",   "name": "roman_cities"}    a table, dtype or function reference
    {"kind": "call",   "name": "mean", "args": [...], "kwargs": {...}, "source": "mean('x')"}
    {"kind": "lambda", "params": ["row"], "body": "row['x'] > 0", "source": "lambda row: ..."}

`**{...}` in a call spreads a dict of string keys into the keywords, which is
how a column whose name is not an identifier is addressed by keyword.
"""

import ast
import json
import sys


class ProgramError(Exception):
    def __init__(self, line, message, column=None):
        super().__init__(message)
        self.line = line
        self.column = column
        self.message = message


def _segment(program, node):
    text = ast.get_source_segment(program, node)
    return text if text is not None else ""


def _encode(program, node):
    if isinstance(node, ast.Constant):
        value = node.value
        if isinstance(value, (bytes, complex)) or type(value) is type(Ellipsis):
            raise ProgramError(node.lineno, f"Unsupported literal {_segment(program, node)!r}.", node.col_offset)
        return {"kind": "const", "value": value}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        inner = _encode(program, node.operand)
        if inner["kind"] == "const" and isinstance(inner["value"], (int, float)) and not isinstance(inner["value"], bool):
            return {"kind": "const", "value": -inner["value"] if isinstance(node.op, ast.USub) else inner["value"]}
        raise ProgramError(node.lineno, f"Unsupported expression {_segment(program, node)!r}.", node.col_offset)
    if isinstance(node, (ast.List, ast.Tuple)):
        return {
            "kind": "list",
            "items": [_encode(program, item) for item in node.elts],
            "tuple": isinstance(node, ast.Tuple),
        }
    if isinstance(node, ast.Dict):
        entries = []
        for key, value in zip(node.keys, node.values):
            if key is None or not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
                raise ProgramError(node.lineno, "Dictionary keys must be string literals.", node.col_offset)
            entries.append([key.value, _encode(program, value)])
        return {"kind": "dict", "entries": entries}
    if isinstance(node, ast.Name):
        return {"kind": "name", "name": node.id}
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise ProgramError(
                node.lineno,
                f"Only plain function names may be called here, not {_segment(program, node.func)!r}.",
                node.col_offset,
            )
        args, kwargs = _arguments(program, node)
        return {"kind": "call", "name": node.func.id, "args": args, "kwargs": kwargs, "source": _segment(program, node)}
    if isinstance(node, ast.Lambda):
        params = node.args
        if params.vararg or params.kwarg or params.kwonlyargs or params.defaults or params.posonlyargs:
            raise ProgramError(node.lineno, "A lambda here takes plain positional parameters only.", node.col_offset)
        return {
            "kind": "lambda",
            "params": [arg.arg for arg in params.args],
            "body": _segment(program, node.body),
            "source": _segment(program, node),
        }
    raise ProgramError(node.lineno, f"Unsupported expression {_segment(program, node)!r}.", node.col_offset)


def _arguments(program, call):
    args = []
    for item in call.args:
        if isinstance(item, ast.Starred):
            raise ProgramError(item.lineno, "Star arguments are not supported; list the tables explicitly.", item.col_offset)
        args.append(_encode(program, item))
    kwargs = {}
    for keyword in call.keywords:
        if keyword.arg is None:
            # `**{"Acres Burned": float64}` — addresses columns whose names are not identifiers.
            spread = _encode(program, keyword.value)
            if spread["kind"] != "dict":
                raise ProgramError(keyword.value.lineno, "`**` must spread a dictionary literal.", keyword.value.col_offset)
            for key, value in spread["entries"]:
                if key in kwargs:
                    raise ProgramError(keyword.value.lineno, f"Keyword {key!r} is given twice.", keyword.value.col_offset)
                kwargs[key] = value
        else:
            if keyword.arg in kwargs:
                raise ProgramError(keyword.value.lineno, f"Keyword {keyword.arg!r} is given twice.", keyword.value.col_offset)
            kwargs[keyword.arg] = _encode(program, keyword.value)
    return args, kwargs


def parse_program(program):
    try:
        tree = ast.parse(program)
    except SyntaxError as error:
        return {"ok": False, "error": {"line": error.lineno or 1, "column": error.offset, "message": error.msg}}
    functions = {}
    statements = []
    try:
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                if node.decorator_list:
                    raise ProgramError(node.lineno, "Decorators are not supported.", node.col_offset)
                if node.name in functions:
                    raise ProgramError(node.lineno, f"Function {node.name!r} is defined twice.", node.col_offset)
                functions[node.name] = {
                    "name": node.name,
                    "params": [arg.arg for arg in node.args.posonlyargs + node.args.args],
                    "source": _segment(program, node),
                    "line": node.lineno,
                }
                continue
            if isinstance(node, ast.AsyncFunctionDef):
                raise ProgramError(node.lineno, "Functions must be synchronous `def`s.", node.col_offset)
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                continue  # a docstring-style comment
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                raise ProgramError(
                    node.lineno,
                    "Top-level imports are not allowed; import inside the function that needs the package.",
                    node.col_offset,
                )
            if isinstance(node, ast.Assign):
                if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
                    raise ProgramError(
                        node.lineno, "Assign each operator to exactly one plain name: `name = operator(...)`.", node.col_offset
                    )
                call = node.value
                if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
                    raise ProgramError(
                        node.lineno,
                        f"The right-hand side of {node.targets[0].id!r} must be an operator call such as `filter(...)`.",
                        node.col_offset,
                    )
                args, kwargs = _arguments(program, call)
                statements.append(
                    {
                        "id": node.targets[0].id,
                        "op": call.func.id,
                        "line": node.lineno,
                        "endLine": node.end_lineno,
                        "source": _segment(program, node),
                        "args": args,
                        "kwargs": kwargs,
                    }
                )
                continue
            raise ProgramError(
                node.lineno,
                "Only `name = operator(...)` assignments and `def` functions are allowed at the top level.",
                node.col_offset,
            )
    except ProgramError as error:
        return {"ok": False, "error": {"line": error.line, "column": error.column, "message": error.message}}
    return {"ok": True, "statements": statements, "functions": functions}


if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(json.dumps(parse_program(request["program"]), ensure_ascii=True))
