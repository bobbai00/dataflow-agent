# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Two source-level services for the operators a model defines (catalog.ts,
"Your operators"). Nothing here executes code.

`lift`: rewrite an existing `def` so that chosen literals in its body become
parameters whose defaults are those literals, and its docstring says `{name}`
where it said the literal. The result is the function form of a registered
operator: the same code, callable with other values.

`near_duplicates`: for each new def, the existing def it is mostly the same as
(60% of the token stream or more, literals and numbers abstracted) and whether
the difference is names only, literals only, or structure. The receipt turns
that into the call or the lift that would have replaced the new def.
"""
import ast
import difflib
import io
import tokenize


class LiftError(ValueError):
    pass


def _function(source, name):
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise LiftError(f"{name} does not parse: {str(error).split(chr(10))[0]}.") from error
    defs = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name]
    if len(defs) != 1:
        raise LiftError(f"No single def {name} in its source.")
    return defs[0]


def _offsets(data):
    """Byte offset of the start of each line (AST columns are UTF-8 bytes)."""
    starts = [0]
    for index, byte in enumerate(data):
        if byte == 0x0A:
            starts.append(index + 1)
    return starts


def _span(starts, node):
    return starts[node.lineno - 1] + node.col_offset, starts[node.end_lineno - 1] + node.end_col_offset


def _same_literal(node, value):
    if not isinstance(node, ast.Constant):
        return False
    if value is None or isinstance(value, bool):
        return node.value is value
    if isinstance(node.value, bool):
        return False
    if isinstance(value, (int, float)):
        return isinstance(node.value, (int, float)) and node.value == value and (
            isinstance(value, float) == isinstance(node.value, float)
        )
    return isinstance(node.value, str) and node.value == value


def _constants(body, skip_docstring):
    """Constant nodes of the body outside f-strings (their parts are not
    replaceable text) and outside the docstring."""
    found = []

    def walk(node, in_fstring=False):
        if isinstance(node, ast.JoinedStr):
            in_fstring = True
        if isinstance(node, ast.Constant) and not in_fstring:
            found.append(node)
        for child in ast.iter_child_nodes(node):
            walk(child, in_fstring)

    for index, statement in enumerate(body):
        if index == 0 and skip_docstring:
            continue
        walk(statement)
    return found


def _docstring_node(node):
    first = node.body[0] if node.body else None
    if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
        return first
    return None


def _literal_text(value):
    if isinstance(value, bool) or value is None:
        return repr(value)
    if isinstance(value, (int, float)):
        return repr(value)
    return repr(value)


def lift(source, name, params, new_name=None, doc=None):
    """Return the lifted def's source. `params` maps each new parameter name to
    the literal it replaces (str, int, float, bool or None)."""
    node = _function(source, name)
    args = node.args
    if args.vararg or args.kwarg or args.posonlyargs or any(d is None for d in args.kw_defaults):
        raise LiftError(f"{name} has variadic or positional-only parameters; an operator's parameters are bound by name.")
    existing = [arg.arg for arg in args.args + args.kwonlyargs]
    for parameter in params:
        if not parameter.isidentifier() or parameter in ("doc",):
            raise LiftError(f"{parameter!r} is not a usable parameter name.")
        if parameter in existing:
            raise LiftError(f"{name} already has a parameter {parameter}.")
    data = source.encode("utf-8")
    starts = _offsets(data)
    docstring = _docstring_node(node)
    constants = _constants(node.body, docstring is not None)
    edits = []  # (start, end, replacement bytes)
    for parameter, value in params.items():
        if not (value is None or isinstance(value, (str, int, float, bool))):
            raise LiftError(f"The value of {parameter} must be a string, number, True/False or None.")
        matches = [c for c in constants if _same_literal(c, value)]
        if not matches:
            raise LiftError(f"The body of {name} holds no literal {_literal_text(value)} to turn into {parameter}.")
        for constant in matches:
            edits.append((*_span(starts, constant), parameter.encode()))
    # The signature: append `parameter=literal` after the last parameter.
    header_end = None
    for item in [*args.args, *args.defaults, *args.kwonlyargs, *[d for d in args.kw_defaults if d is not None]]:
        end = _span(starts, item)[1]
        annotation = getattr(item, "annotation", None)
        if annotation is not None:
            end = max(end, _span(starts, annotation)[1])
        header_end = end if header_end is None else max(header_end, end)
    additions = ", ".join(f"{parameter}={_literal_text(value)}" for parameter, value in params.items())
    if header_end is None:
        paren = data.index(b"(", starts[node.lineno - 1] + node.col_offset)
        edits.append((paren + 1, paren + 1, additions.encode()))
    else:
        edits.append((header_end, header_end, (", " + additions).encode()))
    # The docstring: the literal's text becomes {parameter}; a def without a
    # docstring needs one now, because the doc is what a call renders.
    if docstring is not None:
        text = docstring.value.value
        for parameter, value in params.items():
            needle = value if isinstance(value, str) else _literal_text(value)
            if needle and needle in text:
                text = text.replace(needle, "{" + parameter + "}")
        if doc:
            text = doc
        start, end = _span(starts, docstring.value)
        edits.append((start, end, ('"""' + text.replace('"""', "'''") + '"""').encode()))
    else:
        if not doc:
            raise LiftError(
                f"{name} has no docstring; give doc=... (one sentence over the parameters, e.g. "
                + '"One row per {' + next(iter(params)) + '} ...").'
            )
        first = node.body[0]
        indent = b" " * first.col_offset
        line_start = starts[first.lineno - 1]
        edits.append((line_start, line_start, indent + ('"""' + doc.replace('"""', "'''") + '"""\n').encode()))
    # The name.
    if new_name and new_name != name:
        if not new_name.isidentifier():
            raise LiftError(f"{new_name!r} is not a valid operator name.")
        head = starts[node.lineno - 1] + node.col_offset
        at = data.index(name.encode(), head + len(b"def"))
        edits.append((at, at + len(name.encode()), new_name.encode()))
    out = bytearray(data)
    for start, end, replacement in sorted(edits, key=lambda e: (e[0], e[1]), reverse=True):
        out[start:end] = replacement
    result = out.decode("utf-8")
    ast.parse(result)  # The rewrite must still parse; a failure here is a bug, not the model's.
    return result


# ---------------------------------------------------------------------------
# Near duplicates
# ---------------------------------------------------------------------------

def _tokens(source):
    """The token stream with literals abstracted: ('STR', text) and ('NUM',
    text) keep their text for the diff report; names and operators are kept
    as written; layout tokens by type. None when the source does not tokenize."""
    out = []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.STRING:
                out.append(("STR", tok.string))
            elif tok.type == tokenize.NUMBER:
                out.append(("NUM", tok.string))
            elif tok.type == tokenize.NAME:
                out.append(("NAME", tok.string))
            elif tok.type == tokenize.OP:
                out.append(("OP", tok.string))
            elif tok.type in (tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT):
                out.append(("LAYOUT", tok.type))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return None
    return out


def _body_tokens(source, name):
    tokens = _tokens(source)
    if tokens is None:
        return None
    # The def's own name is not a difference.
    return [("NAME", "<self>") if t == ("NAME", name) else t for t in tokens]


def _compare(a, b):
    """('names' | 'literals' | 'structure', ratio, differences)."""
    shape = lambda tokens: [t[1] if t[0] in ("OP", "NAME", "LAYOUT") else t[0] for t in tokens]  # noqa: E731
    ratio = difflib.SequenceMatcher(None, shape(a), shape(b)).ratio()
    if len(a) == len(b) and all(x[0] == y[0] for x, y in zip(a, b)):
        # A docstring is the doc, not a literal of the code.
        literal_diffs = [
            (x[1], y[1])
            for x, y in zip(a, b)
            if x[0] in ("STR", "NUM") and x[1] != y[1] and not x[1].lstrip("rRbBuU").startswith(('"""', "'''"))
        ]
        other_diffs = [(x[1], y[1]) for x, y in zip(a, b) if x[0] not in ("STR", "NUM") and x != y]
        if not other_diffs:
            differences = []
            for pair in literal_diffs:
                if pair not in differences:
                    differences.append(pair)
            return ("literals" if differences else "names", ratio, differences)
        if not literal_diffs and all(x[0] == "NAME" for x, y in zip(a, b) if x != y):
            return ("names", ratio, [])
    return ("structure", ratio, [])


def near_duplicates(candidates, existing, threshold=0.6):
    """For each candidate def (name -> source) the closest existing def (name ->
    source) when it is at least `threshold` similar in structure: {name,
    existing, ratio, kind, differences}."""
    results = []
    parsed_existing = []
    for name, source in existing.items():
        tokens = _body_tokens(source, name)
        if tokens is not None:
            parsed_existing.append((name, source, tokens))
    for name, source in candidates.items():
        tokens = _body_tokens(source, name)
        if tokens is None:
            continue
        best = None
        for other, other_source, other_tokens in parsed_existing:
            if other == name or other_source == source:
                continue
            quick = difflib.SequenceMatcher(None, [t[0] for t in tokens], [t[0] for t in other_tokens]).quick_ratio()
            if quick < threshold:
                continue
            kind, ratio, differences = _compare(other_tokens, tokens)
            if ratio >= threshold and (best is None or ratio > best["ratio"]):
                best = {"name": name, "existing": other, "ratio": round(ratio, 2), "kind": kind, "differences": differences[:6]}
        if best:
            results.append(best)
    return results


def serve(request):
    if "lift" in request:
        item = request["lift"]
        try:
            return {"ok": True, "source": lift(item["source"], item["name"], item["params"], item.get("as"), item.get("doc"))}
        except LiftError as error:
            return {"ok": False, "message": str(error)}
    if "nearDuplicates" in request:
        item = request["nearDuplicates"]
        return {"ok": True, "matches": near_duplicates(item["candidates"], item["existing"], item.get("threshold", 0.6))}
    raise ValueError("unknown request")
