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
from collections import Counter
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
    # Inputs bind positionally (`function(*frames)` below), so only the arity
    # has to match the ordered inputs; the parameter names are the author's.
    expected = len(parameters) if parameters is not None else 1
    if valid:
        node = entries[0]
        args = node.args
        positional = [arg.arg for arg in args.posonlyargs + args.args]
        valid = not (node.decorator_list or args.vararg or args.kwarg or args.kwonlyargs or args.defaults)
        valid = valid and len(positional) == expected
    if not valid:
        if parameters is not None:
            message = (
                f"Define exactly one synchronous def {entry} with {expected} positional parameter(s), one per input "
                f"in order ({', '.join(parameters)}); names are yours. No decorators, defaults or variadic arguments."
            )
        else:
            message = (
                f"Define exactly one synchronous def {entry}(value_or_row), "
                "without decorators, defaults or variadic arguments."
            )
        raise _error(spec, "CALLBACK_SIGNATURE", message, stage="compile", field=field)
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
    "Explode": "multiply",
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
    elif kind == "Aggregate":
        aggregates = props.get("aggregations", [])
        if not aggregates:
            raise _error(spec, "AGGREGATE_ARGUMENT", "Provide at least one aggregation.", stage="validate")
        names = list(props.get("groupBy", []))
        for item in aggregates:
            if item.get("fn") not in (
                "count",
                "count_distinct",
                "sum",
                "mean",
                "min",
                "max",
                "median",
                "stddev",
                "first",
            ):
                raise _error(spec, "AGGREGATE_ARGUMENT", "Unknown aggregation function.", stage="validate")
            if item["fn"] != "count" and not item.get("col"):
                raise _error(spec, "AGGREGATE_ARGUMENT", "Only count may omit col (to count rows).", stage="validate")
            if not item.get("as"):
                raise _error(
                    spec, "AGGREGATE_ARGUMENT", "Each aggregation needs an output name (as).", stage="validate"
                )
            names.append(item["as"])
        if len(names) != len(set(names)):
            raise _error(
                spec, "COLUMN_COLLISION", "Group keys and aggregate output names must be unique.", stage="validate"
            )
    elif kind == "Join":
        _join_keys(spec)
    elif kind == "Scan":
        _validate_scan_options(spec, None if props.get("format", "auto") == "auto" else props["format"])
    elif kind == "Window":
        if not props.get("orderBy") or not props.get("columns"):
            raise _error(spec, "WINDOW_ARGUMENT", "Provide nonempty orderBy and columns.", stage="validate")
        outputs = []
        for i, item in enumerate(props["columns"]):
            fn = item.get("fn")
            valid = fn in ("lag", "lead", "row_number", "rank", "dense_rank") and bool(item.get("as"))
            if fn in ("lag", "lead"):
                offset = item.get("offset", 1)
                valid = valid and bool(item.get("col")) and type(offset) is int and offset > 0
            else:
                valid = valid and "col" not in item and "offset" not in item
            if not valid:
                raise _error(
                    spec,
                    "WINDOW_ARGUMENT",
                    "lag/lead require col and a positive offset (default 1); row_number/rank/dense_rank forbid col/offset. Each output needs as.",
                    stage="validate",
                    field=f"columns[{i}]",
                )
            outputs.append(item["as"])
        if len(outputs) != len(set(outputs)):
            raise _error(
                spec, "COLUMN_COLLISION", "Window output names must be unique.", stage="validate", field="columns"
            )
    elif kind == "Split":
        names = props.get("into", [])
        if len(names) < 2 or not isinstance(props.get("separator"), str) or not props["separator"]:
            raise _error(
                spec,
                "SPLIT_ARGUMENT",
                "Provide at least two output names and a nonempty literal separator.",
                stage="validate",
            )
        if len(names) != len(set(names)):
            raise _error(spec, "COLUMN_COLLISION", "Split output names must be unique.", stage="validate", field="into")
    elif kind == "Explode":
        if props.get("encoding") != "json" or props.get("empty", "drop") not in ("drop", "null_row"):
            raise _error(
                spec, "EXPLODE_ARGUMENT", "encoding must be json; empty is drop or null_row.", stage="validate"
            )
    elif kind == "Unpivot":
        if not props.get("columns"):
            raise _error(
                spec, "UNPIVOT_ARGUMENT", "Provide nonempty columns to unpivot.", stage="validate", field="columns"
            )
    elif kind == "Pivot":
        keys = props.get("index", [])
        if (
            "index" not in props
            or not props.get("columns")
            or not props.get("values")
            or len(set([*keys, props["columns"], props["values"]])) != len(keys) + 2
        ):
            raise _error(
                spec,
                "PIVOT_ARGUMENT",
                "index, columns and values must reference distinct columns; index may be [].",
                stage="validate",
            )


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
        if pd.api.types.is_numeric_dtype(column.dtype) and not pd.api.types.is_bool_dtype(column.dtype):
            if np.isinf(column.dropna().to_numpy(dtype=float)).any():
                raise _error(
                    spec,
                    "OUTPUT_VALUE_TYPE",
                    f"Column {name!r} contains infinity, which cannot be faithfully represented in result JSON. Return a finite value, a missing value or an explicit string.",
                    stage="contract",
                )
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
    if dtype == object:
        inferred = pd.api.types.infer_dtype(series, skipna=True)
        if inferred == "integer":
            return "int64"
        if inferred in ("floating", "mixed-integer-float"):
            return "float64"
        if inferred == "boolean":
            return "bool"
        if inferred in ("date", "datetime", "datetime64"):
            return "datetime"
    return "str"


def _logical_dtype(series):
    # An all-null untyped object column has no evidence of a string domain.
    # Declared empty/nullable numeric/string columns still retain their type.
    return None if series.dtype == object and series.isna().all() else _dtype(series)


def _nullable(series):
    """Preserve the scalar domain without pandas' float inference round trip.

    convert_dtypes() may first coerce object integer/null values to float64,
    rounding integers above 2**53 before choosing its final nullable dtype.
    Construct extension arrays directly from the original scalar values.
    """
    kind = _logical_dtype(series)
    if kind is None or kind == "datetime":
        return series.copy()
    if series.dtype == object and pd.api.types.infer_dtype(series, skipna=True) == "bytes":
        return series.copy()
    return pd.Series(series.tolist(), index=series.index, name=series.name, dtype=DTYPES[kind])


def _key_rows(frame, columns):
    return [tuple(map(_scalar, row)) for row in frame[columns].itertuples(index=False, name=None)]


def _groups(frame, columns):
    if not columns:
        return [((), list(range(len(frame))))]
    groups = {}
    for position, key in enumerate(_key_rows(frame, columns)):
        groups.setdefault(key, []).append(position)
    return list(groups.items())


def _aggregate(spec, frame, operations):
    props = spec["properties"]
    keys, aggregates = props.get("groupBy", []), props["aggregations"]
    _columns(spec, frame, keys, "groupBy")
    for item in aggregates:
        if "col" in item:
            _columns(spec, frame, [item["col"]], "aggregations")
        if item["fn"] in ("sum", "mean", "median", "stddev") and _dtype(frame[item["col"]]) not in ("int64", "float64"):
            raise _error(
                spec,
                "AGGREGATE_TYPE",
                f"{item['fn']} requires numeric {item['col']!r}; cast it explicitly.",
                field="aggregations",
            )
    grouped = _groups(frame, keys)
    values = {name: [] for name in [*keys, *(item["as"] for item in aggregates)]}
    denominators = {item["as"]: {"total": 0, "min": None, "max": None} for item in aggregates}
    sizes = []
    for key, positions in grouped:
        sizes.append(len(positions))
        for name, value in zip(keys, key):
            values[name].append(value)
        for item in aggregates:
            fn, name = item["fn"], item["as"]
            column = frame[item["col"]].iloc[positions] if "col" in item else None
            present = column.dropna() if column is not None else None
            count = len(present) if present is not None else len(positions)
            counter = denominators[name]
            counter["total"] += count
            counter["min"] = count if counter["min"] is None else min(count, counter["min"])
            counter["max"] = count if counter["max"] is None else max(count, counter["max"])
            if fn == "count":
                value = count
            elif fn == "count_distinct":
                value = int(present.nunique())
            elif fn == "first":
                value = _scalar(column.iloc[0]) if len(column) else None
            elif not count or (fn == "stddev" and count < 2):
                value = None
            elif fn == "sum":
                # NumPy's int64 sum wraps on overflow; Python integers do not.
                value = sum(map(int, present)) if _dtype(column) == "int64" else math.fsum(map(float, present))
            else:
                value = _scalar(present.std(ddof=1) if fn == "stddev" else getattr(present, fn)())
            values[name].append(value)
    output = pd.DataFrame()
    for name in keys:
        output[name] = pd.Series(values[name], dtype=_nullable(frame[name]).dtype)
    for item in aggregates:
        fn, name = item["fn"], item["as"]
        dtype = (
            "int64"
            if fn in ("count", "count_distinct")
            else "float64" if fn in ("mean", "median", "stddev") else _dtype(frame[item["col"]])
        )
        try:
            if fn in ("count", "count_distinct", "sum", "mean", "median", "stddev"):
                output[name] = _series([_convert(value, dtype) for value in values[name]], dtype)
            else:
                output[name] = pd.Series(values[name], dtype=_nullable(frame[item["col"]]).dtype)
        except (ValueError, TypeError, OverflowError) as error:
            raise _error(
                spec,
                "AGGREGATE_RANGE",
                f"Aggregate {name!r} cannot be represented as {dtype}: {error}.",
                field="aggregations",
            ) from error
    operations.update(
        {
            "groupCount": len(grouped),
            "groupSizes": {"min": min(sizes, default=None), "max": max(sizes, default=None), "total": sum(sizes)},
            "aggregateNonNull": denominators,
        }
    )
    return output


def _join_keys(spec):
    props = spec["properties"]
    if props.get("type", "inner") == "cross":
        if props.get("validate", "many_to_many") != "many_to_many":
            raise _error(
                spec,
                "JOIN_KEYS",
                "Cross join has no equality keys to validate; use many_to_many or an explicit keyed join.",
                stage="validate",
                field="validate",
            )
        if "on" in props:
            raise _error(
                spec,
                "JOIN_KEYS",
                "Cross join forbids on; remove keys or choose an equijoin.",
                stage="validate",
                field="on",
            )
        return [], []
    raw = props.get("on")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        raise _error(
            spec,
            "JOIN_KEYS",
            "A non-cross join requires nonempty on keys; keys are never inferred.",
            stage="validate",
            field="on",
        )
    if all(isinstance(key, str) and key for key in raw):
        left, right = raw, raw
    elif all(
        isinstance(pair, list) and len(pair) == 2 and all(isinstance(key, str) and key for key in pair) for pair in raw
    ):
        left, right = [pair[0] for pair in raw], [pair[1] for pair in raw]
    else:
        raise _error(
            spec,
            "JOIN_KEYS",
            "Use a column, a list of shared columns, or [left, right] pairs.",
            stage="validate",
            field="on",
        )
    if len(set(left)) != len(left) or len(set(right)) != len(right):
        raise _error(spec, "JOIN_KEYS", "Join keys on each port must be distinct.", stage="validate", field="on")
    return left, right


def _join(spec, left, right, operations):
    props = spec["properties"]
    kind, equal = props.get("type", "inner"), props.get("nullsEqual", False)
    left_on, right_on = _join_keys(spec)
    _columns(spec, left, left_on, "on.left")
    _columns(spec, right, right_on, "on.right")
    for a, b in zip(left_on, right_on):
        types = {_logical_dtype(left[a]), _logical_dtype(right[b])} - {None}
        if len(types) > 1:
            raise _error(
                spec,
                "JOIN_TYPE",
                f"Join keys {a!r}/{b!r} have incompatible types {sorted(types)}; cast explicitly.",
                field="on",
            )
    shared_keys = {a for a, b in zip(left_on, right_on) if a == b}
    suffix = props.get("rightSuffix", "_right")
    right_names = {
        name: name + suffix if name in left.columns else name for name in right.columns if name not in shared_keys
    }
    output_names = [*left.columns, *right_names.values()]
    if len(set(output_names)) != len(output_names):
        raise _error(
            spec,
            "COLUMN_COLLISION",
            "Join suffix produces duplicate output columns; choose a different rightSuffix or project/rename first.",
            field="rightSuffix",
        )
    if kind == "cross":
        mapping = pd.DataFrame({"left": range(len(left))}).merge(
            pd.DataFrame({"right": range(len(right))}), how="cross"
        )
        operations["join"] = {
            "type": "cross",
            "matchedOutputRows": len(left) * len(right),
            "leftRows": len(left),
            "rightRows": len(right),
        }
    else:
        raw_keys = [_key_rows(left, left_on), _key_rows(right, right_on)]
        keys = [
            [key if equal or all(value is not None for value in key) else None for key in side] for side in raw_keys
        ]
        counts = [Counter(key for key in side if key is not None) for side in keys]
        validation = props.get("validate", "many_to_many")
        for side, required in enumerate(
            (validation in ("one_to_one", "one_to_many"), validation in ("one_to_one", "many_to_one"))
        ):
            duplicate = next((key for key, n in counts[side].items() if n > 1), None)
            if required and duplicate is not None:
                raise _error(
                    spec,
                    "JOIN_CARDINALITY",
                    f"{validation} requires unique eligible {'left' if side == 0 else 'right'} keys; duplicate {repr(duplicate)[:100]}.",
                    stage="contract",
                    field="validate",
                )
        codes, next_code, labels = {}, 0, []
        for side in keys:
            encoded = []
            for key in side:
                if key is None or key not in codes:
                    code, next_code = next_code, next_code + 1
                    if key is not None:
                        codes[key] = code
                else:
                    code = codes[key]
                encoded.append(code)
            labels.append(encoded)
        mapping = pd.DataFrame({"key": pd.Series(labels[0], dtype="int64"), "left": range(len(left))}).merge(
            pd.DataFrame({"key": pd.Series(labels[1], dtype="int64"), "right": range(len(right))}),
            how="outer" if kind == "full" else kind,
            on="key",
            sort=False,
        )
        common = counts[0].keys() & counts[1].keys()
        facts = {
            "type": kind,
            "nullsEqual": equal,
            "validate": validation,
            "matchedOutputRows": sum(counts[0][key] * counts[1][key] for key in common),
        }
        for i, port in enumerate(("left", "right")):
            matched = sum(counts[i][key] for key in common)
            facts[port] = {
                "rows": len(keys[i]),
                "eligibleRows": sum(counts[i].values()),
                "nullKeyRows": sum(any(value is None for value in key) for key in raw_keys[i]),
                "distinctKeys": len(counts[i]),
                "matchedRows": matched,
                "unmatchedRows": len(keys[i]) - matched,
                "matchedKeys": len(common),
                "unmatchedKeys": len(counts[i]) - len(common),
                "maxMultiplicity": max(counts[i].values(), default=0),
            }
        operations["join"] = facts

    def take(frame, column, port):
        return _nullable(frame[column]).reset_index(drop=True).reindex(mapping[port].to_numpy()).reset_index(drop=True)

    output = pd.DataFrame(index=range(len(mapping)))
    for name in left.columns:
        values = take(left, name, "left")
        if name in shared_keys:
            values = values.combine_first(take(right, name, "right"))
        output[name] = values
    for source, target in right_names.items():
        output[target] = take(right, source, "right")
    return output


def _union(spec, frames, operations):
    mode = spec["properties"].get("schema", "strict")
    names = list(dict.fromkeys(name for frame in frames for name in frame.columns))
    if mode == "strict" and any(set(frame.columns) != set(frames[0].columns) for frame in frames[1:]):
        raise _error(
            spec,
            "UNION_SCHEMA",
            "Strict union requires the same named columns; use schema:align for absent columns.",
            field="schema",
        )
    types = {}
    for name in names:
        kinds = {_logical_dtype(frame[name]) for frame in frames if name in frame.columns} - {None}
        if len(kinds) > 1:
            raise _error(
                spec,
                "UNION_TYPE",
                f"Union column {name!r} has incompatible types {sorted(kinds)}; cast before union.",
                field="schema",
            )
        types[name] = next(iter(kinds), "str")
    aligned = []
    for frame in frames:
        part = pd.DataFrame(index=range(len(frame)))
        for name in names:
            if name in frame.columns and _logical_dtype(frame[name]) is not None:
                part[name] = _nullable(frame[name]).reset_index(drop=True)
            else:
                part[name] = _series([None] * len(frame), types[name])
        aligned.append(part)
    operations["alignedMissingColumns"] = [[name for name in names if name not in frame.columns] for frame in frames]
    return pd.concat(aligned, ignore_index=True)


def _scan_format(path, requested):
    if requested != "auto":
        return requested
    extension = path.suffix.lower()
    for kind, extensions in {
        "excel": (".xlsx", ".xls", ".xlsm"),
        "html": (".html", ".htm"),
        "json": (".json", ".jsonl", ".ndjson"),
        "parquet": (".parquet",),
        "binary": (
            ".gpkg",
            ".shp",
            ".npz",
            ".npy",
            ".cdf",
            ".nc",
            ".h5",
            ".hdf5",
            ".pkl",
            ".zip",
            ".gz",
            ".db",
            ".sqlite",
        ),
    }.items():
        if extension in extensions:
            return kind
    return "csv"


def _validate_scan_options(spec, fmt):
    props = spec["properties"]

    def reject(message):
        raise _error(spec, "SCAN_OPTIONS", message, stage="validate")

    if "names" in props and props.get("header", True):
        reject("names requires header:false; use Project.rename to rename an existing header.")
    if "delim" in props and props["delim"] != "whitespace" and len(props["delim"]) != 1:
        reject("delim must be a single literal character or whitespace.")
    if fmt is None:
        return
    if "widths" in props and fmt != "fwf":
        reject("widths applies only to format:fwf.")
    if fmt == "whitespace" and props.get("delim", "whitespace") != "whitespace":
        reject("format:whitespace cannot use a different delim.")
    if "sheet" in props and (fmt not in ("excel", "html") or (fmt == "html" and not isinstance(props["sheet"], int))):
        reject("sheet selects an Excel sheet or a numeric HTML table index.")
    if fmt in ("binary", "parquet") and props.get("preview") and props.get("skipLines", 0):
        reject("Binary pointer previews cannot use skipLines; inspect metadata without an offset or use a UDF loader.")
    common = {"files", "format", "preview", "fileColumn", "allText"}
    allowed = {
        "csv": {"header", "names", "skipLines", "encoding", "delim", "comment"},
        "whitespace": {"header", "names", "skipLines", "encoding", "delim", "comment"},
        "fwf": {"header", "names", "skipLines", "encoding", "widths", "comment"},
        "lines": {"skipLines", "encoding"},
        "excel": {"header", "names", "skipLines", "sheet"},
        "html": {"header", "names", "skipLines", "sheet", "encoding"},
        "json": {"encoding"},
        "parquet": set(),
        "binary": set(),
    }
    if fmt not in allowed:
        reject(f"Unsupported format {fmt!r}.")
    compatible = common | allowed[fmt]
    if props.get("preview"):
        compatible |= {"skipLines"}
    bad = set(props) - compatible
    if bad:
        reject(f"Options {sorted(bad)} do not apply to {fmt}; they would be ignored.")
    if fmt == "binary" and not props.get("preview"):
        raise _error(
            spec,
            "SCAN_FORMAT",
            "This binary format needs a Python UDF loader; Scan preview can show its file metadata.",
            stage="validate",
        )


def _scan_encoding(path, requested):
    if requested:
        return requested
    import codecs

    with path.open("rb") as stream:
        sample = stream.read(1 << 22)
    if sample.startswith((codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)):
        return "utf-32"
    if sample.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return "utf-16"
    try:
        codecs.getincrementaldecoder("utf-8-sig")().decode(sample, final=len(sample) < (1 << 22))
        return "utf-8-sig"
    except UnicodeDecodeError:
        # Retain the legacy Western-export fallback, but never replace invalid
        # bytes. The chosen encoding is recorded and can be overridden.
        return "cp1252"


def _scan_infer(frame, all_text, infer_text=True):
    output = frame.copy().reset_index(drop=True)
    for name in output.columns:
        series = output[name]
        if all_text:
            output[name] = series.map(lambda value: None if _missing(value) else str(value)).astype("string")
            continue
        present = series.dropna()
        if infer_text and len(present) and all(isinstance(value, str) for value in present):
            lower = present.str.lower()
            if lower.isin(["true", "false"]).all():
                output[name] = series.map(lambda value: None if _missing(value) else value.lower() == "true").astype(
                    "boolean"
                )
                continue
            try:
                converted = pd.to_numeric(series, errors="raise")
                if pd.api.types.is_integer_dtype(converted.dtype):
                    if len(present) and (converted.min() < -(2**63) or converted.max() >= 2**63):
                        raise ValueError("outside int64")
                    output[name] = converted.astype("Int64")
                elif np.isfinite(converted.dropna().astype(float)).all():
                    output[name] = converted.astype("Float64")
                else:
                    raise ValueError("non-finite")
                continue
            except (ValueError, TypeError, OverflowError):
                pass
        output[name] = _nullable(series)
    return output


def _scan_header(spec, raw, source_meta):
    props = spec["properties"]
    if props.get("header", True):
        if raw.empty:
            raise _error(
                spec,
                "SCAN_HEADER",
                "No header is available. Use a raw preview, or header:false with explicit names for an empty source.",
                field="header",
            )
        unresolved = []
        names = []
        for index, value in enumerate(raw.iloc[0]):
            if _missing(value) or str(value) == "":
                value = f"column{index}"
                unresolved.append(value)
            names.append(str(value))
        source_meta["unresolvedHeaders"] = unresolved
        output = raw.iloc[1:].copy().reset_index(drop=True)
    else:
        names = props.get("names", [f"column{i}" for i in range(len(raw.columns))])
        output = raw.copy().reset_index(drop=True)
        # An entirely empty headerless file can still have a caller-declared schema.
        if not len(raw.columns) and raw.empty and "names" in props:
            output = pd.DataFrame(columns=names)
        if len(names) != len(output.columns):
            raise _error(
                spec,
                "SCAN_NAMES",
                f"Received {len(names)} names for {len(output.columns)} columns; provide exactly one per column.",
                field="names",
            )
    if len(names) != len(set(names)):
        raise _error(
            spec,
            "SCAN_HEADER",
            "Duplicate header names are not renamed automatically; preview and use header:false/names or a UDF parser.",
            field="header",
        )
    output.columns = names
    return _scan_infer(output, props.get("allText", False), infer_text=source_meta["format"] != "excel")


def _html_tables(path, encoding):
    from lxml import html

    # Decode with Python's codec names (e.g. utf-8-sig), then give libxml2 a
    # canonical encoding; its codec-name set differs from Python's.
    root = html.fromstring(path.read_text(encoding=encoding).encode("utf-8"), parser=html.HTMLParser(encoding="utf-8"))
    tables = []
    for table in root.xpath("//table"):
        row_nodes = table.xpath("./thead/tr | ./tbody/tr | ./tfoot/tr | ./tr")
        occupied = {}
        for row, node in enumerate(row_nodes):
            column = 0
            for cell in node.xpath("./th | ./td"):
                while (row, column) in occupied:
                    column += 1
                value = "".join(cell.itertext()).strip() or None
                height, width = int(cell.get("rowspan", "1")), int(cell.get("colspan", "1"))
                if height < 1 or width < 1:
                    raise ValueError("HTML spans must be positive")
                for dy in range(height):
                    for dx in range(width):
                        if (row + dy, column + dx) in occupied:
                            raise ValueError("Overlapping HTML cells")
                        occupied[row + dy, column + dx] = value
                column += width
        width = max((column + 1 for _, column in occupied), default=0)
        grid = [[occupied.get((row, column)) for column in range(width)] for row in range(len(row_nodes))]
        tables.append((pd.DataFrame(grid), bool(row_nodes and row_nodes[0].xpath("./th"))))
    if not tables:
        raise ValueError("No HTML tables found")
    return tables


def _scan_read(spec, path, fmt, source_meta):
    import csv
    from itertools import islice

    props = spec["properties"]
    skip, preview = props.get("skipLines", 0), props.get("preview")
    encoding = _scan_encoding(path, props.get("encoding")) if fmt not in ("excel", "parquet", "binary") else None
    if encoding:
        source_meta["encoding"] = encoding

    def line(values):
        cells = ["" if _missing(value) else str(value) for value in values]
        while cells and not cells[-1]:
            cells.pop()
        return " | ".join(cells)

    if preview and fmt in ("binary", "parquet"):
        return pd.DataFrame(
            {
                "file": [path.name],
                "size_bytes": [path.stat().st_size],
                "note": [
                    "Binary file metadata only; not parsed data rows. Use full Scan for parquet or a UDF for other binary formats."
                ],
            }
        )
    if fmt == "excel":
        with pd.ExcelFile(path) as workbook:
            selected = props.get("sheet")
            if isinstance(selected, int):
                selected = workbook.sheet_names[selected]
            sheets = (
                [selected] if selected is not None else workbook.sheet_names if preview else workbook.sheet_names[:1]
            )
            source_meta["sheets"] = sheets
            if preview:
                records = []
                for sheet in sheets:
                    raw = workbook.parse(
                        sheet,
                        header=None,
                        skiprows=skip,
                        nrows=preview,
                        dtype="string",
                        keep_default_na=False,
                        na_values=[""],
                    )
                    records.extend(
                        {"sheet": sheet, "row_no": i, "line": line(row)}
                        for i, row in enumerate(raw.itertuples(index=False, name=None), skip)
                    )
                result = pd.DataFrame(records, columns=["sheet", "row_no", "line"])
                result["row_no"] = result["row_no"].astype("Int64")
                return result
            raw = workbook.parse(
                sheets[0], header=None, skiprows=skip, dtype=object, keep_default_na=False, na_values=[""]
            )
            return _scan_header(spec, raw, source_meta)
    if fmt == "html":
        tables = _html_tables(path, encoding)
        indexes = [props["sheet"]] if "sheet" in props else list(range(len(tables))) if preview else [0]
        source_meta["tables"] = indexes
        if preview:
            records = []
            for index in indexes:
                raw, has_header = tables[index]
                headers = raw.iloc[0].tolist() if has_header else list(raw.columns)
                data = raw.iloc[1:] if has_header else raw
                if skip == 0:
                    records.append({"table": index, "row_no": 0, "line": line(headers)})
                records.extend(
                    {"table": index, "row_no": i, "line": line(row)}
                    for i, row in enumerate(
                        data.iloc[skip : skip + preview].itertuples(index=False, name=None), skip + 1
                    )
                )
            result = pd.DataFrame(records, columns=["table", "row_no", "line"])
            for name in ("table", "row_no"):
                result[name] = result[name].astype("Int64")
            return result
        return _scan_header(spec, tables[indexes[0]][0].iloc[skip:], source_meta)
    if preview or fmt == "lines":
        with path.open(encoding=encoding) as stream:
            records = [
                {"line_no": i, "line": raw.rstrip("\r\n")}
                for i, raw in enumerate(islice(stream, skip, skip + preview if preview else None), skip)
            ]
        result = pd.DataFrame(records, columns=["line_no", "line"])
        result["line_no"] = result["line_no"].astype("Int64")
        if preview:
            result.insert(0, "file", path.name)
        return result
    if fmt == "parquet":
        output = pd.read_parquet(path)
        _frame(spec, output)
        return _scan_infer(output, props.get("allText", False), infer_text=False)
    with path.open(encoding=encoding) as stream:
        for _ in range(skip):
            stream.readline()
        if fmt == "json":
            text = stream.read()

            def unique_pairs(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError(f"Duplicate JSON key {key!r}")
                    result[key] = value
                return result

            if path.suffix.lower() in (".jsonl", ".ndjson"):
                document = [json.loads(row, object_pairs_hook=unique_pairs) for row in text.splitlines() if row.strip()]
            else:
                document = json.loads(text, object_pairs_hook=unique_pairs)
            if isinstance(document, dict) and document and all(isinstance(value, list) for value in document.values()):
                output = pd.DataFrame(document, dtype=object)
            elif isinstance(document, dict) or (
                isinstance(document, list) and all(isinstance(row, dict) for row in document)
            ):
                records = [document] if isinstance(document, dict) else document
                flattened = []
                for record in records:
                    flat = {}

                    def visit(mapping, prefix=""):
                        for key, value in mapping.items():
                            name = prefix + str(key)
                            if isinstance(value, dict):
                                visit(value, name + ".")
                            else:
                                if name in flat:
                                    raise ValueError(
                                        f"Flattened JSON field collision at {name!r}; use a UDF parser with explicit names"
                                    )
                                flat[name] = value

                    visit(record)
                    flattened.append(flat)
                output = pd.DataFrame(flattened, dtype=object)
            else:
                raise ValueError(
                    "JSON Scan expects records, one object, or a dictionary of column arrays; use UDF for other layouts"
                )
            _frame(spec, output)
            return _scan_infer(output, props.get("allText", False), infer_text=False)
        try:
            if fmt == "fwf" and props.get("widths"):
                widths, records = props["widths"], []
                for raw in stream:
                    if not raw.strip() or (props.get("comment") and raw.lstrip().startswith(props["comment"])):
                        continue
                    if raw[sum(widths) :].strip():
                        raise ValueError("FWF widths leave nonempty trailing data; give widths for every field")
                    position, record = 0, []
                    for width in widths:
                        record.append(raw[position : position + width].strip() or None)
                        position += width
                    records.append(record)
                raw = pd.DataFrame(records, columns=range(len(widths)))
            elif fmt == "fwf":
                raw = pd.read_fwf(
                    stream,
                    header=None,
                    dtype="string",
                    comment=props.get("comment"),
                    keep_default_na=False,
                    na_values=[""],
                )
            else:
                delimiter = "whitespace" if fmt == "whitespace" else props.get("delim")
                if delimiter is None:
                    offset = stream.tell()
                    sample = stream.read(32768)
                    stream.seek(offset)
                    try:
                        delimiter = csv.Sniffer().sniff(sample, delimiters=",\t;|").delimiter
                    except csv.Error:
                        delimiter = ","
                source_meta["delim"] = delimiter
                raw = pd.read_csv(
                    stream,
                    header=None,
                    sep=r"\s+" if delimiter == "whitespace" else delimiter,
                    engine="python" if delimiter == "whitespace" else "c",
                    dtype="string",
                    comment=props.get("comment"),
                    keep_default_na=False,
                    na_values=[""],
                    on_bad_lines="error",
                )
        except pd.errors.EmptyDataError:
            raw = pd.DataFrame()
        return _scan_header(spec, raw, source_meta)


def _scan(spec, operations):
    import glob
    from pathlib import Path

    props = spec["properties"]
    patterns = [props["files"]] if isinstance(props["files"], str) else props["files"]
    resolved = set()
    for pattern in patterns:
        matches = glob.glob(pattern, recursive=True)
        if not matches:
            raise _error(
                spec,
                "SCAN_NOT_FOUND",
                f"No source matched {pattern!r}; verify the path or file extension.",
                field="files",
            )
        for match in matches:
            path = Path(match).resolve()
            if not path.is_file():
                raise _error(spec, "SCAN_NOT_FOUND", f"Source {str(path)!r} is not a regular file.", field="files")
            resolved.add(path)
    sources, parts, selected = [], [], Counter()
    for path in sorted(resolved):
        fmt = _scan_format(path, props.get("format", "auto"))
        _validate_scan_options(spec, fmt)
        category = fmt if fmt in ("excel", "html", "binary", "parquet") else "text"
        if props.get("preview") and (
            (category in ("excel", "html") and selected[category] >= 1)
            or (category == "text" and selected[category] >= 5)
        ):
            continue
        selected[category] += 1
        stat = path.stat()
        source_meta = {
            "path": str(path),
            "format": fmt,
            "sizeBytes": stat.st_size,
            "mtimeNs": str(stat.st_mtime_ns),
            "skipLines": props.get("skipLines", 0),
        }
        try:
            part = _scan_read(spec, path, fmt, source_meta)
            _frame(spec, part)
        except NativeError:
            raise
        except ImportError as error:
            raise _error(
                spec,
                "PYTHON_IMPORT",
                f"Reader for {fmt} is unavailable: {error}. Install its worker dependency or use an available UDF reader.",
                field="files",
            ) from error
        except Exception as error:
            raise _error(
                spec,
                "SCAN_PARSE",
                f"Cannot read {path.name!r} as {fmt}: {type(error).__name__}: {error}. Preview and adjust reader options.",
                field="files",
            ) from error
        if "fileColumn" in props:
            if props["fileColumn"] in part.columns:
                raise _error(
                    spec,
                    "COLUMN_COLLISION",
                    f"fileColumn {props['fileColumn']!r} would overwrite source data.",
                    field="fileColumn",
                )
            part[props["fileColumn"]] = path.name
        source_meta["outputRows"] = len(part)
        sources.append(source_meta)
        parts.append(part)
    result = _union({**spec, "properties": {"schema": "align"}}, parts, {})
    operations["scan"] = {
        "preview": bool(props.get("preview")),
        "complete": not bool(props.get("preview")),
        "resolvedFiles": len(resolved),
        "selectedFiles": len(parts),
        "omittedFiles": len(resolved) - len(parts),
        "sources": sources,
    }
    return result


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


def _new_columns(spec, frame, names, field):
    if len(names) != len(set(names)) or any(name in frame.columns for name in names):
        raise _error(
            spec,
            "COLUMN_COLLISION",
            f"New output names must be unique and not overwrite existing columns: {names!r}.",
            field=field,
        )


def _window(spec, source, operations):
    props = spec["properties"]
    partitions, ordering, columns = props.get("partitionBy", []), props["orderBy"], props["columns"]
    _columns(spec, source, partitions, "partitionBy")
    _columns(spec, source, [item["col"] for item in ordering], "orderBy")
    _new_columns(spec, source, [item["as"] for item in columns], "columns")
    for i, item in enumerate(columns):
        if "col" in item:
            _columns(spec, source, [item["col"]], f"columns[{i}].col")
    # Private positional identity, independent of arbitrary/duplicate user indexes.
    # Restore this order after calculating within each stably sorted partition.
    frame = source.reset_index(drop=True)
    output = frame.copy()
    values = {item["as"]: [None] * len(frame) for item in columns}
    counters = {item["as"]: {"boundaryNulls": 0, "nullOutputs": 0} for item in columns if item["fn"] in ("lag", "lead")}
    groups = _groups(frame, partitions) if len(frame) else []
    tie_rows = 0
    for _, positions in groups:
        ordered = frame.iloc[positions]
        for item in reversed(ordering):
            ordered = ordered.sort_values(
                item["col"], ascending=not item.get("desc", False), na_position="last", kind="stable"
            )
        order = ordered.index.tolist()
        order_keys = _key_rows(ordered, [item["col"] for item in ordering])
        ranks, dense_ranks, rank, dense = [], [], 0, 0
        for i, key in enumerate(order_keys):
            if i == 0 or key != order_keys[i - 1]:
                rank, dense = i + 1, dense + 1
            else:
                tie_rows += 1
            ranks.append(rank)
            dense_ranks.append(dense)
        for item in columns:
            fn, name = item["fn"], item["as"]
            for i, position in enumerate(order):
                if fn in ("lag", "lead"):
                    other = i + item.get("offset", 1) * (-1 if fn == "lag" else 1)
                    boundary = not 0 <= other < len(order)
                    value = None if boundary else _scalar(frame[item["col"]].iloc[order[other]])
                    counters[name]["boundaryNulls"] += int(boundary)
                    counters[name]["nullOutputs"] += int(value is None)
                else:
                    value = i + 1 if fn == "row_number" else ranks[i] if fn == "rank" else dense_ranks[i]
                values[name][position] = value
    for item in columns:
        dtype = _nullable(frame[item["col"]]).dtype if item["fn"] in ("lag", "lead") else "Int64"
        output[item["as"]] = pd.Series(values[item["as"]], dtype=dtype)
    operations["window"] = {"partitions": len(groups), "tieRows": tie_rows, "outputs": counters}
    operations["columnDependencies"] = {
        item["as"]: list(
            dict.fromkeys([*partitions, *(key["col"] for key in ordering), *([item["col"]] if "col" in item else [])])
        )
        for item in columns
    }
    return output


def _split(spec, source, operations):
    props = spec["properties"]
    name, into = props["column"], props["into"]
    _columns(spec, source, [name], "column")
    # Even with keepSource:false do not silently reuse/overwrite an input name.
    _new_columns(spec, source, into, "into")
    parts = {key: [] for key in into}
    for position, cell in enumerate(source[name]):
        value = _scalar(cell)
        if value is not None and not isinstance(value, str):
            raise _error(
                spec,
                "SPLIT_TYPE",
                f"Column {name!r}, row {position}: expected string or null, got {type(value).__name__}. Cast explicitly if intended.",
                field="column",
            )
        split = value.split(props["separator"], len(into) - 1) if value is not None else []
        for i, key in enumerate(into):
            parts[key].append(split[i] if i < len(split) else None)
    output = source.copy().reset_index(drop=True)
    if not props.get("keepSource", True):
        output = output.drop(columns=[name])
    for key in into:
        output[key] = _series(parts[key], "str")
    operations["columnDependencies"] = {key: [name] for key in into}
    return output


def _explode(spec, source, operations):
    props, name = spec["properties"], spec["properties"]["column"]
    _columns(spec, source, [name], "column")
    parents, values, sample = [], [], []
    domain, empty_parents, null_elements, elements, maximum = None, 0, 0, 0, 0

    def invalid_constant(value):
        raise ValueError(f"Non-JSON constant {value}")

    for position, cell in enumerate(source[name]):
        value = _scalar(cell)
        if value is None:
            array = []
        elif not isinstance(value, str):
            raise _error(
                spec,
                "EXPLODE_TYPE",
                f"Column {name!r}, row {position}: expected a JSON-array string or null.",
                field="column",
            )
        else:
            try:
                array = json.loads(value, parse_constant=invalid_constant)
            except (ValueError, RecursionError) as error:
                raise _error(
                    spec,
                    "EXPLODE_JSON",
                    f"Column {name!r}, row {position}: invalid JSON array ({str(error)[:100]}).",
                    field="column",
                ) from error
            if not isinstance(array, list):
                raise _error(
                    spec,
                    "EXPLODE_TYPE",
                    f"Column {name!r}, row {position}: JSON must contain an array, not {type(array).__name__}.",
                    field="column",
                )
        maximum = max(maximum, len(array))
        elements += len(array)
        null_elements += sum(item is None for item in array)
        empty_parents += int(not array)
        if not array:
            if props.get("empty", "drop") == "drop":
                continue
            entries = [(None, None)]
        else:
            entries = enumerate(array)
        for element, value in entries:
            if value is not None:
                kind = (
                    "bool"
                    if isinstance(value, bool)
                    else (
                        "int64"
                        if isinstance(value, int)
                        else "float64" if isinstance(value, float) else "str" if isinstance(value, str) else None
                    )
                )
                try:
                    if kind is None or (domain is not None and domain != kind):
                        raise TypeError("elements must share one scalar type plus nulls; normalize arrays in UDF first")
                    value = _convert(value, kind)
                except (TypeError, ValueError, OverflowError) as error:
                    raise _error(
                        spec,
                        "EXPLODE_TYPE",
                        f"Column {name!r}, row {position}, element {element}: {error}.",
                        field="column",
                    ) from error
                domain = kind
            parents.append(position)
            values.append(value)
            if len(sample) < 16:
                sample.append({"inputPosition": position, "elementPosition": element})
    output = source.iloc[parents].copy().reset_index(drop=True)
    output[name] = _series(values, domain or "str")
    operations["explode"] = {
        "emptyParents": empty_parents,
        "arrayElements": elements,
        "nullElements": null_elements,
        "maxElements": maximum,
    }
    operations["rowMapping"] = {
        "inputPort": 0,
        "kind": "array_elements",
        "sample": sample,
        "complete": len(values) <= len(sample),
    }
    operations["columnDependencies"] = {name: [name]}
    return output


def _unpivot(spec, source, operations):
    props = spec["properties"]
    columns = props["columns"]
    _columns(spec, source, columns, "columns")
    keys = [name for name in source.columns if name not in columns]
    name, value = props.get("nameColumn", "variable"), props.get("valueColumn", "value")
    _new_columns(spec, source[keys], [name, value], "nameColumn/valueColumn")
    kinds = {_logical_dtype(source[column]) for column in columns} - {None}
    if len(kinds) > 1:
        raise _error(
            spec,
            "UNPIVOT_TYPE",
            f"Selected columns have incompatible types {sorted(kinds)}; cast to one type before unpivot.",
            field="columns",
        )
    domain = next(iter(kinds), "str")
    # Never construct a mixed row Series (iterrows) or coerce integer/null values
    # through float64; both can corrupt exact int64 values before transport.
    values = [_scalar(item) for row in source[columns].itertuples(index=False, name=None) for item in row]
    parents = [i for i in range(len(source)) for _ in columns]
    output = source[keys].iloc[parents].copy().reset_index(drop=True)
    output[name] = _series(columns * len(source), "str")
    output[value] = _series(values, domain)
    operations["unpivot"] = {"selectedColumns": len(columns), "nullCells": sum(item is None for item in values)}
    operations["rowMapping"] = {
        "inputPort": 0,
        "kind": "row_major_columns",
        "columns": list(columns),
        "outputsPerInput": len(columns),
    }
    operations["columnDependencies"] = {name: list(columns), value: list(columns)}
    return output


def _pivot(spec, source, operations):
    props = spec["properties"]
    keys, column, value = props["index"], props["columns"], props["values"]
    _columns(spec, source, [*keys, column, value], "index/columns/values")
    key_rows = _key_rows(source, keys) if keys else [()] * len(source)
    groups, generated, seen, row_positions = {}, {}, {}, []
    for position, (key, cell) in enumerate(zip(key_rows, source[column])):
        category = _scalar(cell)
        if category is None:
            raise _error(
                spec,
                "PIVOT_NULL_KEY",
                f"Null pivot-column value in {column!r}, row {position}; choose its meaning explicitly before pivot.",
                field="columns",
            )
        if category not in generated:
            name = str(category)
            if not name or name in keys or name in generated.values():
                raise _error(
                    spec,
                    "COLUMN_COLLISION",
                    f"Pivot key at row {position} creates unusable/colliding output name {name!r}.",
                    field="columns",
                )
            generated[category] = name
        pair = (key, category)
        if pair in seen:
            raise _error(
                spec,
                "PIVOT_DUPLICATE",
                f"Duplicate (index, pivot key) at rows {seen[pair]} and {position}: {str(pair)[:100]}. Aggregate first if combining duplicates is intended.",
                field="index/columns",
            )
        seen[pair] = position
        if key not in groups:
            groups[key] = len(groups)
            row_positions.append(position)
    output = source[keys].iloc[row_positions].copy().reset_index(drop=True)
    domain = _nullable(source[value]).dtype
    cells = {name: [None] * len(groups) for name in generated.values()}
    for (key, category), position in seen.items():
        cells[generated[category]][groups[key]] = _scalar(source[value].iloc[position])
    for name, values in cells.items():
        output[name] = pd.Series(values, dtype=domain)
    operations["pivot"] = {
        "uniquePairs": len(seen),
        "indexGroups": len(groups),
        "generatedColumns": len(generated),
        "missingCells": len(groups) * len(generated) - len(seen),
    }
    operations["columnDependencies"] = {name: [*keys, column, value] for name in generated.values()}
    return output


def execute_native(spec, inputs):
    global pd, np
    import pandas as pd
    import numpy as np

    validate_native(spec)
    if len(inputs) != len(spec.get("inputs", [])):
        raise _error(spec, "INPUT_PORTS", "Runtime input count differs from the declared ports.", stage="contract")
    for index, frame in enumerate(inputs):
        try:
            _frame(spec, frame)
        except NativeError as error:
            # This is a consumed-table boundary, before any user callback.
            # Blaming the consumer's output prompts ineffective UDF rewrites.
            code = error.diagnostic["code"].replace("OUTPUT_", "INPUT_")
            if code == "UDF_RETURN_TYPE":
                code = "INPUT_TABLE_TYPE"
            producer = spec["inputs"][index]
            message = (
                f"Input {index} from {producer!r} is invalid; this operator's function has not run. "
                f"Repair the producing operator. {error.diagnostic['message']}"
            )
            raise _error(spec, code, message, stage="contract", field=f"inputs[{index}]") from error
    kind, props = spec["type"], spec["properties"]
    source = inputs[0] if inputs else None
    operations = {}
    if kind == "Scan":
        output = _scan(spec, operations)
    elif kind in ("Transform", "Derive"):
        output = _map_columns(spec, source, operations)
    elif kind == "Cast":
        output = _cast(spec, source, operations)
    elif kind == "Filter":
        output = _filter(spec, source, operations)
    elif kind == "Project":
        output = _project(spec, source)
    elif kind == "Aggregate":
        output = _aggregate(spec, source, operations)
    elif kind == "Join":
        output = _join(spec, inputs[0], inputs[1], operations)
    elif kind == "Union":
        output = _union(spec, inputs, operations)
    elif kind == "Window":
        output = _window(spec, source, operations)
    elif kind == "Split":
        output = _split(spec, source, operations)
    elif kind == "Explode":
        output = _explode(spec, source, operations)
    elif kind == "Unpivot":
        output = _unpivot(spec, source, operations)
    elif kind == "Pivot":
        output = _pivot(spec, source, operations)
    elif kind == "Distinct":
        columns = props.get("columns", list(source.columns))
        _columns(spec, source, columns, "columns")
        if columns:
            output = source.drop_duplicates(subset=columns, keep=props.get("keep", "first")).reset_index(drop=True)
        else:
            output = source.iloc[-1:] if props.get("keep") == "last" else source.iloc[:1]
        operations["removedRows"] = len(source) - len(output)
    elif kind == "Sort":
        _columns(spec, source, [item["col"] for item in props["by"]], "by")
        output = source.copy()
        # Repeated stable sorts explicitly preserve ties for multi-key order.
        for item in reversed(props["by"]):
            output = output.sort_values(
                item["col"],
                ascending=not item.get("desc", False),
                na_position=props.get("nulls", "last"),
                kind="stable",
            )
        output = output.reset_index(drop=True)
    elif kind == "Limit":
        start = props.get("offset", 0)
        output = source.iloc[start : start + props["n"]].copy().reset_index(drop=True)
        operations["removedRows"] = len(source) - len(output)
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
        **({"profileCollection": True} if spec.get("profileCollection") is True else {}),
        "operatorType": kind,
        "inputOperators": spec.get("inputs", []),
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
