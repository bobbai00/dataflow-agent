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

"""Parse explicit graph commands and operator-local Python without executing it."""
import ast
import io
import keyword
import re
import tokenize
from program_parser import parse_program

ID = r"[A-Za-z_][A-Za-z0-9_]*"
ENDPOINT = rf"({ID})\.({ID}(?:\[\d+\])?)"


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
                        and re.match(r"^(create|update|modify|delete) (operator|edge)\b", lines[token.start[0] - 1].lstrip())):
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
            edge = re.fullmatch(rf"(create|delete) edge {ENDPOINT}\s*->\s*{ENDPOINT}", text)
            if deletion:
                commands.append(dict(operation="delete_operator", id=deletion[1], line=start))
            elif edge:
                verb, source_id, source_port, target_id, target_port = edge.groups()
                commands.append(dict(operation=f"{verb}_edge", source=source_id, sourcePort=source_port,
                                     target=target_id, targetPort=target_port, line=start))
            else:
                raise ValueError(
                    f"Line {start}: use create/update/delete operator, create/delete edge, "
                    "update operator <id> from task <N>, or fork operator <id> from task <N> as <new_id>. "
                    "Edges cannot be updated."
                )
        return dict(ok=True, commands=commands)
    except (ValueError, SyntaxError, tokenize.TokenError, IndentationError) as error:
        return dict(ok=False, error=str(error))
