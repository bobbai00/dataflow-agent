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

import datetime
import pyarrow as pa
from bidict import bidict
from enum import Enum
from pyarrow import lib
from core.models.type.large_binary import largebinary


class AttributeType(Enum):
    """
    Types supported by PyTexera & PyAmber.

    The definitions are mapped and following the AttributeType.java
    (src/main/scala/org/apache/texera/workflow/common/tuple/schema/AttributeType.java)
    """

    STRING = 1
    INT = 2
    LONG = 3
    BOOL = 4
    DOUBLE = 5
    TIMESTAMP = 6
    BINARY = 7
    LARGE_BINARY = 8
    # LIST and STRUCT carry JSON-encoded payloads on the wire. Used for
    # DataFrame columns whose values are Python lists or dicts.
    LIST = 9
    STRUCT = 10

    # Java/UI names are aliases, not new wire types. Keep INT/BOOL canonical
    # so Python iteration, numeric values and Arrow/schema mappings stay stable.
    INTEGER = INT
    BOOLEAN = BOOL


RAW_TYPE_MAPPING = bidict(
    {
        "STRING": AttributeType.STRING,
        "INTEGER": AttributeType.INT,
        "LONG": AttributeType.LONG,
        "DOUBLE": AttributeType.DOUBLE,
        "BOOLEAN": AttributeType.BOOL,
        "TIMESTAMP": AttributeType.TIMESTAMP,
        "BINARY": AttributeType.BINARY,
        "LARGE_BINARY": AttributeType.LARGE_BINARY,
        "LIST": AttributeType.LIST,
        "STRUCT": AttributeType.STRUCT,
    }
)

TO_ARROW_MAPPING = {
    AttributeType.INT: pa.int32(),
    AttributeType.LONG: pa.int64(),
    AttributeType.STRING: pa.string(),
    AttributeType.DOUBLE: pa.float64(),
    AttributeType.BOOL: pa.bool_(),
    AttributeType.BINARY: pa.binary(),
    AttributeType.TIMESTAMP: pa.timestamp("us"),
    AttributeType.LARGE_BINARY: pa.string(),  # Serialized as URI string
    AttributeType.LIST: pa.string(),  # JSON-encoded list
    AttributeType.STRUCT: pa.string(),  # JSON-encoded dict
}

FROM_ARROW_MAPPING = {
    lib.Type_INT32: AttributeType.INT,
    lib.Type_INT64: AttributeType.LONG,
    lib.Type_STRING: AttributeType.STRING,
    lib.Type_LARGE_STRING: AttributeType.STRING,
    lib.Type_DOUBLE: AttributeType.DOUBLE,
    lib.Type_BOOL: AttributeType.BOOL,
    lib.Type_BINARY: AttributeType.BINARY,
    lib.Type_LARGE_BINARY: AttributeType.BINARY,
    lib.Type_TIMESTAMP: AttributeType.TIMESTAMP,
    # Native Arrow nested types map to LIST/STRUCT. The JSON-encoded
    # transport (pa.string()) is preferred, but DataFrames coming in with
    # native nested arrays should still infer cleanly.
    lib.Type_LIST: AttributeType.LIST,
    lib.Type_LARGE_LIST: AttributeType.LIST,
    lib.Type_STRUCT: AttributeType.STRUCT,
    lib.Type_MAP: AttributeType.STRUCT,
}


def _is_empty_value(v):
    return v is None or (isinstance(v, str) and v.strip() == "")


def _parse_bool(v):
    if _is_empty_value(v):
        return False

    normalized_value = str(v).strip().lower()
    if normalized_value == "true":
        return True
    if normalized_value == "false":
        return False
    return float(normalized_value) != 0


def _parse_timestamp(v):
    if _is_empty_value(v):
        return datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)

    normalized_value = str(v)
    if normalized_value.endswith("Z"):
        normalized_value = normalized_value[:-1] + "+00:00"
    parsed_value = datetime.datetime.fromisoformat(normalized_value)
    if (
        parsed_value.tzinfo is None
        or parsed_value.tzinfo.utcoffset(parsed_value) is None
    ):
        return parsed_value.replace(tzinfo=datetime.timezone.utc)
    return parsed_value


FROM_STRING_PARSER_MAPPING = {
    AttributeType.STRING: str,
    AttributeType.INT: lambda v: 0 if _is_empty_value(v) else int(v),
    AttributeType.LONG: lambda v: 0 if _is_empty_value(v) else int(v),
    AttributeType.DOUBLE: lambda v: 0.0 if _is_empty_value(v) else float(v),
    AttributeType.BOOL: _parse_bool,
    AttributeType.TIMESTAMP: _parse_timestamp,
}


# Only single-directional mapping.
TO_PYOBJECT_MAPPING = {
    AttributeType.STRING: str,
    AttributeType.INT: int,
    AttributeType.LONG: int,  # Python3 unifies long into int.
    AttributeType.DOUBLE: float,
    AttributeType.BOOL: bool,
    AttributeType.BINARY: bytes,
    AttributeType.TIMESTAMP: datetime.datetime,
    AttributeType.LARGE_BINARY: largebinary,
    AttributeType.LIST: list,
    AttributeType.STRUCT: dict,
}

FROM_PYOBJECT_MAPPING = {
    str: AttributeType.STRING,
    # Default integer inference to LONG to stay consistent with DataFrame
    # inference (data_processor maps every int dtype to LONG) and the engine's
    # scan sources, avoiding INT(int32)/LONG(int64) schema mismatches.
    int: AttributeType.LONG,
    float: AttributeType.DOUBLE,
    bool: AttributeType.BOOL,
    bytes: AttributeType.BINARY,
    datetime.datetime: AttributeType.TIMESTAMP,
    largebinary: AttributeType.LARGE_BINARY,
    list: AttributeType.LIST,
    dict: AttributeType.STRUCT,
}


def coerce_value_to_type(value, target_type: "AttributeType"):
    """
    Coerce a Python (or numpy / pandas extension) value to the engine's
    native type for `target_type`.

    Two reasons this exists:
      1. Schema inference can type a column as e.g. LONG, but rows arriving
         out of pandas carry `numpy.int64` — not a subclass of Python `int`
         in modern numpy, so the post-cast `validate_schema` check would
         reject them. Calling `int(value)` normalizes them.
      2. The dataflow agent's UDFs sometimes return string values that the
         downstream operator expects as numeric (or vice-versa); the
         coercions here let the engine bridge those small mismatches
         instead of hard-failing the workflow.

    Returns the original `value` unchanged when (a) it's None, (b) the
    target type isn't in `TO_PYOBJECT_MAPPING`, or (c) it's already an
    instance of the expected Python type. Raises on a coercion that
    pandas-style `int("hello")` would raise — callers (notably
    `Tuple.cast_to_schema`) catch and log such failures.
    """
    import json

    if value is None:
        return None

    expected_py_type = TO_PYOBJECT_MAPPING.get(target_type)
    if expected_py_type is None:
        return value

    # Fast path: a value already matching the expected type is left alone.
    # `bool` is a subclass of `int` in Python, so for LONG/INT targets we
    # explicitly fall through to the integer branch below (it disambiguates
    # True/False to 1/0 rather than leaving them as bool).
    if isinstance(value, expected_py_type) and not (
        target_type in (AttributeType.INT, AttributeType.LONG)
        and isinstance(value, bool)
    ):
        return value

    if target_type == AttributeType.STRING:
        if isinstance(value, (list, dict)):
            return json.dumps(value)
        return str(value)

    if target_type == AttributeType.BOOL:
        if isinstance(value, str):
            lower = value.lower()
            if lower in ("true", "1", "yes"):
                return True
            if lower in ("false", "0", "no", ""):
                return False
        return bool(value)

    if target_type in (AttributeType.INT, AttributeType.LONG):
        if isinstance(value, bool):
            return 1 if value else 0
        return int(value)

    if target_type == AttributeType.DOUBLE:
        return float(value)

    if target_type == AttributeType.BINARY:
        if isinstance(value, str):
            return value.encode("utf-8")
        return bytes(value)

    if target_type == AttributeType.TIMESTAMP:
        if isinstance(value, str):
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if isinstance(value, (int, float)):
            return datetime.datetime.fromtimestamp(value)
        # datetime.date (and its non-datetime subclasses) lift to
        # datetime.datetime at midnight. The engine's TIMESTAMP attribute
        # is datetime.datetime, and datetime.datetime is a subclass of
        # datetime.date — but not the other way round, so a raw
        # `datetime.date` cell fails the post-cast `validate_schema`
        # isinstance check. Promoting here is the canonical fix:
        # `datetime.date(2024, 1, 15)` → `datetime.datetime(2024, 1, 15)`.
        # Schema inference (data_processor._infer_type_from_object_column)
        # already types a "date" object-column as TIMESTAMP, so without
        # this branch the agent's UDF gets a hard `TypeError: Unmatched
        # type for field ..., expected AttributeType.TIMESTAMP, got
        # 2024-01-15 (<class 'datetime.date'>)` outside user code.
        if isinstance(value, datetime.date) and not isinstance(
            value, datetime.datetime
        ):
            return datetime.datetime(value.year, value.month, value.day)
        return value

    if target_type == AttributeType.LIST:
        if isinstance(value, str):
            return json.loads(value)
        # NumPy arrays surface through pandas object-columns as ndarrays;
        # `list(ndarray)` yields a list of `numpy.int64` / `numpy.float64`
        # scalars which validate fine here but break downstream JSON
        # encoding (TO_ARROW_MAPPING ships LIST as `pa.string()` of JSON).
        # `.tolist()` recurses into the array and emits native Python
        # ints/floats — JSON-safe AND validate-safe.
        if hasattr(value, "tolist") and not isinstance(value, (list, tuple)):
            try:
                return list(value.tolist())
            except Exception:
                pass
        return list(value)

    if target_type == AttributeType.STRUCT:
        if isinstance(value, str):
            return json.loads(value)
        if hasattr(value, "items"):
            return dict(value.items())
        return value

    return value
