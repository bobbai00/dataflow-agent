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


class NativeError(ValueError):
    def __init__(self, diagnostic):
        self.diagnostic = diagnostic
        super().__init__("NATIVE_ERROR_V2:" + json.dumps(diagnostic, ensure_ascii=True, separators=(",", ":")))


class _UndeclaredColumn(KeyError):
    pass


class _Row(Mapping):
    """A read-only view of one input row.

    The callback sees every input column by name. Each column it actually reads
    is recorded in `reads`, so the operator's dependencies are measured from what
    the function did rather than declared up front — that measured set is what
    flow evidence and lineage ranking consume. A name that is not a column raises
    a distinguishable KeyError so the diagnostic can list the real columns.
    """

    __slots__ = ("_index", "_order", "_values", "_reads", "_copy")

    def __init__(self, index, values, reads, order=None):
        self._index = index
        self._order = order if order is not None else tuple(index)
        self._values = values
        self._reads = reads
        self._copy = None

    def __getitem__(self, key):
        position = self._index.get(key)
        if position is None:
            raise _UndeclaredColumn(key)
        # `{**row, ...}` copies the row: Python calls keys() and then reads every
        # key in order. That copy is not a dependency, so it is not recorded;
        # any read outside that pattern is.
        copy = self._copy
        if copy is not None and copy < len(self._order) and self._order[copy] == key:
            self._copy = None if copy + 1 == len(self._order) else copy + 1
        else:
            self._copy = None
            self._reads.add(key)
        return self._values[position]

    def keys(self):
        self._copy = 0
        return list(self._order)

    def __iter__(self):
        self._copy = 0
        return iter(self._order)

    def __len__(self):
        return len(self._index)


def _rows(frame, reads):
    """Yield one `_Row` per input row over every column, cheaply."""
    index = {name: position for position, name in enumerate(frame.columns)}
    order = tuple(frame.columns)
    for values in frame.itertuples(index=False, name=None):
        yield _Row(index, tuple(map(_scalar, values)), reads, order)


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


def _is_setting(value, depth=0):
    """A registered operator's setting: a string, a finite number, True/False,
    None, or a list or dict of those (two levels)."""
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, (int, float)):
        return not isinstance(value, float) or math.isfinite(value)
    if depth >= 2:
        return False
    if isinstance(value, list):
        return all(_is_setting(item, depth + 1) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_setting(item, depth + 1) for key, item in value.items())
    return False


def _validate_function(spec, source, field, entry, parameters=None, keywords=None, tables=None):
    """`keywords` (the call's settings) marks a registered operator. With
    `tables` (the parameters the call bound to its input tables) every bound
    name must be a parameter and every parameter without a default must be
    bound; without `tables` (older definitions) the tables bind to the
    parameters without a default. Without `keywords` a callback takes exactly
    the positional parameters, as before."""
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
    expected = len(parameters) if parameters is not None else 1
    if valid:
        node = entries[0]
        args = node.args
        positional = [arg.arg for arg in args.posonlyargs + args.args]
        if keywords is None:
            valid = not (node.decorator_list or args.vararg or args.kwarg or args.kwonlyargs or args.defaults)
            # Inputs bind positionally (`function(*frames)` below), so only the arity
            # has to match the ordered inputs; the parameter names are the author's.
            valid = valid and len(positional) == expected
        elif tables is not None:
            names = positional + [arg.arg for arg in args.kwonlyargs]
            without_default = positional[: len(positional) - len(args.defaults)] + [
                arg.arg for arg, default in zip(args.kwonlyargs, args.kw_defaults) if default is None
            ]
            bound = set(tables) | set(keywords)
            valid = (
                not (node.decorator_list or args.vararg or args.kwarg or args.posonlyargs)
                and len(tables) == expected
                and all(name in names for name in bound)
                and all(name in bound for name in without_default)
            )
        else:
            required = positional[: len(positional) - len(args.defaults)]
            optional = positional[len(required):] + [arg.arg for arg in args.kwonlyargs]
            valid = (
                not (node.decorator_list or args.vararg or args.kwarg)
                and all(default is not None for default in args.kw_defaults)
                and len(required) == expected
                and all(key in optional for key in keywords)
            )
    if not valid:
        if keywords is not None and tables is not None:
            message = (
                f"Define exactly one synchronous def {entry} whose parameters the call binds by name: "
                f"the input tables ({', '.join(tables) or 'none'}) and the settings ({', '.join(keywords) or 'none'}); "
                "every parameter without a default must be bound. No decorators, positional-only or variadic parameters."
            )
        elif keywords is not None:
            message = (
                f"Define exactly one synchronous def {entry} whose parameters without a default are its "
                f"{expected} input table(s) in order ({', '.join(parameters or [])}), followed by parameters with "
                f"literal defaults; the call passed {', '.join(keywords) or 'no keywords'}. "
                "No decorators or variadic arguments."
            )
        elif parameters is not None:
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
    "Parameters": "create",
    "Scan": "create",
    "Project": "none",
    "Cast": "none",
    "Map": "none",
    "Filter": "drop",
    "Aggregate": "collapse",
    "Join": "multiply",
    "Union": "add",
    "Distinct": "drop",
    "Sort": "none",
    "Limit": "drop",
    "Window": "none",
    "Unpivot": "add",
    "Pivot": "collapse",
    "Process": "unknown",
    "Compare": "unknown",
}
DTYPES = {"str": "string", "int64": "Int64", "float64": "Float64", "bool": "boolean", "datetime": "datetime64[ns, UTC]"}

#: pandas' name for a serialized index. A table whose pandas row labels are not
#: 0..n-1 carries them in this column between operators, the way pandas'
#: to_parquet stores such an index. The engine's statistics and profiles and
#: every result the agent reads leave it out; operators never see it.
ROW_LABEL = "__index_level_0__"
#: One output row per input row, in input order: labels pass through.
LABELS_PASS = {"Project", "Cast", "Map", "Window"}
#: A subset or reordering of the input rows: each row keeps its label, as a
#: boolean mask, drop_duplicates, sort_values and head keep it in pandas.
#: Every other operator builds new rows, numbered from 0 as groupby, merge,
#: concat(ignore_index=True), melt and pivot number them.
LABELS_FOLLOW = {"Filter", "Distinct", "Sort", "Limit"}


def validate_native(spec):
    """Validate Python source/port contracts without importing runtime packages."""
    kind = spec["type"]
    if kind not in ROW_EFFECTS:
        raise _error(spec, "OPERATOR_UNAVAILABLE", f"Unknown operator type {kind!r}.", stage="validate")
    inputs = spec.get("inputs", [])
    for name in [spec.get("id", "operator"), *inputs]:
        if not isinstance(name, str) or not name.isidentifier() or keyword.iskeyword(name):
            raise _error(spec, "OPERATOR_ID", f"Not a Python identifier: {name!r}", stage="validate")
    if len(set(inputs)) != len(inputs) and kind != "Join":
        raise _error(spec, "INPUT_PORTS", "Only Join may reference the same input twice.", stage="validate")
    expected = 0 if kind in ("Scan", "Parameters") else 2 if kind in ("Join", "Compare") else None if kind in ("Union", "Process") else 1
    if expected is not None and len(inputs) != expected:
        raise _error(spec, "INPUT_PORTS", f"{kind} requires {expected} input ports.", stage="validate")
    if kind == "Union" and len(inputs) < 2:
        raise _error(spec, "INPUT_PORTS", "Union requires at least two inputs.", stage="validate")
    props = spec["properties"]

    def choice(value, allowed, code, field):
        if value not in allowed:
            raise _error(
                spec,
                code,
                f"{field} must be one of {', '.join(repr(a) for a in allowed)}, got {value!r}.",
                stage="validate",
                field=field,
            )

    def names_list(value, code, field):
        if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
            raise _error(spec, code, f"{field} must be a nonempty list of column names.", stage="validate", field=field)
        if len(set(value)) != len(value):
            raise _error(spec, "COLUMN_COLLISION", f"{field} lists a column twice.", stage="validate", field=field)

    if kind == "Project":
        if "keep" in props and "drop" in props:
            raise _error(spec, "PROJECT_OPTIONS", "keep and drop are mutually exclusive.", stage="validate")
        if not any(key in props for key in ("keep", "drop", "rename")):
            raise _error(spec, "PROJECT_OPTIONS", "Provide keep, drop or rename.", stage="validate")
        for key in ("keep", "drop"):
            if key in props:
                names_list(props[key], "PROJECT_OPTIONS", key)
        if "rename" in props and (not isinstance(props["rename"], dict) or not props["rename"]):
            raise _error(
                spec,
                "PROJECT_OPTIONS",
                "rename must be a nonempty {old: new} mapping.",
                stage="validate",
                field="rename",
            )
    elif kind == "Cast":
        choice(props.get("errors", "raise"), ("raise", "null"), "CAST_OPTIONS", "errors")
    elif kind == "Distinct":
        choice(props.get("keep", "first"), ("first", "last"), "DISTINCT_ARGUMENT", "keep")
        if "columns" in props:
            names_list(props["columns"], "DISTINCT_ARGUMENT", "columns")
    elif kind == "Union":
        choice(props.get("schema", "strict"), ("strict", "align"), "UNION_ARGUMENT", "schema")
    elif kind == "Sort":
        keys = props.get("by")
        if not isinstance(keys, list) or not keys:
            raise _error(spec, "SORT_ARGUMENT", "by needs at least one sort key.", stage="validate", field="by")
        for i, item in enumerate(keys):
            if not isinstance(item, dict) or not isinstance(item.get("col"), str) or not item["col"]:
                raise _error(spec, "SORT_ARGUMENT", "Each sort key names a column.", stage="validate", field=f"by[{i}]")
            if "desc" in item and not isinstance(item["desc"], bool):
                raise _error(
                    spec, "SORT_ARGUMENT", "Sort direction is asc or desc.", stage="validate", field=f"by[{i}]"
                )
        choice(props.get("nulls", "last"), ("first", "last"), "SORT_ARGUMENT", "nulls")
    elif kind == "Limit":
        n, offset = props.get("n"), props.get("offset", 0)
        if type(n) is not int or n < 1:
            raise _error(spec, "LIMIT_ARGUMENT", f"n must be an integer >= 1, got {n!r}.", stage="validate", field="n")
        if type(offset) is not int or offset < 0:
            raise _error(
                spec,
                "LIMIT_ARGUMENT",
                f"offset must be an integer >= 0, got {offset!r}.",
                stage="validate",
                field="offset",
            )
    if kind == "Cast":
        names = []
        for i, item in enumerate(props["columns"]):
            field = f"columns[{i}]"
            if item["dtype"] not in DTYPES:
                raise _error(spec, "DTYPE", f"Unsupported dtype {item['dtype']!r}.", stage="validate", field=field)
            names.append(item["column"])
            if item["dtype"] != "datetime" and ("format" in item or "timezone" in item):
                raise _error(
                    spec, "CAST_OPTIONS", "format/timezone apply only to datetime.", stage="validate", field=field
                )
        if len(set(names)) != len(names):
            raise _error(spec, "COLUMN_COLLISION", "Submit each output column once.", stage="validate", field="columns")
    if kind in ("Filter", "Map"):
        _validate_function(spec, props["func"], "func", props.get("entry", "apply"))
    elif kind == "Process":
        entry = props.get("entry", "process" if inputs else "load")
        params = props.get("params")
        tables = props.get("tables")
        if params is not None and (
            not isinstance(params, dict)
            or any(not isinstance(name, str) or not _is_setting(value) for name, value in params.items())
        ):
            raise _error(
                spec,
                "PARAMETER_VALUE",
                "Operator settings must be named literals: strings, finite numbers, True/False, None, or lists and dicts of those.",
                stage="validate",
            )
        if tables is not None and (
            not isinstance(tables, list) or len(tables) != len(inputs) or any(not isinstance(name, str) for name in tables)
        ):
            raise _error(spec, "PARAMETER_VALUE", "Bind one parameter name per input table.", stage="validate")
        _validate_function(spec, props["code"], "code", entry, inputs, params, tables)
    elif kind == "Aggregate":
        aggregates = props.get("aggregations", [])
        if not aggregates:
            raise _error(spec, "AGGREGATE_ARGUMENT", "Provide at least one aggregation.", stage="validate")
        if not isinstance(props.get("dropna", True), bool):
            raise _error(spec, "AGGREGATE_ARGUMENT", "dropna must be True or False.", stage="validate", field="dropna")
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
    elif kind == "Compare":
        if "keys" in props:
            names_list(props["keys"], "COMPARE_KEYS", "keys")
    elif kind == "Parameters":
        values = props.get("values")
        if not isinstance(values, dict) or not values or any(
            not isinstance(name, str) or not name or
            (value is not None and type(value) not in (str, int, float, bool)) or
            (type(value) is float and not math.isfinite(value))
            for name, value in (values or {}).items()
        ):
            raise _error(spec, "PARAMETER_VALUE", "Parameters require named finite scalar values.", stage="validate")
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
    if isinstance(error, _UndeclaredColumn):
        code, message = (
            "MISSING_COLUMN",
            f"The function read column {error.args[0]!r}, which the input table does not have.",
        )
    elif isinstance(error, ImportError):
        code, message = "PYTHON_IMPORT", f"{type(error).__name__}: {error}"
    else:
        code, message = "CALLBACK_RUNTIME", f"{type(error).__name__}: {error}"
    return _error(
        spec,
        code,
        message,
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

    def call(*args, **kwargs):
        try:
            return function(*args, **kwargs)
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
            spec, "PROCESS_RETURN_TYPE", f"Expected a pandas DataFrame, got {type(value).__name__}.", stage="contract"
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
        if pd.api.types.is_datetime64_any_dtype(column.dtype) and getattr(column.dt, "tz", None) is None:
            raise _error(
                spec,
                "OUTPUT_VALUE_TYPE",
                f"Column {name!r} contains timezone-naive datetimes. Localize them (e.g. .dt.tz_localize('UTC')) or return ISO-8601 strings.",
                stage="contract",
            )
        if column.dtype == object:
            inferred = pd.api.types.infer_dtype(column, skipna=True)
            if inferred in ("datetime", "date") and any(
                getattr(v, "tzinfo", None) is None for v in column.dropna() if hasattr(v, "tzinfo")
            ):
                raise _error(
                    spec,
                    "OUTPUT_VALUE_TYPE",
                    f"Column {name!r} contains timezone-naive datetimes. Localize them (e.g. .dt.tz_localize('UTC')) or return ISO-8601 strings.",
                    stage="contract",
                )
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
    if keys and props.get("dropna", True):
        # As pandas groupby(dropna=True): a row whose key has a null in any
        # `by` column belongs to no group. dropna=False keeps them as groups.
        null_key = frame[keys].isna().any(axis=1).to_numpy()
        operations["nullKeyRows"] = int(null_key.sum())
        if null_key.any():
            operations["nullKeyColumns"] = {
                name: int(frame[name].isna().sum()) for name in keys if frame[name].isna().any()
            }
            frame = frame[~null_key].reset_index(drop=True)
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


JOIN_TYPES = ("inner", "left", "right", "full", "cross")
JOIN_VALIDATIONS = ("many_to_many", "many_to_one", "one_to_many", "one_to_one")


def _join_keys(spec):
    props = spec["properties"]
    for value, allowed, field in (
        (props.get("type", "inner"), JOIN_TYPES, "how"),
        (props.get("validate", "many_to_many"), JOIN_VALIDATIONS, "validate"),
    ):
        if value not in allowed:
            raise _error(
                spec,
                "JOIN_ARGUMENT",
                f"{field} must be one of {', '.join(repr(a) for a in allowed)}, got {value!r}.",
                stage="validate",
                field=field,
            )
    if not isinstance(props.get("rightSuffix", "_right"), str) or not props.get("rightSuffix", "_right"):
        raise _error(spec, "JOIN_ARGUMENT", "suffix must be a nonempty string.", stage="validate", field="suffix")
    if not isinstance(props.get("nullsEqual", False), bool):
        raise _error(spec, "JOIN_ARGUMENT", "nulls_equal must be true or false.", stage="validate", field="nulls_equal")
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


def _compare(spec, a, b, operations):
    """Row-level difference of two tables that mean the same thing (two versions
    of a ranking, a cohort, a score table). Deterministic and typed: the model
    never writes comparison code, so the two sides stay the exact tables."""
    props = spec["properties"]
    shared = [column for column in a.columns if column in b.columns]
    keys = props.get("keys")
    if keys:
        _columns(spec, a, keys, "keys")
        _columns(spec, b, keys, "keys")
    else:
        keys = [column for column in shared if _logical_dtype(a[column]) in ("str", "bool")]
    left, right = a.copy(), b.copy()
    if not keys:
        left["row"] = range(len(left))
        right["row"] = range(len(right))
        keys = ["row"]
    for side, name in ((left, "A"), (right, "B")):
        if side.duplicated(subset=keys).any():
            raise _error(
                spec,
                "COMPARE_KEYS",
                f"Keys {keys} are not unique in {name}; aggregate or distinct first, or choose keys that identify a row.",
                stage="contract",
                field="keys",
            )
    values = [column for column in shared if column not in keys]
    la = left[keys + values].rename(columns={column: f"{column}_a" for column in values})
    lb = right[keys + values].rename(columns={column: f"{column}_b" for column in values})
    merged = la.merge(lb, on=keys, how="outer", indicator="__side", sort=False)
    merged["in_a"] = merged["__side"].isin(["both", "left_only"])
    merged["in_b"] = merged["__side"].isin(["both", "right_only"])
    merged = merged.drop(columns="__side")
    changed = {}
    ordered = list(keys) + ["in_a", "in_b"]
    for column in values:
        ordered += [f"{column}_a", f"{column}_b"]
        both = merged["in_a"] & merged["in_b"]
        if _logical_dtype(a[column]) in ("int64", "float64") and _logical_dtype(b[column]) in ("int64", "float64"):
            delta = pd.to_numeric(merged[f"{column}_b"], errors="coerce") - pd.to_numeric(
                merged[f"{column}_a"], errors="coerce"
            )
            merged[f"{column}_delta"] = delta.where(both)
            ordered.append(f"{column}_delta")
            changed[column] = int((delta.where(both).abs() > 1e-9).sum())
        else:
            same = merged[f"{column}_a"].astype("string") == merged[f"{column}_b"].astype("string")
            changed[column] = int((both & ~same.fillna(False)).sum())
    output = merged[ordered].reset_index(drop=True)
    operations["compare"] = {
        "keys": keys,
        "rowsA": len(a),
        "rowsB": len(b),
        "inBoth": int((output["in_a"] & output["in_b"]).sum()),
        "onlyA": int((output["in_a"] & ~output["in_b"]).sum()),
        "onlyB": int((~output["in_a"] & output["in_b"]).sum()),
        "changed": changed,
    }
    return output


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
            unmatched = sorted(
                ((key, n) for key, n in counts[i].items() if key not in common), key=lambda kv: (-kv[1], str(kv[0]))
            )[:4]
            facts[port] = {
                "unmatchedExamples": [
                    {
                        "key": (None if key[0] is None else str(key[0])[:60])
                        if isinstance(key, tuple) and len(key) == 1
                        else [None if v is None else str(v)[:60] for v in key]
                        if isinstance(key, tuple)
                        else str(key)[:60],
                        "rows": n,
                    }
                    for key, n in unmatched
                ],
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
    if mode == "strict":
        first = set(frames[0].columns)
        for position, frame in enumerate(frames[1:], start=2):
            columns = set(frame.columns)
            if columns == first:
                continue
            missing = sorted(first - columns)
            extra = sorted(columns - first)
            detail = "; ".join(
                part
                for part in (
                    f"input {position} lacks {missing}" if missing else "",
                    f"input {position} adds {extra}" if extra else "",
                )
                if part
            )
            raise _error(
                spec,
                "UNION_SCHEMA",
                f"Strict union requires the same named columns: {detail}. "
                'Project or rename the inputs to match, or use schema="align" to fill absent columns with null.',
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
        reject("names requires header=False; use project(T, rename={...}) to rename an existing header.")
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
        reject(
            "Binary pointer previews cannot use skipLines; inspect metadata without an offset or load the file with a process function."
        )
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
            "This binary format needs a process loader (a Python function); Scan preview can show its file metadata.",
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


def _pandas_header(cells):
    """Column names as pandas.read_csv (and read_excel, read_html) derives
    them from a header row: a blank cell is `Unnamed: <index>`, and a
    repeated name gets `.1`, `.2`, ... The order is pandas': named columns
    are numbered before unnamed ones, and a suffix that another header cell
    already spells is skipped (`b, b, b.1` gives `b, b.2, b.1`). Returns the
    names, the blank cells' names, and the renamed columns."""
    names, unnamed = [], []
    for index, value in enumerate(cells):
        if _missing(value) or str(value) == "":
            names.append(f"Unnamed: {index}")
            unnamed.append(index)
        else:
            names.append(str(value))
    blank = set(unnamed)
    counts, renamed = {}, []
    for index in [i for i in range(len(names)) if i not in blank] + unnamed:
        name = original = names[index]
        current = counts.get(name, 0)
        while current > 0:
            counts[original] = current + 1
            name = f"{original}.{current}"
            current = current + 1 if name in names else counts.get(name, 0)
        if name != original:
            renamed.append({"column": index, "header": original, "name": name})
        names[index] = name
        counts[name] = current + 1
    return names, [names[i] for i in unnamed], sorted(renamed, key=lambda item: item["column"])


# pandas.read_csv's default missing-value tokens as pandas read them before
# 2.0 (pandas._libs.parsers.STR_NA_VALUES in 1.5; a test checks them against
# the installed pandas). pandas 2.0 added "None", which stays a value here: the
# LongDS answer keys count it, since it is the Kaggle surveys' opt-out answer
# (survey-2022 task 2 turn 7 counts 5,177 respondents; reading "None" as
# missing gives 3,127). The empty string is already read as missing.
PANDAS_NA_TOKENS = frozenset(
    {
        "#N/A",
        "#N/A N/A",
        "#NA",
        "-1.#IND",
        "-1.#QNAN",
        "-NaN",
        "-nan",
        "1.#IND",
        "1.#QNAN",
        "<NA>",
        "N/A",
        "NA",
        "NULL",
        "NaN",
        "n/a",
        "nan",
        "null",
    }
)


def _scan_missing_tokens(frame, source_meta):
    """Cells that pandas reads as missing by default ("NA", "N/A", "null",
    "nan", ...) are missing here too: analyses and reference answers written
    with pandas count them as missing, and a column of numbers with "NA" gaps
    is numeric in pandas. "None" is a value (see PANDAS_NA_TOKENS). Whole-cell matches only, as in pandas
    ("NA" but not " NA" or "na"); header cells are names and stay as they
    are. The converted cells are counted per column and token for the
    observation, since a token can be a real value (all_text=True keeps
    them all as text)."""
    converted = {}
    for name in frame.columns:
        series = frame[name]
        if series.dtype == object:
            mask = series.map(lambda value: isinstance(value, str) and value in PANDAS_NA_TOKENS).astype(bool)
        elif pd.api.types.is_string_dtype(series.dtype):
            mask = pd.Series(series.isin(PANDAS_NA_TOKENS), index=series.index).fillna(False).astype(bool)
        else:
            continue
        if mask.any():
            converted[name] = {str(token): int(n) for token, n in series[mask].value_counts().items()}
            frame[name] = series.mask(mask)
    if converted:
        source_meta["missingTokens"] = converted
    return frame


def _scan_header(spec, raw, source_meta):
    props = spec["properties"]
    if props.get("header", True):
        if raw.empty:
            raise _error(
                spec,
                "SCAN_HEADER",
                "No header is available. Use a raw preview, or header=False with explicit names for an empty source.",
                field="header",
            )
        # pandas' names for blank and repeated header cells, which analyses
        # and reference answers written with pandas use (`Unnamed: 249`,
        # `Q7.1`).
        names, unresolved, renamed = _pandas_header(raw.iloc[0])
        source_meta["unresolvedHeaders"] = unresolved
        if renamed:
            source_meta["renamedHeaders"] = renamed
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
            repeated = sorted({name for name in names if names.count(name) > 1})
            raise _error(
                spec,
                "SCAN_NAMES",
                f"names=[...] repeats {', '.join(repr(name) for name in repeated[:5])}; give each column its own name.",
                field="names",
            )
    output.columns = names
    all_text = props.get("allText", False)
    if not all_text:
        output = _scan_missing_tokens(output, source_meta)
    return _scan_infer(output, all_text, infer_text=source_meta["format"] != "excel")


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
                    "Binary file metadata only; not parsed data rows. Use full Scan for parquet or a process loader for other binary formats."
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
    # Delimited text keeps line breaks inside quoted fields byte for byte, as
    # pandas.read_csv does: universal-newline decoding turned "\r\n" in a
    # quoted cell into "\n" (careerVillage: 7,719 carriage returns lost, so
    # text lengths differed from every pandas-based reference).
    delimited = fmt not in ("json", "fwf", "whitespace")
    with path.open(encoding=encoding, newline="" if delimited else None) as stream:
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
                                        f"Flattened JSON field collision at {name!r}; use a process parser with explicit names"
                                    )
                                flat[name] = value

                    visit(record)
                    flattened.append(flat)
                output = pd.DataFrame(flattened, dtype=object)
            else:
                raise ValueError(
                    "JSON Scan expects records, one object, or a dictionary of column arrays; use a process loader for other layouts"
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
        except pd.errors.ParserError as error:
            title = _title_lines(path, encoding, source_meta.get("delim"), skip)
            if title is None:
                raise
            raise _error(
                spec,
                "SCAN_PARSE",
                f"Cannot read {path.name!r} as {fmt}: {str(error).strip()} Its first {title} line(s) are a title "
                f"above the table (one field or blank, where the table rows have more): "
                f"skip_lines={skip + title} starts at the header.",
                field="files",
            ) from error
        return _scan_header(spec, raw, source_meta)


def _title_lines(path, encoding, delimiter, skip):
    """Lines above the header that are not table rows, such as a Google
    Trends export's `Category: All categories` and a blank line: how many
    leading records have one field or none, before the field count that most
    of the first 200 records share. None when the file does not start that
    way, so the parser's own error stands."""
    import csv
    from itertools import islice

    if not delimiter or delimiter == "whitespace":
        return None
    try:
        with path.open(encoding=encoding, newline="") as stream:
            for _ in range(skip):
                stream.readline()
            widths = [len(row) for row in islice(csv.reader(stream, delimiter=delimiter), 200)]
    except (csv.Error, UnicodeDecodeError, OSError):
        return None
    filled = [width for width in widths if width]
    if len(filled) < 3:
        return None
    common = Counter(filled).most_common(1)[0][0]
    if common < 2:
        return None
    first = widths.index(common)
    return first if first and all(width <= 1 for width in widths[:first]) else None


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
                f"Reader for {fmt} is unavailable: {error}. Install its worker dependency or load the file with a process function.",
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


def _map_dtype(spec, name, values, fallback, func, entry):
    """Infer one output column's type from the values a map produced.
    bool only when every value is bool (True is an int in Python); int64 and
    float64 mix to float64; anything else must be one kind; an all-None
    column keeps the input column's type when it passed through, else str."""
    kinds = {}
    for index, value in enumerate(values):
        if value is None:
            continue
        if isinstance(value, bool):
            kind = "bool"
        elif isinstance(value, int):
            kind = "int64"
        elif isinstance(value, float):
            kind = "float64"
        elif isinstance(value, str):
            kind = "str"
        elif isinstance(value, (datetime.datetime, pd.Timestamp)):
            if value.tzinfo is None:
                raise _error(
                    spec,
                    "OUTPUT_VALUE_TYPE",
                    f"map column {name!r} at row {index} is a timezone-naive datetime; "
                    "attach a timezone (e.g. datetime.timezone.utc) or return an ISO-8601 string.",
                    stage="contract",
                    field="func",
                    source=_location(func, entry, 1),
                )
            kind = "datetime"
        else:
            raise _error(
                spec,
                "OUTPUT_VALUE_TYPE",
                f"map column {name!r} at row {index} is a {type(value).__name__}; return scalar cells "
                "(str, int, float, bool, datetime or None) and serialize nested data as JSON strings.",
                stage="contract",
                field="func",
                source=_location(func, entry, 1),
            )
        kinds.setdefault(kind, (index, value))
    if not kinds:
        return fallback or "str"
    if set(kinds) <= {"int64", "float64"}:
        return "float64" if "float64" in kinds else "int64"
    if len(kinds) == 1:
        return next(iter(kinds))
    (first_kind, (first_at, first_value)), (other_kind, (other_at, other_value)) = sorted(
        kinds.items(), key=lambda item: item[1][0]
    )[:2]
    raise _error(
        spec,
        "OUTPUT_VALUE_TYPE",
        f"map column {name!r} mixes types: row {first_at} has {first_value!r} ({first_kind}) but row {other_at} has "
        f"{other_value!r} ({other_kind}). Return one type per column (None is allowed) or convert explicitly.",
        stage="contract",
        field="func",
        source=_location(func, entry, 1),
    )


def _map(spec, source, operations):
    """Map: `fn(row)` returns the new row as a dict and those dicts are the
    output table. Exactly one row out per row in, in order; every row returns
    the same keys; values are scalars or None; column types are inferred from
    the values (see `_map_dtype`). `{**row, "x": ...}` keeps the input columns.
    The columns the function read are recorded as measured dependencies."""
    props = spec["properties"]
    entry = props.get("entry", "apply")
    function = _function(spec, props["func"], "func", entry)
    reads = set()
    keys = None
    columns = {}

    def accept(index, value):
        nonlocal keys, columns
        if not isinstance(value, dict):
            raise _error(
                spec,
                "CALLBACK_RETURN_TYPE",
                f"map must return the new row as a dict, got {type(value).__name__} at row {index}. "
                'Use {**row, "column": value} to keep the input columns and add one.',
                stage="contract",
                field="func",
                source=_location(props["func"], entry, 1),
            )
        row_keys = list(value.keys())
        if keys is None:
            if not row_keys or any(not isinstance(k, str) or not k for k in row_keys):
                raise _error(
                    spec,
                    "MAP_SCHEMA",
                    "map must return a dict with at least one non-empty string key; the keys are the output columns.",
                    stage="contract",
                    field="func",
                    source=_location(props["func"], entry, 1),
                )
            keys = row_keys
            columns = {key: [] for key in keys}
        elif set(row_keys) != set(keys):
            raise _error(
                spec,
                "MAP_SCHEMA",
                f"map returned columns {sorted(row_keys)!r} at row {index} but {sorted(keys)!r} at row 0; "
                "every row must return the same keys.",
                stage="contract",
                field="func",
                source=_location(props["func"], entry, 1),
            )
        for key in keys:
            columns[key].append(_scalar(value[key]))

    for index, row in enumerate(_rows(source, reads)):
        accept(index, function(row))
    if keys is None:
        # Empty input: learn the keys from one probe call on an all-None row;
        # if the function cannot run on that, the output keeps the input schema.
        probe = _Row(
            {name: position for position, name in enumerate(source.columns)}, (None,) * len(source.columns), set()
        )
        try:
            probed = function(probe)
        except NativeError:
            probed = None
        if isinstance(probed, dict) and probed and all(isinstance(k, str) and k for k in probed):
            keys = list(probed.keys())
            columns = {key: [] for key in keys}
        else:
            keys = list(source.columns)
            columns = {key: [] for key in keys}
    output = pd.DataFrame(index=range(len(source)))
    for key in keys:
        fallback = _dtype(source[key]) if key in source.columns else None
        dtype = _map_dtype(spec, key, columns[key], fallback, props["func"], entry)
        try:
            output[key] = _series(columns[key], dtype)
        except (ValueError, TypeError) as error:
            raise _error(
                spec,
                "OUTPUT_VALUE_TYPE",
                f"map column {key!r}: {error}. Datetimes must carry a timezone.",
                stage="contract",
                field="func",
            ) from error
    operations["readColumns"] = sorted(reads)
    operations["columnDependencies"] = {key: ([key] if key in source.columns else sorted(reads)) for key in keys}
    operations["addedColumns"] = [key for key in keys if key not in source.columns]
    operations["droppedColumns"] = [name for name in source.columns if name not in keys]
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
                        f"Cannot cast {name!r} to {item['dtype']}: {error}. Normalize the input or explicitly set errors=\"null\".",
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
    entry = props.get("entry", "apply")
    function = _function(spec, props["func"], "func", entry)
    mask, missing = [], 0
    reads = set()
    for row in _rows(source, reads):
        value = _scalar(function(row))
        if value is None:
            # None means "no verdict": the row is dropped, and the count is reported.
            missing += 1
            value = False
        if not isinstance(value, bool):
            raise _error(
                spec,
                "CALLBACK_RETURN_TYPE",
                f"Filter requires bool or None, got {type(value).__name__}.",
                stage="contract",
                field="func",
                source=_location(props["func"], entry, 1),
            )
        mask.append(value)
    operations.update(
        {
            "keptRows": sum(mask),
            "rejectedRows": len(mask) - sum(mask),
            "nullPredicates": missing,
            "predicateColumns": sorted(reads),
        }
    )
    # The kept rows' positions stay the index: execute_native maps them to labels.
    return source.iloc[[i for i, keep in enumerate(mask) if keep]].copy()


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


def _split_labels(frame):
    """The frame without its label column, indexed by position, and its row
    labels (None when they are 0..n-1)."""
    if not isinstance(frame, pd.DataFrame):
        return frame, None
    labels = None
    if ROW_LABEL in frame.columns:
        labels = frame[ROW_LABEL].to_numpy(dtype="int64")
        frame = frame.drop(columns=[ROW_LABEL])
    return frame.reset_index(drop=True), labels


def _returned_labels(frame):
    """A process function's result as a table, and its row labels. An integer
    index is row labels, as in pandas (None when it is 0..n-1). A named index
    holds data, such as the keys of a groupby that was not reset, and becomes
    columns as `reset_index()` makes them. Any other index is dropped."""
    index = frame.index
    if any(name is not None for name in index.names):
        try:
            return frame.reset_index(), None
        except ValueError:
            return frame.reset_index(drop=True), None
    if isinstance(index, pd.MultiIndex) or not pd.api.types.is_integer_dtype(index.dtype):
        return frame.reset_index(drop=True), None
    labels = index.to_numpy(dtype="int64")
    return frame.reset_index(drop=True), (None if np.array_equal(labels, np.arange(len(labels))) else labels)


def _attach_labels(output, labels):
    if labels is None or np.array_equal(labels, np.arange(len(output))):
        return output
    if len(labels) != len(output):
        raise AssertionError("row labels must match the output rows")
    output[ROW_LABEL] = pd.array(labels, dtype="Int64")
    return output


def execute_native(spec, inputs):
    global pd, np
    import pandas as pd
    import numpy as np

    validate_native(spec)
    if len(inputs) != len(spec.get("inputs", [])):
        raise _error(spec, "INPUT_PORTS", "Runtime input count differs from the declared ports.", stage="contract")
    split = [_split_labels(frame) for frame in inputs]
    inputs = [frame for frame, _ in split]
    labels = [row_labels for _, row_labels in split]
    for index, frame in enumerate(inputs):
        try:
            _frame(spec, frame)
        except NativeError as error:
            # This is a consumed-table boundary, before any user callback.
            # Blaming the consumer's output prompts ineffective process rewrites.
            code = error.diagnostic["code"].replace("OUTPUT_", "INPUT_")
            if code == "PROCESS_RETURN_TYPE":
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
    output_labels = None
    if kind == "Parameters":
        output = pd.DataFrame([props["values"]])
    elif kind == "Scan":
        output = _scan(spec, operations)
    elif kind == "Map":
        output = _map(spec, source, operations)
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
    elif kind == "Compare":
        output = _compare(spec, inputs[0], inputs[1], operations)
    elif kind == "Union":
        output = _union(spec, inputs, operations)
    elif kind == "Window":
        output = _window(spec, source, operations)
    elif kind == "Unpivot":
        output = _unpivot(spec, source, operations)
    elif kind == "Pivot":
        output = _pivot(spec, source, operations)
    elif kind == "Distinct":
        columns = props.get("columns", list(source.columns))
        _columns(spec, source, columns, "columns")
        if columns:
            output = source.drop_duplicates(subset=columns, keep=props.get("keep", "first"))
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
    elif kind == "Limit":
        start = props.get("offset", 0)
        output = source.iloc[start : start + props["n"]].copy()
        operations["removedRows"] = len(source) - len(output)
    elif kind == "Process":
        entry = props.get("entry", "process" if inputs else "load")
        function = _function(spec, props["code"], "code", entry)
        params = props.get("params")
        tables = props.get("tables")

        def given(position, frame):
            # The function sees each table's pandas row labels as its index.
            copy = frame.copy(deep=True)
            if labels[position] is not None:
                copy.index = pd.Index(labels[position])
            return copy

        if params is not None and tables is not None:
            # A registered operator: the tables and the settings bind to the
            # parameters by name; the function's defaults fill the rest.
            frames = dict(zip(tables, (given(i, frame) for i, frame in enumerate(inputs))))
            output = _frame(spec, function(**frames, **params))
        else:
            output = _frame(spec, function(*[given(i, frame) for i, frame in enumerate(inputs)], **(params or {})))
        output, output_labels = _returned_labels(output)
    else:
        raise _error(spec, "OPERATOR_UNAVAILABLE", f"Runtime implementation unavailable for {kind}.", stage="validate")
    if kind in LABELS_FOLLOW:
        positions = output.index.to_numpy()
        output = output.reset_index(drop=True)
        output_labels = (labels[0] if labels[0] is not None else np.arange(len(source)))[positions]
    elif kind in LABELS_PASS:
        output = output.reset_index(drop=True)
        output_labels = labels[0]
    _frame(spec, output)
    if ROW_EFFECTS[kind] == "none" and len(output) != len(source):
        raise _error(spec, "ROW_CONTRACT", "A row-preserving operator changed the row count.", stage="contract")
    output = _attach_labels(output, output_labels)
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

    request = json.load(sys.stdin)
    if isinstance(request, dict) and "program" in request:
        # Parse a native program (see program_parser.py); no operator semantics.
        from program_parser import parse_program

        print(json.dumps(parse_program(request["program"]), ensure_ascii=True))
    elif isinstance(request, dict) and ("lift" in request or "nearDuplicates" in request):
        # Source-level services for the model's own operators (program_lift.py).
        from program_lift import serve

        print(json.dumps(serve(request), ensure_ascii=True))
    else:
        # Validate one spec or a list of specs: Python syntax and entry signatures
        # of every function slot, plus argument contracts. Nothing is executed.
        specs = request if isinstance(request, list) else [request]
        results = []
        for spec in specs:
            try:
                validate_native(spec)
                results.append({"ok": True})
            except NativeError as error:
                results.append({"ok": False, "diagnostic": error.diagnostic})
        print(json.dumps(results if isinstance(request, list) else results[0]))
