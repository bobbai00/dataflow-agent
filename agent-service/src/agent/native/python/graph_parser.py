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

    name = operator(input, ..., setting=value)   create `name` or replace its definition
    name = shared_fn(input, ..., setting=value)  call a shared function as an operator
    name = name@N                                restore the definition saved at task N
    copy = name@N                                copy it with its saved inputs
    def shared_fn(table, setting=default):       define or redefine a shared function
        \"\"\"What each call produces, with {setting}.\"\"\"
    del name, ...                                delete operators

`name@N` may also be an input: `shift = diff(scores@2, scores, ...)`. Python
under an assignment, indented, belongs to that operator only. The earlier
command form (`create operator x: ...`, `create edge a.out -> b.in`) still
parses, so recorded edits replay; new edits use assignments."""
import ast
import io
import keyword
import re
import tokenize
from program_parser import parse_program

ID = r"[A-Za-z_][A-Za-z0-9_]*"
REFERENCE = rf"{ID}(?:@[1-9]\d*)?"
SOURCE_ENDPOINT = rf"({REFERENCE})\.({ID}(?:\[\d+\])?)"
ENDPOINT = rf"({ID})\.({ID}(?:\[\d+\])?)"
LEGACY = re.compile(r"^(create|update|modify|delete|fork) (operator|edge)\b")
SAVED = "__saved_"


def _unclosed(source):
    """The line of the innermost bracket still open when the edit ends."""
    opened = []
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.OP and token.string in "([{":
                opened.append(token.start[0])
            elif token.type == tokenize.OP and token.string in ")]}" and opened:
                opened.pop()
    except (tokenize.TokenError, SyntaxError):
        pass
    return opened[-1] if opened else None


def _parse_error(error, source):
    """A parse failure as one sentence that names the line to fix."""
    if isinstance(error, tokenize.TokenError) and len(error.args) == 2:
        message, (line, _) = error.args
        if "string" in message:
            return f"Line {line}: this string is never closed; end it with the quote that opened it."
        opened = _unclosed(source)
        return (f"Line {opened or line}: this bracket is never closed, so the edit ends inside the "
                "statement; close every (, [ and { before the next statement.")
    return str(error)


def _margin_blocks(source):
    """(first line, lines) per statement: a block starts at every margin token
    outside brackets, and indented lines belong to the block above."""
    lines = source.splitlines()
    starts, depth = [], 0
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
        raise ValueError(f"Line {stray}: start each statement at the margin; indent only Python "
                         "functions under the operator that uses them.")
    return [(start, lines[start - 1:(starts[i + 1] - 1 if i + 1 < len(starts) else len(lines))])
            for i, start in enumerate(starts)]


def _saved_references(text):
    """`name@N` is a saved version. Python reads it as a matrix product, so it
    is renamed to a placeholder before parsing and mapped back afterwards."""
    tokens = list(tokenize.generate_tokens(io.StringIO(text).readline))
    lines = text.splitlines(keepends=True)
    references, edits = {}, []
    for i in range(len(tokens) - 2):
        a, at, n = tokens[i], tokens[i + 1], tokens[i + 2]
        if (a.type == tokenize.NAME and at.type == tokenize.OP and at.string == "@"
                and n.type == tokenize.NUMBER and re.fullmatch(r"[1-9]\d*", n.string)):
            placeholder = f"{SAVED}{a.string}__{n.string}"
            references[placeholder] = f"{a.string}@{n.string}"
            edits.append((a.start, n.end, placeholder))
    for (row, col), (end_row, end_col), placeholder in reversed(edits):
        if row != end_row:
            continue
        line = lines[row - 1]
        lines[row - 1] = line[:col] + placeholder + line[end_col:]
    return "".join(lines), references


def _literal(node, line, name):
    try:
        return ast.literal_eval(node)
    except ValueError:
        raise ValueError(f"Line {line}: the default of `{name}` must be a literal such as 0.5, \"desc\" or [1, 2].")


def _function_meta(source, line=1):
    """A shared function's tables, settings with their defaults, and docstring."""
    tree = ast.parse(source)
    node = tree.body[0]
    args = node.args
    if node.decorator_list or args.vararg or args.kwarg or args.kwonlyargs or args.posonlyargs:
        raise ValueError(f"Line {line}: write `def {node.name}(table, ..., setting=default, ...)` without "
                         "decorators, *args, **kwargs or keyword-only parameters.")
    names = [a.arg for a in args.args]
    tables = names[:len(names) - len(args.defaults)]
    settings = {a: _literal(d, line, a) for a, d in zip(names[len(tables):], args.defaults)}
    return dict(name=node.name, tables=tables, settings=settings, doc=ast.get_docstring(node),
                source=source.strip("\n"), line=line)


def _definition_block(start, block):
    text = "\n".join(block)
    try:
        tree = ast.parse(text)
    except SyntaxError as error:
        raise ValueError(f"Line {start + (error.lineno or 1) - 1}: {error.msg}") from error
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise ValueError(f"Line {start}: a shared function is one `def` at the margin with its body indented.")
    meta = _function_meta(text, start)
    return dict(operation="define_function", id=meta["name"], **meta)


def _assignment_block(start, block):
    head = block[0]
    frozen = re.match(rf"^({ID})@[1-9]\d*\.({ID})\s*=(?!=)", head)
    if frozen:
        raise ValueError(f"Line {start}: a saved version never changes; set `{frozen[1]}.{frozen[2]}` on the current table.")
    target = re.match(rf"^({ID})\s*=(?!=)", head)
    if target and keyword.iskeyword(target[1]):
        raise ValueError(f"Line {start}: `{target[1]}` is a Python keyword and cannot name an operator; "
                         f"rename it (for example `{target[1]}_data`).")
    text = "\n".join(block)
    tokens = list(tokenize.generate_tokens(io.StringIO(text + "\n").readline))
    end = next(t.start[0] for t in tokens if t.type in (tokenize.NEWLINE, tokenize.ENDMARKER))
    statement, implementation = "\n".join(block[:end]), block[end:]
    meaningful = [line for line in implementation if line.strip() and not line.lstrip().startswith("#")]
    if meaningful and not re.match(r"\s*def ", meaningful[0]):
        line = start + block.index(meaningful[0])
        raise ValueError(f"Line {line}: start each statement at the margin; indent only Python functions "
                         "under the operator that uses them.")
    statement, references = _saved_references(statement)
    try:
        node = ast.parse(statement).body[0]
    except SyntaxError as error:
        raise ValueError(f"Line {start + (error.lineno or 1) - 1}: {error.msg}") from error
    if isinstance(node, ast.Delete):
        if not all(isinstance(t, ast.Name) for t in node.targets) or meaningful:
            raise ValueError(f"Line {start}: `del` takes operator names only: `del name, other`.")
        return [dict(operation="delete_operator", id=t.id, line=start) for t in node.targets]
    if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute)
            and isinstance(node.targets[0].value, ast.Name)):
        owner, setting = node.targets[0].value.id, node.targets[0].attr
        if owner in references:
            raise ValueError(f"Line {start}: a saved version never changes; set `{references[owner].split('@')[0]}.{setting}` "
                             "on the current table.")
        if meaningful:
            raise ValueError(f"Line {start}: a setting takes a value, not functions.")
        try:
            value = ast.literal_eval(node.value)
        except ValueError:
            raise ValueError(f"Line {start}: `{owner}.{setting}` takes a literal value such as 0.5, \"desc\" or [1, 2].")
        return [dict(operation="set_setting", id=owner, setting=setting, value=value, line=start)]
    if not (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)):
        raise ValueError(f"Line {start}: write `name = operator(inputs, ...)`, `name = other`, `name = name@N`, "
                         "`name.setting = value`, a `def` at the margin, or `del name`.")
    name = node.targets[0].id
    value = node.value
    if isinstance(value, ast.Name) and value.id in references:
        if meaningful:
            raise ValueError(f"Line {start}: a saved version takes no functions.")
        source_id, task = references[value.id].split("@")
        return [dict(operation="assign_version", id=name, sourceId=source_id, task=int(task), line=start)]
    if isinstance(value, ast.Name):
        if meaningful:
            raise ValueError(f"Line {start}: `{name} = {value.id}` takes no functions.")
        if value.id == name:
            raise ValueError(f"Line {start}: `{name} = {name}` changes nothing.")
        return [dict(operation="commit", id=name, other=value.id, line=start)]
    if not isinstance(value, ast.Call) or not isinstance(value.func, ast.Name):
        raise ValueError(f"Line {start}: the right-hand side of `{name}` must be an operator or shared-function "
                         "call, such as `filter(orders, ...)`.")
    width = len(meaningful[0]) - len(meaningful[0].lstrip()) if meaningful else 0
    functions = "\n".join(line[width:] if line.startswith(" " * width) else line for line in implementation)
    parsed = parse_program(f"{statement}\n{functions}")
    if parsed["errors"]:
        error = parsed["errors"][0]
        raise ValueError(f"Line {start + error['line'] - 1}: {error['message']}")
    if len(parsed["statements"]) != 1:
        raise ValueError(f"Line {start}: one assignment, followed only by its indented functions.")
    return [dict(operation="assign_operator", id=name, line=start, statement=parsed["statements"][0],
                 functions=parsed["functions"],
                 positional=[ast.get_source_segment(statement, arg) for arg in value.args],
                 keywords=[ast.get_source_segment(statement, kw) for kw in value.keywords],
                 references=references)]


def edit_blocks(source):
    """The statements of an edit, each with the names it sets and the names it
    mentions, so that one failing statement and those using it can be held
    back while the rest apply."""
    try:
        blocks = _margin_blocks(source)
    except (ValueError, SyntaxError, tokenize.TokenError, IndentationError):
        lines = source.splitlines()
        starts = [n for n, line in enumerate(lines, start=1)
                  if re.match(rf"(def\s|del\s|{ID}(\.{ID})?\s*=(?!=))", line)]
        blocks = [(start, lines[start - 1:(starts[i + 1] - 1 if i + 1 < len(starts) else len(lines))])
                  for i, start in enumerate(starts)]
    result = []
    for start, block in blocks:
        text = "\n".join(block)
        head = block[0]
        if head.startswith("del "):
            sets = re.findall(ID, head[4:])
        else:
            match = re.match(rf"def\s+({ID})", head) or re.match(rf"({ID})(?:\.{ID})?\s*=(?!=)", head)
            sets = [match[1]] if match else []
        try:
            names = {t.string for t in tokenize.generate_tokens(io.StringIO(text + "\n").readline)
                     if t.type == tokenize.NAME}
        except (tokenize.TokenError, IndentationError, SyntaxError):
            names = set(re.findall(rf"\b{ID}\b", re.sub(r"(\"[^\"\n]*\"|'[^'\n]*')", "", text)))
        uses = sorted(names - set(sets) - set(keyword.kwlist))
        result.append(dict(line=start, end=start + len(block) - 1, text=text, sets=sets, uses=uses))
    return result


def parse_graph_edit(source, shared=None):
    """Assignments, shared functions and deletions; recorded command edits
    take the command path. `shared` maps the graph's shared functions to their
    source, so their tables, settings and docstrings come back with the edit."""
    try:
        meta = {name: _function_meta(text) for name, text in (shared or {}).items()}
        blocks = _margin_blocks(source)
        if not blocks:
            raise ValueError("An edit needs at least one statement: `name = operator(...)`, a `def`, or `del name`.")
        legacy = [LEGACY.match(block[0]) is not None for _, block in blocks]
        if all(legacy):
            result = parse_graph_changes(source)
            return {**result, "syntax": "commands", "shared_functions": meta}
        if any(legacy):
            line = next(start for (start, _), old in zip(blocks, legacy) if old)
            raise ValueError(f"Line {line}: write the whole edit as assignments: `name = operator(inputs, ...)` "
                             "creates or replaces an operator, its inputs come first in the call, and `del name` "
                             "deletes one.")
        commands = []
        for start, block in blocks:
            if block[0].startswith("def "):
                commands.append(_definition_block(start, block))
            elif block[0].startswith(("@", "async def ")):
                raise ValueError(f"Line {start}: shared functions are plain `def`s without decorators.")
            else:
                commands.extend(_assignment_block(start, block))
        return dict(ok=True, commands=commands, syntax="assignments", shared_functions=meta)
    except (ValueError, SyntaxError, tokenize.TokenError, IndentationError) as error:
        return dict(ok=False, error=_parse_error(error, source))


def parse_graph_changes(source):
    try:
        lines = source.splitlines()
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
        starts = []
        depth = indent = 0
        for token in tokens:
            if token.type == tokenize.INDENT:
                indent += 1
            elif token.type == tokenize.DEDENT:
                indent -= 1
            elif token.type not in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT, tokenize.ENDMARKER):
                if (not depth and indent and token.type == tokenize.NAME
                        and re.match(r"^(create|update|modify|delete|fork) (operator|edge)\b", lines[token.start[0] - 1].lstrip())):
                    raise ValueError(
                        f"Line {token.start[0]}: start graph commands without indentation; indent only attached Python functions."
                    )
                if not depth and not indent and token.start[1] == 0:
                    starts.append(token.start[0])
                if token.type == tokenize.OP:
                    if token.string in "([{":
                        depth += 1
                    elif token.string in ")]}":
                        depth -= 1
        starts = sorted(set(starts))
        if not starts:
            raise ValueError("An edit needs at least one graph command.")
        commands = []
        for index, start in enumerate(starts):
            end = starts[index + 1] - 1 if index + 1 < len(starts) else len(lines)
            block = lines[start - 1:end]
            heading = block[0]
            operator = re.match(rf"^(create|update|modify) operator ({ID}):\s*(.*)$", heading)
            if operator:
                verb, identifier, first = operator.groups()
                if keyword.iskeyword(identifier):
                    raise ValueError(
                        f"Line {start}: `{identifier}` is a Python keyword and cannot be an operator identifier; "
                        f"rename it (for example `{identifier}_data`) and use that name in its edge endpoints."
                    )
                # Replay saved graph edits without exposing the old spelling in
                # new prompts or receipts.
                if verb == "modify":
                    verb = "update"
                newline = next(t for t in tokens if t.type == tokenize.NEWLINE and t.start[0] >= start)
                expression_lines = [first, *lines[start:newline.start[0]]]
                expression = "\n".join(expression_lines).strip()
                implementation = lines[newline.start[0]:end]
                meaningful = next((line for line in implementation if line.strip() and not line.lstrip().startswith("#")), "")
                width = len(meaningful) - len(meaningful.lstrip())
                if meaningful and width == 0:
                    raise ValueError(f"Line {start}: indent Python functions under their operator.")
                functions = "\n".join(line[width:] if line.startswith(" " * width) else line for line in implementation)
                definition = f"{identifier} = {expression}\n{functions}"
                try:
                    tree = ast.parse(definition)
                except SyntaxError as error:
                    raise ValueError(f"Line {start + (error.lineno or 1) - 1}: {error.msg}") from error
                if not isinstance(tree.body[0], ast.Assign) or any(not isinstance(node, ast.FunctionDef) for node in tree.body[1:]):
                    raise ValueError(f"Line {start}: one operator expression, followed only by its indented function definitions.")
                parsed = parse_program(definition)
                if parsed["errors"] or len(parsed["statements"]) != 1:
                    message = parsed["errors"][0]["message"] if parsed["errors"] else "Expected one operator expression."
                    raise ValueError(f"Line {start}: {message}")
                commands.append(dict(operation=f"{verb}_operator", id=identifier, expression=expression,
                                     statement=parsed["statements"][0], functions=parsed["functions"], line=start))
                continue
            text = "\n".join(block).strip()
            # Comments may follow a one-line command, but no extra statements.
            text = re.sub(r"(?m)#.*$", "", text).strip()
            deletion = re.fullmatch(rf"delete operator ({ID})", text)
            restoration = re.fullmatch(rf"update operator ({ID}) from task (\d+)", text)
            definition_copy = re.fullmatch(rf"(create|update) operator ({ID}) from ({ID})@([1-9]\d*)", text)
            fork = re.fullmatch(rf"fork operator ({ID}) from task (\d+) as ({ID})", text)
            edge = re.fullmatch(rf"(create|delete) edge {SOURCE_ENDPOINT}\s*->\s*{ENDPOINT}", text)
            if definition_copy:
                commands.append(dict(operation="copy_definition", id=definition_copy[2],
                                     sourceId=definition_copy[3], task=int(definition_copy[4]),
                                     create=definition_copy[1] == "create", line=start))
            elif restoration:
                commands.append(dict(operation="restore_operator", id=restoration[1], task=int(restoration[2]), line=start))
            elif fork:
                commands.append(dict(operation="fork_operator", id=fork[1], task=int(fork[2]), **{"as": fork[3]}, line=start))
            elif deletion:
                commands.append(dict(operation="delete_operator", id=deletion[1], line=start))
            elif edge:
                verb, source_id, source_port, target_id, target_port = edge.groups()
                commands.append(dict(operation=f"{verb}_edge", source=source_id, sourcePort=source_port,
                                     target=target_id, targetPort=target_port, line=start))
            else:
                raise ValueError(
                    f"Line {start}: use create/update/delete operator, create/delete edge, "
                    "create/update operator <id> from <saved_id>@<N>. "
                    "Edges cannot be updated."
                )
        return dict(ok=True, commands=commands)
    except (ValueError, SyntaxError, tokenize.TokenError, IndentationError) as error:
        return dict(ok=False, error=_parse_error(error, source))
