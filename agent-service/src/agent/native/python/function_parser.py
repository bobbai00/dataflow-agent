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
"""Select an ordinary Python callback using syntax only; never execute it."""
import ast
import json
import sys


def parse_function(code, entry):
    tree = ast.parse(code, filename="<operator>", mode="exec")
    compile(tree, "<operator>", "exec")
    if len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Lambda):
        if entry not in (None, "apply"):
            raise ValueError("A lambda uses entry 'apply'; request inferred selection or name 'apply'.")
        callback = tree.body[0].value
        function = ast.FunctionDef(name="apply", args=callback.args, body=[ast.Return(value=callback.body)], decorator_list=[])
        code = ast.unparse(ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[])))
        return {"code": code, "entry": "apply"}
    functions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    if entry is None:
        if len(functions) != 1:
            raise ValueError("Set entry to a top-level function name when the module has multiple or no functions.")
        entry = functions[0].name
    matches = [node for node in functions if node.name == entry]
    if len(matches) != 1:
        raise ValueError(f"entry {entry!r} must select exactly one top-level function.")
    if isinstance(matches[0], ast.AsyncFunctionDef):
        raise ValueError("The entry must be a synchronous function; async callbacks are unsupported.")
    return {"code": code, "entry": entry}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)["pythonFunction"]
        result = {"ok": True, **parse_function(request["code"], request.get("entry"))}
    except SyntaxError as error:
        result = {"ok": False, "error": f"Python syntax error at line {error.lineno}: {error.msg}"}
    except (ValueError, TypeError, KeyError) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result))
