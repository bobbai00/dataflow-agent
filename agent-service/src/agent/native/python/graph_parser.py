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

"""Parse a graph edit without executing it.

An edit is a sequence of statements, each starting at the margin:

    name = operator(input, ..., parameter=value, ...)   create or replace `name`
        def helper(...):                                 its Python, indented under it
    del name, ...                                        delete operators

Input tables are the leading positional names of the call; the catalog
decides how many there are, so this parser returns every argument's source
text and leaves the split to the caller."""
import ast
import io
import keyword
import re
import tokenize
from program_parser import parse_program

ID = r"[A-Za-z_][A-Za-z0-9_]*"
COMMAND = re.compile(rf"^(create|update|modify|delete|fork) (operator|edge)\b")
ASSIGNMENT = re.compile(rf"^({ID})\s*=(?!=)")


def _command_hint(line):
    if " from task " in line:
        return ("write `name = at(name, task=N)` to restore a saved definition in place, "
                "or `new_name = at(name, task=N)` to copy it with its saved inputs.")
    operator = re.match(rf"^(?:create|update|modify) operator ({ID}):\s*(\w+)\(", line)
    if operator:
        return (f"write `{operator[1]} = {operator[2]}(...)`: an assignment creates or replaces an operator, "
                "and its input tables, if any, come first in the call.")
    if line.startswith("delete operator"):
        return "write `del name` to delete an operator."
    return ("edges follow from inputs: name the source table in the consumer's call, for example "
            "`total = aggregate(orders, ...)`, and restate the consumer to change them.")


def _blocks(source):
    """Statement blocks as (first_line, lines): a block starts at every
    margin token outside brackets; indented lines belong to the block above."""
    lines = source.splitlines()
    starts = []
    depth = 0
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT, tokenize.ENDMARKER,
                          tokenize.INDENT, tokenize.DEDENT):
            continue
        if not depth and token.start[1] == 0:
            starts.append(token.start[0])
        if token.type == tokenize.OP:
            if token.string in "([{":
                depth += 1
            elif token.string in ")]}":
                depth -= 1
    starts = sorted(set(starts))
    first = starts[0] if starts else len(lines) + 1
    stray = next((n for n, line in enumerate(lines[:first - 1], start=1)
                  if line.strip() and not line.lstrip().startswith("#")), None)
    if stray:
        raise ValueError(f"Line {stray}: start each statement at the margin; "
                         "indent only Python functions under the operator that uses them.")
    return [(start, lines[start - 1:(starts[i + 1] - 1 if i + 1 < len(starts) else len(lines))])
            for i, start in enumerate(starts)]


def _statement(start, block):
    head = block[0]
    if COMMAND.match(head):
        raise ValueError(f"Line {start}: graph commands are not supported; {_command_hint(head)}")
    target = ASSIGNMENT.match(head)
    if target and keyword.iskeyword(target[1]):
        raise ValueError(f"Line {start}: `{target[1]}` is a Python keyword and cannot name an operator; "
                         f"rename it (for example `{target[1]}_data`).")
    text = "\n".join(block)
    # The statement ends at its first logical newline; the rest is its Python.
    tokens = list(tokenize.generate_tokens(io.StringIO(text + "\n").readline))
    end = next(t.start[0] for t in tokens if t.type in (tokenize.NEWLINE, tokenize.ENDMARKER))
    statement, implementation = "\n".join(block[:end]), block[end:]
    meaningful = [line for line in implementation if line.strip() and not line.lstrip().startswith("#")]
    if meaningful and not re.match(r"\s*(def|async def|@)", meaningful[0]):
        line = start + block.index(meaningful[0])
        raise ValueError(f"Line {line}: start each statement at the margin; "
                         "indent only Python functions under the operator that uses them.")
    try:
        node = ast.parse(statement).body[0]
    except SyntaxError as error:
        raise ValueError(f"Line {start + (error.lineno or 1) - 1}: {error.msg}") from error
    if isinstance(node, ast.Delete):
        if not all(isinstance(t, ast.Name) for t in node.targets):
            raise ValueError(f"Line {start}: `del` takes operator names: `del name`.")
        if meaningful:
            raise ValueError(f"Line {start}: `del` takes no functions.")
        return dict(kind="delete", ids=[t.id for t in node.targets], line=start)
    if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute):
        raise ValueError(f"Line {start}: change a parameter by restating the whole definition: "
                         "`name = operator(inputs, ...)`.")
    if not isinstance(node, ast.Assign):
        raise ValueError(f"Line {start}: write `name = operator(inputs, ...)` or `del name`.")
    width = len(meaningful[0]) - len(meaningful[0].lstrip()) if meaningful else 0
    functions = "\n".join(line[width:] if line.startswith(" " * width) else line for line in implementation)
    parsed = parse_program(f"{statement}\n{functions}")
    if parsed["errors"]:
        error = parsed["errors"][0]
        raise ValueError(f"Line {start + error['line'] - 1}: {error['message']}")
    if len(parsed["statements"]) != 1:
        raise ValueError(f"Line {start}: one operator assignment, followed only by its indented functions.")
    call = node.value
    return dict(
        kind="assign",
        id=parsed["statements"][0]["id"],
        line=start,
        statement=parsed["statements"][0],
        functions=parsed["functions"],
        positional=[ast.get_source_segment(statement, arg) for arg in call.args],
        keywords=[ast.get_source_segment(statement, kw) for kw in call.keywords],
    )


def parse_graph_edit(source):
    try:
        blocks = _blocks(source)
        if not blocks:
            raise ValueError("An edit needs at least one statement: `name = operator(...)` or `del name`.")
        return dict(ok=True, statements=[_statement(start, block) for start, block in blocks])
    except (ValueError, SyntaxError, tokenize.TokenError, IndentationError) as error:
        return dict(ok=False, error=str(error))
