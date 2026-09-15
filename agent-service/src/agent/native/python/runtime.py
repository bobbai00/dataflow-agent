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

"""Standalone V2 support embedded in generated DataLoading/DataProcessing code.

No engine or service imports. Preflight uses only the standard library and never
executes submitted code. Pandas/NumPy load only during actual execution. Function
validation and restricted result shapes are contracts, NOT a security sandbox.
"""

import ast
import datetime
import json
import keyword
import linecache
import math
import numbers
import traceback
from collections.abc import Mapping
from types import MappingProxyType


class NativeError(ValueError):
    def __init__(self, diagnostic):
        self.diagnostic = diagnostic
        super().__init__("NATIVE_ERROR_V2:" + json.dumps(diagnostic, ensure_ascii=True, separators=(",", ":")))


class _UndeclaredColumn(KeyError):
    pass


class _Row(Mapping):
    """A fresh read-only row, with distinguishable undeclared-column errors."""

    def __init__(self, values):
        self._values = MappingProxyType(values)

    def __getitem__(self, key):
        if key not in self._values:
            raise _UndeclaredColumn(key)
        return self._values[key]

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)


def _error(spec, code, message, *, stage="execute", field=None, source=None):
    diagnostic = {
        "version": 1,
        "operatorId": spec.get("id", "operator"),
        "operatorRevision": spec.get("revision", "unversioned"),
        "code": code,
        "stage": stage,
        "message": str(message)[:320],
    }
    if field is not None:
        diagnostic["field"] = field
    if source is not None:
        diagnostic["source"] = source
    return NativeError(diagnostic)


def _location(source, entry, line, column=None):
    lines = source.splitlines()
    result = {"entry": entry, "line": line, "excerpt": lines[line - 1][:180] if 0 < line <= len(lines) else ""}
    if column is not None:
        result["column"] = column
    return result


def _filename(spec, field):
    return f"native-v2:{spec.get('id', 'operator')}:{spec.get('revision', 'unversioned')}:{field}"


def _validate_function(spec, source, field, entry, parameters=None):
    filename = _filename(spec, field)
    try:
        tree = ast.parse(source, filename=filename)
        compile(tree, filename, "exec")  # Includes e.g. duplicate-parameter validation; no execution.
    except (SyntaxError, ValueError, TypeError) as error:
        raise _error(
            spec,
            "PYTHON_SYNTAX",
            str(error).split("\n")[0],
            stage="compile",
            field=field,
            source=_location(source, entry, getattr(error, "lineno", None) or 1, getattr(error, "offset", None)),
        ) from error
    entries = [
        node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == entry
    ]
    valid = len(entries) == 1 and isinstance(entries[0], ast.FunctionDef)
    if valid:
        node = entries[0]
        args = node.args
        positional = [arg.arg for arg in args.posonlyargs + args.args]
        valid = not (node.decorator_list or args.vararg or args.kwarg or args.kwonlyargs or args.defaults)
        valid = valid and (positional == parameters if parameters is not None else len(positional) == 1)
    if not valid:
        signature = ", ".join(parameters) if parameters is not None else "value_or_row"
        raise _error(
            spec,
            "CALLBACK_SIGNATURE",
            f"Define exactly one synchronous def {entry}({signature}), without decorators, defaults or variadic arguments.",
            stage="compile",
            field=field,
        )
    return tree


ROW_EFFECTS = {
    "Scan": "create",
    "Project": "none",
    "Cast": "none",
    "FillNull": "none",
    "Transform": "none",
    "Derive": "none",
    "Filter": "drop",
    "Aggregate": "collapse",
    "Join": "multiply",
    "Union": "add",
    "Distinct": "drop",
    "Sort": "none",
    "Limit": "drop",
    "Window": "none",
    "Split": "none",
    "Explode": "add",
    "Unpivot": "add",
    "Pivot": "collapse",
    "UDF": "unknown",
}
DTYPES = {"str": "string", "int64": "Int64", "float64": "Float64", "bool": "boolean", "datetime": "datetime64[ns, UTC]"}


def validate_native(spec):
    """Validate Python source/port contracts without importing runtime packages."""
    kind = spec["type"]
    if spec.get("version") != "v2" or kind not in ROW_EFFECTS:
        raise _error(spec, "CATALOG_VERSION", "Expected a supported V2 operator.", stage="validate")
    inputs = spec.get("inputs", [])
    for name in [spec.get("id", "operator"), *inputs]:
        if not isinstance(name, str) or not name.isidentifier() or keyword.iskeyword(name):
            raise _error(spec, "OPERATOR_ID", f"Not a Python identifier: {name!r}", stage="validate")
    if len(set(inputs)) != len(inputs) and kind != "Join":
        raise _error(spec, "INPUT_PORTS", "Only Join may reference the same input twice.", stage="validate")
    expected = 0 if kind == "Scan" else 2 if kind == "Join" else None if kind in ("Union", "UDF") else 1
    if expected is not None and len(inputs) != expected:
        raise _error(spec, "INPUT_PORTS", f"{kind} requires {expected} input ports.", stage="validate")
    if kind == "Union" and len(inputs) < 2:
        raise _error(spec, "INPUT_PORTS", "Union requires at least two inputs.", stage="validate")
    props = spec["properties"]
    if kind == "Project" and "keep" in props and "drop" in props:
        raise _error(spec, "PROJECT_OPTIONS", "keep and drop are mutually exclusive.", stage="validate")
    if kind in ("Transform", "Derive", "Cast"):
        names = []
        for i, item in enumerate(props["columns"]):
            field = f"columns[{i}]"
            if item["dtype"] not in DTYPES:
                raise _error(spec, "DTYPE", f"Unsupported dtype {item['dtype']!r}.", stage="validate", field=field)
            names.append(item["as"] if kind == "Derive" else item["column"])
            if kind != "Cast":
                _validate_function(spec, item["func"], f"{field}.func", "apply")
            elif item["dtype"] != "datetime" and ("format" in item or "timezone" in item):
                raise _error(
                    spec, "CAST_OPTIONS", "format/timezone apply only to datetime.", stage="validate", field=field
                )
        if len(set(names)) != len(names):
            raise _error(spec, "COLUMN_COLLISION", "Submit each output column once.", stage="validate", field="columns")
    elif kind == "Filter":
        _validate_function(spec, props["func"], "func", "apply")
    elif kind == "UDF":
        _validate_function(spec, props["code"], "code", "process" if inputs else "load", inputs)


def _caught(spec, error, source, field, entry):
    frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == _filename(spec, field)]
    code = (
        "PYTHON_IMPORT"
        if isinstance(error, ImportError)
        else "UNDECLARED_COLUMN" if isinstance(error, _UndeclaredColumn) else "CALLBACK_RUNTIME"
    )
    return _error(
        spec,
        code,
        f"{type(error).__name__}: {error}",
        field=field,
        source=_location(source, entry, frames[-1].lineno if frames else 1),
    )


def _function(spec, source, field, entry):
    filename = _filename(spec, field)
    linecache.cache[filename] = (len(source), None, source.splitlines(keepends=True), filename)
    namespace = {"__name__": "__native_user_code__"}
    try:
        exec(compile(source, filename, "exec"), namespace)
        function = namespace[entry]
        if not callable(function):
            raise TypeError(f"{entry} was replaced by a non-callable value")
    except Exception as error:
        raise _caught(spec, error, source, field, entry) from error

    def call(*args):
        try:
            return function(*args)
        except Exception as error:
            raise _caught(spec, error, source, field, entry) from error

    return call


def _missing(value):
    return value is None or (pd.api.types.is_scalar(value) and bool(pd.isna(value)))


def _scalar(value):
    if _missing(value):
        return None
    return value.item() if isinstance(value, np.generic) and not isinstance(value, np.datetime64) else value


def _columns(spec, frame, names, field):
    if len(names) != len(set(names)):
        raise _error(spec, "COLUMN_COLLISION", "Column references must be distinct.", field=field)
    missing = [name for name in names if name not in frame.columns]
    if missing:
        raise _error(
            spec,
            "MISSING_COLUMN",
            f"Missing columns {missing!r}; available: {list(frame.columns)[:20]!r}.",
            field=field,
        )


def _frame(spec, value):
    if not isinstance(value, pd.DataFrame):
        raise _error(
            spec, "UDF_RETURN_TYPE", f"Expected a pandas DataFrame, got {type(value).__name__}.", stage="contract"
        )
    if not all(isinstance(name, str) for name in value.columns) or value.columns.has_duplicates:
        raise _error(spec, "OUTPUT_SCHEMA", "Table columns must be unique string names.", stage="contract")
    for name in value.columns:
        column = value[name]
        if column.dtype == object:
            inferred = pd.api.types.infer_dtype(column, skipna=True)
            if inferred not in (
                "string",
                "unicode",
                "bytes",
                "integer",
                "floating",
                "mixed-integer-float",
                "boolean",
                "datetime",
                "datetime64",
                "date",
                "empty",
            ):
                raise _error(
                    spec,
                    "OUTPUT_VALUE_TYPE",
                    f"Column {name!r} contains unsupported {inferred} values. Return compatible scalar values; serialize nested data as JSON strings.",
                    stage="contract",
                )
    return value


def _convert(value, dtype, *, cast=False, options=None):
    value = _scalar(value)
    if value is None:
        return None
    options = options or {}
    if not pd.api.types.is_scalar(value):
        raise TypeError("expected a scalar, not a table/list/mapping")
    if dtype == "str":
        if isinstance(value, str):
            return value
        if cast:
            return str(value)
    elif dtype == "bool":
        if isinstance(value, bool):
            return value
        if cast and isinstance(value, str) and value.strip().lower() in ("true", "false"):
            return value.strip().lower() == "true"
        if cast and isinstance(value, numbers.Real) and value in (0, 1):
            return bool(value)
    elif dtype in ("int64", "float64") and not isinstance(value, bool):
        if isinstance(value, numbers.Real) or (cast and isinstance(value, str)):
            if dtype == "float64":
                result = float(value)
                if not math.isfinite(result):
                    raise ValueError("expected a finite number")
                return result
            # Preserve large integer precision; don't round through float first.
            if isinstance(value, str):
                result = int(value.strip())
            else:
                result = int(value)
                if result != value:
                    raise ValueError("fractional value cannot become int64")
            if not -(2**63) <= result < 2**63:
                raise ValueError("integer outside int64 range")
            return result
    elif dtype == "datetime":
        if not cast and not isinstance(value, (datetime.datetime, pd.Timestamp, np.datetime64)):
            raise TypeError("expected a datetime value")
        if isinstance(value, numbers.Number):
            raise TypeError("numeric timestamps need an explicit Python conversion with units")
        if options.get("format"):
            value = pd.to_datetime(value, format=options["format"], errors="raise")
        elif isinstance(value, str):
            value = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        result = pd.Timestamp(value)
        if result.tzinfo is None:
            if not options.get("timezone"):
                raise ValueError("timezone-naive values require an explicit timezone")
            result = result.tz_localize(options["timezone"], ambiguous="raise", nonexistent="raise")
        return result.tz_convert("UTC")
    raise TypeError(f"expected {dtype}, got {type(value).__name__}: {repr(value)[:100]}")


def _series(values, dtype):
    return pd.Series(values, dtype=DTYPES[dtype])


def _dtype(series):
    dtype = series.dtype
    if pd.api.types.is_bool_dtype(dtype):
        return "bool"
    if pd.api.types.is_integer_dtype(dtype):
        return "int64"
    if pd.api.types.is_numeric_dtype(dtype):
        return "float64"
    if pd.api.types.is_datetime64_any_dtype(dtype):
        return "datetime"
    return "str"


def _map_columns(spec, source, operations):
    props, kind = spec["properties"], spec["type"]
    output = source.copy().reset_index(drop=True)
    for i, item in enumerate(props["columns"]):
        name = item["as"] if kind == "Derive" else item["column"]
        columns = item["inputs"] if kind == "Derive" else [name]
        _columns(spec, source, columns, f"columns[{i}]")
        if kind == "Derive" and name in source.columns and not props.get("replace", False):
            raise _error(
                spec,
                "COLUMN_COLLISION",
                f"Column {name!r} already exists; set replace:true explicitly.",
                field=f"columns[{i}].as",
            )
    for i, item in enumerate(props["columns"]):
        name = item["as"] if kind == "Derive" else item["column"]
        field = f"columns[{i}].func"
        function = _function(spec, item["func"], field, "apply")
        if kind == "Derive":
            columns = item["inputs"]
            arguments = (
                _Row(dict(zip(columns, map(_scalar, row))))
                for row in source[columns].itertuples(index=False, name=None)
            )
            # Pandas produces no tuples for zero-column frames; constants still
            # require exactly one invocation per input row.
            if not columns:
                arguments = (_Row({}) for _ in range(len(source)))
        else:
            arguments = map(_scalar, source[name])
        values = []
        for argument in arguments:
            value = function(argument)
            try:
                values.append(_convert(value, item["dtype"]))
            except (ValueError, TypeError, OverflowError) as error:
                raise _error(
                    spec,
                    "CALLBACK_RETURN_TYPE",
                    f"{name}: {error}",
                    stage="contract",
                    field=field,
                    source=_location(item["func"], "apply", 1),
                ) from error
        output[name] = _series(values, item["dtype"])
    operations["columnDependencies"] = {
        (item["as"] if kind == "Derive" else item["column"]): item["inputs"] if kind == "Derive" else [item["column"]]
        for item in props["columns"]
    }
    return output


def _cast(spec, source, operations):
    props = spec["properties"]
    output = source.copy().reset_index(drop=True)
    failures = {}
    for i, item in enumerate(props["columns"]):
        name = item["column"]
        _columns(spec, source, [name], f"columns[{i}]")
        values, failed = [], 0
        for value in source[name]:
            try:
                values.append(_convert(value, item["dtype"], cast=True, options=item))
            except (ValueError, TypeError, OverflowError) as error:
                if props.get("errors", "raise") != "null":
                    raise _error(
                        spec,
                        "CAST_INVALID_VALUE",
                        f"Cannot cast {name!r} to {item['dtype']}: {error}. Normalize the input or explicitly set errors:null.",
                        field=f"columns[{i}]",
                    ) from error
                failed += 1
                values.append(None)
        output[name] = _series(values, item["dtype"])
        failures[name] = failed
    operations["conversionFailures"] = failures
    return output


def _filter(spec, source, operations):
    props = spec["properties"]
    columns = props["columns"]
    _columns(spec, source, columns, "columns")
    function = _function(spec, props["func"], "func", "apply")
    mask, missing = [], 0
    rows = source[columns].itertuples(index=False, name=None) if columns else (() for _ in range(len(source)))
    for row in rows:
        value = _scalar(function(_Row(dict(zip(columns, map(_scalar, row))))))
        if value is None:
            missing += 1
            policy = props.get("nulls", "drop")
            if policy == "error":
                raise _error(
                    spec, "FILTER_NULL", "Predicate returned None with nulls:error.", stage="contract", field="func"
                )
            value = policy == "keep"
        if not isinstance(value, bool):
            raise _error(
                spec,
                "CALLBACK_RETURN_TYPE",
                f"Filter requires bool or None, got {type(value).__name__}.",
                stage="contract",
                field="func",
                source=_location(props["func"], "apply", 1),
            )
        mask.append(value)
    operations.update({"keptRows": sum(mask), "rejectedRows": len(mask) - sum(mask), "nullPredicates": missing})
    return source.iloc[[i for i, keep in enumerate(mask) if keep]].copy().reset_index(drop=True)


def _project(spec, source):
    props = spec["properties"]
    if "keep" in props and "drop" in props:
        raise _error(spec, "PROJECT_OPTIONS", "keep and drop are mutually exclusive.", stage="validate")
    _columns(spec, source, props.get("keep", props.get("drop", [])), "keep/drop")
    selected = props.get("keep", [name for name in source.columns if name not in props.get("drop", [])])
    output = source[selected].copy()
    rename = props.get("rename", {})
    _columns(spec, output, list(rename), "rename")
    names = [rename.get(name, name) for name in output.columns]
    if len(names) != len(set(names)):
        raise _error(spec, "COLUMN_COLLISION", "Renaming would produce duplicate column names.", field="rename")
    output.columns = names
    return output.reset_index(drop=True)


def execute_native(spec, inputs):
    global pd, np
    import pandas as pd
    import numpy as np

    validate_native(spec)
    if len(inputs) != len(spec.get("inputs", [])):
        raise _error(spec, "INPUT_PORTS", "Runtime input count differs from the declared ports.", stage="contract")
    for frame in inputs:
        _frame(spec, frame)
    kind, props = spec["type"], spec["properties"]
    source = inputs[0] if inputs else None
    operations = {}
    if kind in ("Transform", "Derive"):
        output = _map_columns(spec, source, operations)
    elif kind == "Cast":
        output = _cast(spec, source, operations)
    elif kind == "Filter":
        output = _filter(spec, source, operations)
    elif kind == "Project":
        output = _project(spec, source)
    elif kind == "FillNull":
        _columns(spec, source, list(props["values"]), "values")
        output = source.copy().reset_index(drop=True)
        for column, value in props["values"].items():
            try:
                replacement = _convert(value, _dtype(source[column]))
                output[column] = (
                    source[column].reset_index(drop=True).fillna(replacement)
                    if replacement is not None
                    else source[column].reset_index(drop=True)
                )
            except (ValueError, TypeError) as error:
                raise _error(
                    spec, "FILL_TYPE", f"{column}: {error}", stage="contract", field=f"values.{column}"
                ) from error
    elif kind == "UDF":
        entry = "process" if inputs else "load"
        function = _function(spec, props["code"], "code", entry)
        output = _frame(spec, function(*[frame.copy(deep=True) for frame in inputs]))
    else:
        raise _error(spec, "OPERATOR_UNAVAILABLE", f"Runtime implementation unavailable for {kind}.", stage="validate")
    _frame(spec, output)
    if ROW_EFFECTS[kind] == "none" and len(output) != len(source):
        raise _error(spec, "ROW_CONTRACT", "A row-preserving operator changed the row count.", stage="contract")
    output.attrs["native_v2"] = {
        "version": 1,
        "operatorId": spec.get("id", "operator"),
        "operatorRevision": spec.get("revision", "unversioned"),
        "rowEffect": ROW_EFFECTS[kind],
        "inputRows": [len(frame) for frame in inputs],
        "outputRows": len(output),
        "operations": operations,
    }
    return output


if __name__ == "__main__":
    import sys

    try:
        validate_native(json.load(sys.stdin))
        print(json.dumps({"ok": True}))
    except NativeError as error:
        print(json.dumps({"ok": False, "diagnostic": error.diagnostic}))
