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
        # Inputs bind positionally (`function(*frames)` below), so only the arity
        # has to match the ordered inputs; the parameter names are the author's.
        expected = len(parameters) if parameters is not None else 1
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
}
DTYPES = {"str": "string", "int64": "Int64", "float64": "Float64", "bool": "boolean", "datetime": "datetime64[ns, UTC]"}


def validate_native(spec):
    """Validate Python source/port contracts without importing runtime packages."""
    kind = spec["type"]
    if kind not in ROW_EFFECTS:
        raise _error(spec, "OPERATOR_UNAVAILABLE", f"Unknown operator type {kind!r}.", stage="validate")
    inputs = spec.get("inputs", [])
    for name in [spec.get("id", "operator"), *inputs]:
        if not isinstance(name, str) or not name.isidentifier() or keyword.iskeyword(name):
            raise _error(spec, "OPERATOR_ID", f"Not a Python identifier: {name!r}", stage="validate")
    if len(set(inputs)) != len(inputs) and kind != "Join" and not spec.get("graph"):
        raise _error(spec, "INPUT_PORTS", "Only Join may reference the same input twice.", stage="validate")
    expected = 0 if kind == "Scan" else 2 if kind == "Join" else None if kind in ("Union", "Process") else 1
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
        _validate_function(spec, props["code"], "code", props.get("entry", "process" if inputs else "load"), inputs)
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
    if kind == "str":
        # Text has no float round trip to avoid, and astype builds the same
        # StringArray without first copying every cell into a Python list.
        return series.astype(DTYPES[kind])
    return pd.Series(series.tolist(), index=series.index, name=series.name, dtype=DTYPES[kind])


def _key_rows(frame, columns):
    return [tuple(map(_scalar, row)) for row in frame[columns].itertuples(index=False, name=None)]


_WITNESS_LIMIT = 3
_WITNESS_WIDTH = 8
_WITNESS_VALUE_CHARS = 96


def _witness(values, count):
    """Bound the display, preserving types and counts of the original values.

    These are first-encountered examples, not top values or random samples.
    Clipping never becomes the identity used for counting or joining.
    """
    encoded, truncated = [], len(values) > _WITNESS_WIDTH
    for raw in values[:_WITNESS_WIDTH]:
        value = _scalar(raw)
        if value is None:
            encoded.append(None)
            continue
        if isinstance(value, bool):
            kind = "bool"
        elif isinstance(value, numbers.Integral):
            if not -(1 << 63) <= value < (1 << 63):
                return None
            kind, value = "int64", str(value)
        elif isinstance(value, numbers.Real):
            kind, value = "float64", float(value)
            if not math.isfinite(value):
                return None
        elif isinstance(value, (datetime.datetime, pd.Timestamp, np.datetime64)):
            stamp = pd.Timestamp(value)
            if stamp.tzinfo is None:
                return None
            stamp = stamp.tz_convert("UTC")
            kind = "datetime"
            value = (
                f"{stamp.year:04d}-{stamp.month:02d}-{stamp.day:02d}T"
                f"{stamp.hour:02d}:{stamp.minute:02d}:{stamp.second:02d}."
                f"{stamp.microsecond * 1000 + stamp.nanosecond:09d}+00:00"
            )
        elif isinstance(value, str):
            kind = "str"
            truncated |= len(value) > _WITNESS_VALUE_CHARS
            value = value[:_WITNESS_VALUE_CHARS]
        else:
            return None
        encoded.append({"type": kind, "value": value})
    return {"values": encoded, "count": count, "truncated": truncated}


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
            if spec.get("profileCollection") is True:
                unmatched, duplicates = [], []
                for key, occurrences in counts[i].items():
                    wants_unmatched = key not in common and len(unmatched) < _WITNESS_LIMIT
                    wants_duplicate = occurrences > 1 and len(duplicates) < _WITNESS_LIMIT
                    if wants_unmatched or wants_duplicate:
                        example = _witness(key, occurrences)
                        if example is not None:
                            if wants_unmatched:
                                unmatched.append(example)
                            if wants_duplicate:
                                duplicates.append(example)
                    if len(unmatched) == len(duplicates) == _WITNESS_LIMIT:
                        break
                facts[port]["unmatchedExamples"] = unmatched
                facts[port]["duplicateExamples"] = duplicates
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


def _aligned(frame):
    """Whether _union of this frame alone returns it unchanged: rows labelled
    0..n-1 and every column already in the nullable dtype _nullable gives it."""
    if not frame.index.equals(pd.RangeIndex(len(frame))):
        return False
    for name in frame.columns:
        kind = _logical_dtype(frame[name])
        if kind is None or (kind != "datetime" and frame[name].dtype != pd.api.types.pandas_dtype(DTYPES[kind])):
            return False
    return True


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
            scanning = spec["type"] == "Scan"
            raise _error(
                spec,
                "UNION_TYPE",
                (
                    f"Files infer incompatible types {sorted(kinds)} for column {name!r}. "
                    "Load with all_text=True and cast downstream, or scan and cast each file before union."
                    if scanning
                    else f"Union column {name!r} has incompatible types {sorted(kinds)}; cast before union."
                ),
                field="files" if scanning else "schema",
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
    # The result is built column by column and shares every text column with
    # the parsed frame. Copying the whole frame here and in _scan_header held
    # three copies of every cell at once: a 1 GB CSV peaked near 8 GB and its
    # worker was killed for memory.
    frame = frame.set_axis(pd.RangeIndex(len(frame)), axis=0, copy=False)
    text = pd.StringDtype()
    output = {}
    for name in frame.columns:
        series = frame[name]
        if all_text:
            output[name] = (
                series
                if series.dtype == text
                else series.map(lambda value: None if _missing(value) else str(value)).astype("string")
            )
            continue
        present = series.dropna()
        # infer_dtype checks "every present value is text" in C; a Python loop
        # over the cells was most of a large scan (8.6 M rows: about 58 s).
        if infer_text and len(present) and pd.api.types.infer_dtype(present, skipna=True) == "string":
            # Stops at the first value that is not true/false and builds no
            # lowercased column. (A `.str` accessor is cached on its Series in a
            # reference cycle: each column's copy then lived until a full
            # garbage collection, 1.4 GB across one 8.6 M-row scan.)
            if all(value.lower() in ("true", "false") for value in present):
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
        output[name] = series if series.dtype == text else _nullable(series)
    return pd.DataFrame(output, index=frame.index, copy=False)


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
        unresolved = []
        names = []
        for index, value in enumerate(raw.iloc[0]):
            if _missing(value) or str(value) == "":
                # pandas' own name for a blank header cell, which analyses and
                # reference answers written with pandas use (`Unnamed: 249`).
                value = f"Unnamed: {index}"
                unresolved.append(value)
            names.append(str(value))
        source_meta["unresolvedHeaders"] = unresolved
        check = _header_check(raw, source_meta.pop("_before", None), props.get("skipLines", 0))
        if check:
            source_meta["headerCheck"] = check
        # A view: _scan_infer relabels the rows and shares the text columns.
        output = raw.iloc[1:]
    else:
        names = props.get("names", [f"column{i}" for i in range(len(raw.columns))])
        output = raw.iloc[:]
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
            f"Duplicate header names across {len(names)} columns. Preview the raw rows, then skip all header rows "
            f"with skip_lines and use header=False with {len(names)} unique names.",
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
            if skip and props.get("header", True):
                source_meta["_before"] = workbook.parse(
                    sheets[0], header=None, nrows=skip, dtype=object, keep_default_na=False, na_values=[""]
                ).tail(_HEADER_WINDOW)
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
                if skip and props.get("header", True) and delimiter != "whitespace":
                    with path.open(encoding=encoding, newline="") as head:
                        above = list(csv.reader(islice(head, skip), delimiter=delimiter))[-_HEADER_WINDOW:]
                    source_meta["_before"] = pd.DataFrame(above, dtype=object)
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
    # One source already in _union's dtypes is its own result; _union would
    # copy every column of it (twice) for nothing.
    if len(parts) == 1 and _aligned(parts[0]):
        result = parts[0]
    else:
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
    failures, examples = {}, {}
    for i, item in enumerate(props["columns"]):
        name = item["column"]
        _columns(spec, source, [name], f"columns[{i}]")
        values, failed, witnessed = [], 0, {}
        collect = spec.get("profileCollection") is True and i < _WITNESS_WIDTH
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
                if collect:
                    raw = _scalar(value)
                    key = (type(raw), raw)
                    if key in witnessed:
                        witnessed[key]["count"] += 1
                    elif len(witnessed) < _WITNESS_LIMIT:
                        example = _witness([raw], 1)
                        if example is not None:
                            witnessed[key] = example
        output[name] = _series(values, item["dtype"])
        failures[name] = failed
        if witnessed:
            examples[name] = {
                "examples": list(witnessed.values()),
                "otherCount": failed - sum(w["count"] for w in witnessed.values()),
            }
    operations["conversionFailures"] = failures
    if examples:
        operations["conversionFailureExamples"] = examples
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


# ---------------------------------------------------------------------------
# Checks: an operator's own assumptions, verified on the full tables it read.
# Each records facts only; the agent service decides what the model sees.

_HEADER_WINDOW = 5
_CHECK_ROW_LIMIT = 2_000_000


def _data_like(name):
    """A header cell that reads as a data value: a number, amount or percent.

    Four-digit years stay header-like: wide tables are commonly keyed by year.
    """
    import re

    text = str(name).strip().replace(" ", "")
    if not re.fullmatch(r"[(+\-$€£]*\d[\d,]*(\.\d+)?%?\)?", text):
        return False
    return not re.fullmatch(r"(1[89]|20)\d\d", text.replace(",", ""))


def _header_cells(values, width, *, strip=True):
    cells = ["" if _missing(value) else str(value) for value in values]
    if strip:
        cells = [cell.strip() for cell in cells]
    return (cells + [""] * width)[:width]


def _header_score(cells):
    named = [cell for cell in cells if cell]
    return sum(map(_data_like, named)), len(cells) - len(named), len(set(named)) == len(named)


def _header_check(raw, before, skip):
    """Is the first parsed row a header? Also: the best header row nearby."""
    if raw.empty:
        return None
    width = len(raw.columns)
    current = _header_cells(raw.iloc[0], width)
    data_like, blanks, _ = _header_score(current)
    issues = {}
    if data_like:
        issues["dataLike"] = [cell for cell in current if cell and _data_like(cell)][:6]
    if width > 1 and blanks * 2 > width:
        issues["blank"] = blanks
    named = [i for i, cell in enumerate(current) if cell]
    if len(named) >= 2 and len(raw) <= _CHECK_ROW_LIMIT:
        import numpy as np

        # numpy, not the `.str` accessor: it is cached on its Series in a
        # reference cycle that holds each column copy until a full collection.
        def cells(i, rows):
            values = raw.iloc[1:, i].to_numpy(dtype=object)[rows]
            return np.char.strip(np.where(pd.isna(values), "", values).astype(str))

        rows = np.flatnonzero(cells(named[0], slice(None)) == current[named[0]])
        for i in named[1:]:
            if not len(rows):
                break
            rows = rows[cells(i, rows) == current[i]]
        if len(rows):
            issues["repeats"] = int(len(rows))
    if not issues:
        return None
    result = {"header": _header_cells(raw.iloc[0], width, strip=False)[:8], **issues}
    if "dataLike" in issues or "blank" in issues:
        above = [] if before is None else list(before.itertuples(index=False, name=None))
        candidates = [(i - len(above), row) for i, row in enumerate(above)]
        candidates += [(i, tuple(raw.iloc[i])) for i in range(1, min(_HEADER_WINDOW, len(raw) - 1) + 1)]
        best = None
        for offset, row in candidates:
            cells = _header_cells(row, width)
            like, empty, unique = _header_score(cells)
            better = empty < blanks if "blank" in issues and not data_like else empty <= blanks
            if like == 0 and unique and better and empty * 2 <= width:
                if best is None or abs(offset) < abs(best[0]):
                    # Score normalized labels, but report names exactly as
                    # the repaired scan will expose them to graph operators.
                    best = (offset, _header_cells(row, width, strip=False))
        if best:
            result["suggest"] = {"skipLines": skip + best[0], "header": best[1][:8]}
    return result


def _overlapping_sources(records, origin):
    """Records present, once each, in two or more sources.

    A record is a row of at least two columns, not mostly empty, that occurs
    exactly once in its own source. Rows that repeat inside one source are
    that source's observations (a year and a category, say), not copies, so
    they never count. A record found in several sources this way is the same
    entity listed by each of them, and a union of the sources holds one copy
    per source: a later sum, mean or count counts each copy.
    """
    import numpy as np

    if records.shape[1] < 2 or len(records) < 2 or len(records) > _CHECK_ROW_LIMIT:
        return None
    text = records.astype("string").fillna("")
    cells = text.to_numpy(dtype=object)
    filled = (cells != "").sum(axis=1) * 2 > records.shape[1]
    keys = pd.util.hash_pandas_object(text, index=False).to_numpy()
    pairs = pd.DataFrame({"key": keys, "origin": origin})
    per_source = pairs.groupby(["key", "origin"]).size()
    once = per_source.groupby(level="key").max() == 1
    sources = per_source.groupby(level="key").size()
    shared = sources.index[(sources >= 2) & once.reindex(sources.index).to_numpy()]
    hit = np.isin(keys, shared) & filled
    if not hit.any():
        return None
    first = cells[int(np.argmax(hit))]
    return {
        "rows": int(hit.sum()),
        "of": len(records),
        "records": int(len(np.unique(keys[hit]))),
        "sources": int(len(np.unique(np.asarray(origin)[hit]))),
        "example": ", ".join(str(v) for v in first)[:160],
    }


def _cross_source_duplicates(parts, synthetic):
    """Records shared by several of the tables a function concatenates."""
    import numpy as np

    if len(parts) < 2 or sum(map(len, parts)) > _CHECK_ROW_LIMIT:
        return None
    columns = [c for c in parts[0].columns if c not in synthetic]
    if not columns or any([c for c in part.columns if c not in synthetic] != columns for part in parts):
        return None
    records = pd.concat([part[columns] for part in parts], ignore_index=True)
    origin = np.concatenate([np.full(len(part), i) for i, part in enumerate(parts)])
    result = _overlapping_sources(records, origin)
    return {**result, "files": len(parts)} if result else None


def _repeated_records(frame, provenance):
    """The rows an aggregate or process reads that are one record from several sources.

    Only with a provenance column (the scan's file-name column carried
    downstream): without one, a copy cannot be told from a repeated value.
    """
    present = [c for c in provenance if c in frame.columns]
    columns = [c for c in frame.columns if c not in present]
    if not present or not columns:
        return None
    origin = pd.util.hash_pandas_object(frame[present].astype("string").fillna(""), index=False).to_numpy()
    result = _overlapping_sources(frame[columns], origin)
    return {**result, "ignoring": present} if result else None

def _key_dependencies(frame, keys, reduced):
    """Columns an aggregate's group key almost, but not always, determines.

    A column with one value in most groups is an attribute of the key (a
    beach's community, a station's elevation). Where some groups hold several
    values, the key merges entities that the column tells apart, or the data
    disagrees with itself; either way each such group's rows are pooled.
    Reduced columns vary within groups by design and are not considered.
    """
    import numpy as np

    if not keys or len(frame) < 2 or len(frame) > _CHECK_ROW_LIMIT:
        return None
    candidates = [c for c in frame.columns if c not in keys and c not in reduced][:40]
    if not candidates:
        return None
    grouped = frame.groupby(keys, dropna=False, sort=False)
    # Only groups of two or more rows can show whether a column varies.
    sizes = grouped.size()
    multi = sizes.index[sizes.to_numpy() > 1]
    found = []
    for column in candidates:
        per_group = grouped[column].nunique(dropna=True).reindex(multi)
        groups = len(sizes)
        split = per_group[per_group > 1]
        single = int((per_group == 1).sum())
        # Mostly determined (at least 4 in 5 multi-row groups single-valued), not always.
        if not len(split) or single < 4 * len(split) or single + len(split) < 5:
            continue
        key = split.index[0]
        key = key if isinstance(key, tuple) else (key,)
        mask = np.ones(len(frame), dtype=bool)
        for name, value in zip(keys, key):
            column_values = frame[name]
            mask &= (column_values.isna() if _missing(value) else column_values == value).to_numpy(dtype=bool)
        values = [str(v) for v in pd.unique(frame.loc[mask, column].dropna())[:3]]
        found.append(
            {
                "column": column,
                "groups": groups,
                "split": int(len(split)),
                "example": {"key": [None if _missing(v) else str(v) for v in key], "values": values},
            }
        )
    found.sort(key=lambda item: -item["split"])
    return found[:3] or None


class _ProcessTrace:
    """Observe the table operations a process function performs.

    The engine sees a process as one opaque step. While its function runs,
    pandas' readers, merges, row selections and concatenations called from the
    function's own lines are recorded, so the row effects inside it can be
    checked like those of relational operators. Calls made by pandas itself
    are not recorded twice.
    """

    def __init__(self, filename):
        self.filename, self.reads, self.events, self._saved, self._depth = filename, [], [], [], 0

    def _line(self):
        import sys

        # Only calls written in the function itself; pandas calling its own
        # API (a groupby selecting columns) is not the function's intent.
        frame = sys._getframe(2)
        return frame.f_lineno if frame.f_code.co_filename == self.filename else None

    def _wrap(self, owner, name, record):
        import functools

        original = getattr(owner, name)
        trace = self

        @functools.wraps(original)
        def wrapper(*args, **kwargs):
            if trace._depth:
                return original(*args, **kwargs)
            trace._depth += 1
            try:
                result = original(*args, **kwargs)
            finally:
                trace._depth -= 1
            line = trace._line()
            if line is not None:
                trace._depth += 1
                try:
                    record(line, args, kwargs, result)
                except Exception:
                    pass
                finally:
                    trace._depth -= 1
            return result

        setattr(owner, name, wrapper)
        self._saved.append((owner, name, original))

    def _read(self, line, args, kwargs, result):
        import os

        source = args[0] if args else kwargs.get("filepath_or_buffer", kwargs.get("io", kwargs.get("path")))
        frames = result.values() if isinstance(result, dict) else [result]
        rows = sum(len(f) for f in frames if isinstance(f, pd.DataFrame))
        name = os.path.basename(str(source)) if isinstance(source, (str, os.PathLike)) else type(source).__name__
        self.reads.append({"line": line, "file": name, "rows": rows})

    def _merge(self, line, args, kwargs, result):
        left = args[0]
        right = args[1] if len(args) > 1 else kwargs.get("right")
        if not all(isinstance(x, pd.DataFrame) for x in (left, right, result)):
            return
        how = kwargs.get("how", "inner")
        event = {"line": line, "op": "merge", "how": how, "in": [len(left), len(right)], "out": len(result)}
        if len(result) == 0 and len(left) and len(right):
            self.events.append({**event, "issue": "empty"})

    def _select(self, line, frame, key, result):
        import numpy as np

        mask = getattr(key, "dtype", None)
        if not isinstance(result, pd.DataFrame) or not isinstance(frame, pd.DataFrame):
            return
        if not (mask is not None and np.dtype(mask) == np.bool_) and not isinstance(key, str):
            return
        if isinstance(key, str) or not len(frame) or len(result):
            return
        self.events.append({"line": line, "op": "filter", "in": [len(frame)], "out": 0, "issue": "empty"})

    def _getitem(self, line, args, kwargs, result):
        self._select(line, args[0], args[1] if len(args) > 1 else None, result)

    def _loc(self, line, args, kwargs, result):
        key = args[1] if len(args) > 1 else None
        self._select(line, args[0].obj, key[0] if isinstance(key, tuple) else key, result)

    def _query(self, line, args, kwargs, result):
        if isinstance(result, pd.DataFrame) and len(args[0]) and not len(result):
            self.events.append({"line": line, "op": "query", "in": [len(args[0])], "out": 0, "issue": "empty"})

    def _concat(self, line, args, kwargs, result):
        objs = args[0] if args else kwargs.get("objs")
        parts = list(objs.values() if isinstance(objs, dict) else objs or [])
        axis = kwargs.get("axis", 0)
        if axis not in (0, "index") or len(parts) < 2 or not all(isinstance(p, pd.DataFrame) for p in parts):
            return
        duplicates = _cross_source_duplicates(parts, [])
        if duplicates:
            self.events.append(
                {"line": line, "op": "concat", "in": [len(p) for p in parts], "out": len(result), "issue": "duplicates", **duplicates}
            )

    def __enter__(self):
        import pandas.core.indexing as indexing

        for name in ("read_csv", "read_excel", "read_table", "read_json", "read_parquet", "read_fwf"):
            self._wrap(pd, name, self._read)
        self._wrap(pd, "merge", lambda line, args, kwargs, result: self._merge(line, args, kwargs, result))
        self._wrap(pd.DataFrame, "merge", self._merge)
        self._wrap(pd.DataFrame, "__getitem__", self._getitem)
        self._wrap(pd.DataFrame, "query", self._query)
        self._wrap(indexing._LocIndexer, "__getitem__", self._loc)
        self._wrap(pd, "concat", self._concat)
        return self

    def __exit__(self, *exc):
        for owner, name, original in reversed(self._saved):
            setattr(owner, name, original)
        self._saved.clear()
        return False


def execute_native_from_engine(spec, inputs):
    """Restore UTC metadata stripped by Texera's timezone-free TIMESTAMP wire type.

    Native producers validate timezone-aware datetimes before transport; Arrow
    serializes their instants in UTC. Restore that known zone only at this
    engine boundary, leaving direct runtime and callback validation strict.
    """
    import pandas as pd

    restored = []
    for frame in inputs:
        if isinstance(frame, pd.DataFrame) and frame.columns.is_unique:
            naive = [name for name in frame.columns
                     if pd.api.types.is_datetime64_any_dtype(frame[name].dtype)
                     and getattr(frame[name].dt, "tz", None) is None]
            if naive:
                frame = frame.copy(deep=False)
                for name in naive:
                    frame[name] = frame[name].dt.tz_localize("UTC")
        restored.append(frame)
    return execute_native(spec, restored)


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
    lineage = spec.get("lineage") or {}
    if kind in ("Aggregate", "Process") and lineage.get("multiSource") and inputs:
        repeated = _repeated_records(inputs[0], lineage.get("provenanceColumns", []))
        if repeated:
            operations["repeatedRecords"] = repeated
    if kind == "Scan":
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
        dependencies = _key_dependencies(
            source, props.get("groupBy", []), [a.get("col") for a in props["aggregations"]]
        )
        if dependencies:
            operations["keyDependencies"] = dependencies
    elif kind == "Join":
        output = _join(spec, inputs[0], inputs[1], operations)
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
    elif kind == "Process":
        entry = props.get("entry", "process" if inputs else "load")
        function = _function(spec, props["code"], "code", entry)
        with _ProcessTrace(_filename(spec, "code")) as trace:
            output = _frame(spec, function(*[frame.copy(deep=True) for frame in inputs]))
        if trace.reads or trace.events:
            operations["process"] = {"reads": trace.reads[:16], "events": trace.events[:8]}
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

    request = json.load(sys.stdin)
    if isinstance(request, dict) and "changes" in request:
        from graph_parser import parse_graph_changes

        print(json.dumps(parse_graph_changes(request["changes"]), ensure_ascii=True))
    elif isinstance(request, dict) and "program" in request:
        # Parse a native program (see program_parser.py); no operator semantics.
        from program_parser import parse_program

        print(json.dumps(parse_program(request["program"]), ensure_ascii=True))
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
