#!/usr/bin/env python3
"""
GRAIN SPLIT — pure. Cut a code operator where row identity changes, into a
chain of ordinary operators. Nothing injected: the model reads each stage as a
normal operator (its code, `Inputs: … (N rows)`, `Output Table: M rows`,
schema, stats, profile) in the existing LATEST / DELTA render.

Input (stdin, JSON):  {"code": str, "operatorId": str, "maxCuts": int}
Output (stdout, JSON): {"split": bool, "stages": [{"id","code","kind","inputs"}],
                        "checks": 0, "plan": [], "note": str}

Rule:
  * A GRAIN statement assigns a DataFrame produced by a row-changing operation:
    boolean-mask filter / .query / .dropna, .drop_duplicates, .merge / .join /
    pd.merge / pd.concat, .explode / .melt / .pivot, or a groupby-aggregate
    that yields a DataFrame (.reset_index() or as_index=False). Explicit row
    limits (.head/.tail/.nlargest/.nsmallest/.sample) are not cut points.
  * Row-changing sub-expressions buried in chains are hoisted into temporaries
    first, so every grain step is a statement with a named input.
  * Cut AFTER a grain statement iff everything the remaining statements still
    need is that one frame plus the operator's own parameters (constants and
    imports are copied forward). Row-preserving statements fold forward into
    the row-changing step that consumes them; a trailing stage with no
    row-changing step folds back into the one before it.
  * The last stage keeps the model's operatorId, so downstream references and
    the model's own `def process(<id>)` keep working.
"""
import ast
import json
import re
import sys

ROWSEL_METHODS = {"query", "dropna", "explode", "melt", "pivot", "pivot_table"}
LIMIT_METHODS = {"head", "tail", "nlargest", "nsmallest", "sample"}
MERGE_METHODS = {"merge", "join"}
DEDUP_METHODS = {"drop_duplicates"}
AGG_METHODS = {"agg", "aggregate", "sum", "mean", "count", "size", "nunique", "min", "max", "median", "std", "var", "first", "last", "prod", "any", "all"}
FRAME_PRESERVING = {"copy", "reset_index", "rename", "sort_values", "sort_index", "assign", "fillna", "astype", "drop",
                    "set_index", "round", "replace", "reindex", "rename_axis", "convert_dtypes", "infer_objects", "clip", "abs"}
MASK_CALLS = {"isin", "notna", "notnull", "isna", "isnull", "between", "duplicated", "contains", "startswith", "endswith", "match", "eq", "ne", "gt", "lt", "ge", "le"}
MODULE_NAMES = {"pd", "np", "pandas", "numpy", "glob", "os", "re", "json", "math", "datetime", "io", "sys", "csv", "pathlib", "collections", "itertools", "functools", "statistics"}
MAX_CUTS = 5
CHECK_OPEN, CHECK_CLOSE = "# <<check>>", "# <</check>>"


def names_loaded(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def names_stored(node):
    out = set()
    for n in ast.walk(node):
        if isinstance(n, ast.Name) and isinstance(n.ctx, (ast.Store, ast.Del)):
            out.add(n.id)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                out.add((a.asname or a.name).split(".")[0])
    return out


def is_const_expr(node):
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return all(is_const_expr(e) for e in node.elts)
    if isinstance(node, ast.Dict):
        return all(is_const_expr(k) and is_const_expr(v) for k, v in zip(node.keys, node.values) if k is not None)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return is_const_expr(node.operand)
    return False


class Splitter:
    def __init__(self, code, op_id, max_cuts=MAX_CUTS):
        self.code = code
        self.op_id = op_id
        self.max_cuts = max_cuts
        self.tmp = 0
        self.frame_vars = set()
        self.mask_exprs = {}

    # ------------------------------------------------------------ detection
    def is_frame_expr(self, node):
        if isinstance(node, ast.Name):
            return node.id in self.frame_vars
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute):
                if isinstance(f.value, ast.Name) and f.value.id == "pd" and (f.attr.startswith("read_") or f.attr in ("DataFrame", "concat", "merge", "json_normalize")):
                    return True
                if f.attr in FRAME_PRESERVING | LIMIT_METHODS and self.is_frame_expr(f.value):
                    return True
            return self.grain_unit(node) is not None
        if isinstance(node, ast.Subscript):
            if self.is_frame_expr(node.value) and isinstance(node.slice, ast.List) and all(isinstance(e, ast.Constant) for e in node.slice.elts):
                return True
            return self.grain_unit(node) is not None
        return False

    def is_mask(self, node):
        if isinstance(node, (ast.Compare, ast.BoolOp)):
            return True
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.Invert, ast.Not)):
            return True
        if isinstance(node, ast.Name) and node.id in self.mask_exprs:
            return True
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in MASK_CALLS:
            return True
        return False

    def groupby_root(self, node):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in AGG_METHODS):
            return None
        recv = node.func.value
        if isinstance(recv, ast.Subscript):
            recv = recv.value
        if isinstance(recv, ast.Call) and isinstance(recv.func, ast.Attribute) and recv.func.attr == "groupby" \
                and isinstance(recv.func.value, ast.Name) and recv.func.value.id in self.frame_vars:
            as_index_false = any(k.arg == "as_index" and isinstance(k.value, ast.Constant) and k.value.value is False for k in recv.keywords)
            return recv.func.value.id, as_index_false
        return None

    def grain_unit(self, node):
        """(kind, receiver) for a row-changing expression yielding a DataFrame."""
        if isinstance(node, ast.Subscript):
            base = node.value
            via_loc = isinstance(base, ast.Attribute) and base.attr == "loc"
            if via_loc:
                base = base.value
            if isinstance(base, ast.Name) and base.id in self.frame_vars:
                idx = node.slice
                if via_loc and isinstance(idx, ast.Tuple) and idx.elts:
                    idx = idx.elts[0]
                if self.is_mask(idx):
                    return "filter", base.id
            return None
        if not isinstance(node, ast.Call):
            return None
        f = node.func
        if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "pd":
            if f.attr == "concat":
                return "concat", None
            if f.attr == "merge" and node.args and isinstance(node.args[0], ast.Name):
                return "merge", node.args[0].id
            return None
        if isinstance(f, ast.Attribute) and f.attr in (ROWSEL_METHODS | MERGE_METHODS | DEDUP_METHODS) \
                and (isinstance(f.value, ast.Name) and f.value.id in self.frame_vars or (not isinstance(f.value, ast.Name) and self.is_frame_expr(f.value))):
            recv = f.value.id if isinstance(f.value, ast.Name) else ast.unparse(f.value)
            if f.attr in ROWSEL_METHODS:
                return "filter", recv
            if f.attr in MERGE_METHODS:
                return "merge", recv
            return "dedup", recv
        if isinstance(f, ast.Attribute) and f.attr == "reset_index":
            gb = self.groupby_root(f.value)
            if gb:
                return "groupby", gb[0]
        gb = self.groupby_root(node)
        if gb and gb[1]:
            return "groupby", gb[0]
        return None

    # ------------------------------------------------------------- hoisting
    def hoist(self, stmt):
        pre = []
        me = self

        class T(ast.NodeTransformer):
            def visit(self, node):
                node = self.generic_visit(node)
                if isinstance(node, (ast.Subscript, ast.Call)) and me.grain_unit(node) is not None:
                    me.tmp += 1
                    name = f"_g{me.tmp}"
                    pre.append(ast.Assign(targets=[ast.Name(id=name, ctx=ast.Store())], value=node, type_comment=None))
                    me.frame_vars.add(name)
                    return ast.Name(id=name, ctx=ast.Load())
                return node

            def visit_Lambda(self, node):
                return node

        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            if self.grain_unit(stmt.value) is not None:
                inner = T()
                for child_name, child in ast.iter_fields(stmt.value):
                    if isinstance(child, list):
                        setattr(stmt.value, child_name, [inner.visit(c) if isinstance(c, ast.AST) else c for c in child])
                    elif isinstance(child, ast.AST) and child_name != "func":
                        setattr(stmt.value, child_name, inner.visit(child))
                self.frame_vars.add(stmt.targets[0].id)
                return pre + [stmt]
            stmt.value = T().visit(stmt.value)
            if self.is_frame_expr(stmt.value):
                self.frame_vars.add(stmt.targets[0].id)
            elif self.is_mask(stmt.value):
                self.mask_exprs[stmt.targets[0].id] = stmt.value
            return pre + [stmt]
        if isinstance(stmt, ast.Return) and stmt.value is not None:
            stmt.value = T().visit(stmt.value)
            if self.grain_unit(stmt.value) is not None:
                self.tmp += 1
                name = f"_g{self.tmp}"
                pre.append(ast.Assign(targets=[ast.Name(id=name, ctx=ast.Store())], value=stmt.value, type_comment=None))
                self.frame_vars.add(name)
                stmt.value = ast.Name(id=name, ctx=ast.Load())
            return pre + [stmt]
        if isinstance(stmt, ast.Expr):
            stmt.value = T().visit(stmt.value)
            return pre + [stmt]
        return [stmt]

    # ----------------------------------------------------------------- main
    def run(self):
        code = re.sub(r"[ \t]*" + re.escape(CHECK_OPEN) + r"[\s\S]*?" + re.escape(CHECK_CLOSE) + r"\n?", "", self.code)
        tree = ast.parse(code)
        fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("load", "process")), None)
        if fn is None:
            return {"split": False, "stages": [], "checks": 0, "plan": [], "note": "no load/process function"}
        params = [a.arg for a in fn.args.args]
        self.frame_vars = set(params)
        imports = [s for s in fn.body if isinstance(s, (ast.Import, ast.ImportFrom))]
        body = [s for s in fn.body if not isinstance(s, (ast.Import, ast.ImportFrom))]
        if not body or not isinstance(body[-1], ast.Return) or self.max_cuts <= 0:
            return {"split": False, "stages": [], "checks": 0, "plan": [], "note": "no split"}

        stmts = []
        for s in body:
            stmts.extend(self.hoist(s))
        ast.fix_missing_locations(ast.Module(body=stmts, type_ignores=[]))

        info = []
        for s in stmts:
            unit, target = None, None
            if isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name):
                unit = self.grain_unit(s.value)
                target = s.targets[0].id if unit else None
            const = isinstance(s, ast.Assign) and len(s.targets) == 1 and isinstance(s.targets[0], ast.Name) and is_const_expr(s.value)
            info.append(dict(defs=names_stored(s), uses=names_loaded(s), unit=unit, target=target, const=const))

        n = len(stmts)
        cuts = []
        for i in range(n - 1):
            if not info[i]["unit"]:
                continue
            f = info[i]["target"]
            later_uses = set().union(*(info[j]["uses"] for j in range(i + 1, n)))
            defined_before = set().union(*(info[j]["defs"] for j in range(0, i + 1)))
            live = (later_uses & defined_before) - set(params) - MODULE_NAMES
            consts = {info[j]["target"] or next(iter(info[j]["defs"]), None) for j in range(0, i + 1) if info[j]["const"]}
            if f in live and (live - {f}) <= {c for c in consts if c}:
                cuts.append(i)
        cuts = cuts[: self.max_cuts]
        while cuts and not any(info[j]["unit"] for j in range(cuts[-1] + 1, n)):
            cuts.pop()
        if not cuts:
            return {"split": False, "stages": [], "checks": 0, "plan": [], "note": "no legal cut"}

        bounds = [(-1, cuts[0])] + list(zip(cuts, cuts[1:])) + [(cuts[-1], n - 1)]
        stages, prev_id, prev_var, used = [], None, None, {}
        for si, (lo, hi) in enumerate(bounds):
            seg = stmts[lo + 1: hi + 1]
            last = si == len(bounds) - 1
            cut_var = info[hi]["target"] if not last else None
            kind = info[hi]["unit"][0] if (not last and info[hi]["unit"]) else "final"
            if last:
                sid = self.op_id
            else:
                used[kind] = used.get(kind, 0) + 1
                sid = f"{self.op_id}__{kind}" + (str(used[kind]) if used[kind] > 1 else "")
            seg_uses = set().union(*(names_loaded(s) for s in seg)) if seg else set()
            lines = ["    " + ast.unparse(imp) for imp in imports]
            for j in range(0, lo + 1):
                if info[j]["const"] and (info[j]["defs"] & seg_uses):
                    lines.append("    " + ast.unparse(stmts[j]))
            for s in seg:
                lines += ["    " + l for l in ast.unparse(s).splitlines()]
            if not last:
                lines.append(f"    return {cut_var}")
            if si == 0:
                header = f"def {fn.name}({', '.join(params) if fn.name == 'process' else ''}):"
                inputs = list(params) if fn.name == "process" else []
            else:
                extra = [p for p in params if p in seg_uses and p != prev_var]
                sig = [prev_id] + extra
                header = f"def process({', '.join(sig)}):"
                if prev_var != prev_id:
                    lines.insert(0, f"    {prev_var} = {prev_id}")
                inputs = sig
            stages.append({"id": sid, "kind": kind, "inputs": inputs, "code": header + "\n" + "\n".join(lines)})
            prev_id, prev_var = sid, cut_var
        for st in stages:
            ast.parse(st["code"])
        return {"split": True, "stages": stages, "checks": 0, "plan": [], "note": f"{len(cuts)} cut(s) at {[info[c]['unit'][0] for c in cuts]}"}


def main():
    req = json.loads(sys.stdin.read())
    try:
        out = Splitter(req["code"], req["operatorId"], int(req.get("maxCuts", MAX_CUTS))).run()
    except Exception as e:  # never break the tool
        out = {"split": False, "stages": [], "checks": 0, "plan": [], "note": f"splitter error: {type(e).__name__}: {e}"}
    print(json.dumps(out))


if __name__ == "__main__":
    main()
