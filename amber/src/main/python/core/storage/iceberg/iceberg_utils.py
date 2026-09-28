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

import re
from pathlib import PureWindowsPath
from urllib.parse import urlparse

import pyarrow as pa
import pyiceberg.table
from pyiceberg.catalog import Catalog, load_catalog
from pyiceberg.catalog.sql import SqlCatalog
from pyiceberg.expressions import AlwaysTrue
from pyiceberg.io.pyarrow import ArrowScan
from pyiceberg.partitioning import UNPARTITIONED_PARTITION_SPEC
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from typing import Optional, Iterable
from pyiceberg import types as iceberg_types

import core
import core.models
from core.models import ArrowTableTupleProvider, Tuple
from core.models.schema.attribute_type import AttributeType, TO_ARROW_MAPPING

# Suffix used to encode LARGE_BINARY fields in Iceberg (must match Scala IcebergUtil)
LARGE_BINARY_FIELD_SUFFIX = "__texera_large_binary_ptr"

# pyiceberg FileIO whose fsspec LocalFileSystem handles Windows drive paths,
# which the default pyarrow FileIO cannot. See `_is_windows_local_warehouse`.
_FSSPEC_FILE_IO = "pyiceberg.io.fsspec.FsspecFileIO"

# Matches a filesystem path that starts with a Windows drive letter and a
# separator, e.g. `C:\...` or `C:/...` (but not the drive-relative `C:foo`).
_WINDOWS_DRIVE_PATH = re.compile(r"^[A-Za-z]:[\\/]")


def _is_windows_local_warehouse(warehouse: str) -> bool:
    """
    Whether ``warehouse`` is a LOCAL filesystem path carrying a Windows drive
    letter, either as a bare path (``C:\\...`` / ``C:/...``) or a ``file://``
    URI (``file:///C:/...``).

    Remote object stores (``s3://...``), POSIX paths, drive-less relative paths,
    and colon-stripped paths (the form the Scala side registers, ``C/...``) are
    excluded, so the default pyarrow FileIO / plain-path convention that Linux,
    macOS, CI, and the Scala engine rely on is left untouched (see #4409).
    """
    if not warehouse:
        return False
    text = str(warehouse)
    if _WINDOWS_DRIVE_PATH.match(text):
        return True
    parsed = urlparse(text)
    if parsed.scheme.lower() == "file":  # `file` URI schemes are case-insensitive
        return bool(_WINDOWS_DRIVE_PATH.match(parsed.path.lstrip("/")))
    return False


def _to_file_uri(warehouse: str) -> str:
    """
    Normalize a bare Windows drive path (``C:\\...``) to a ``file:///`` URI so
    pyiceberg does not mis-parse the drive letter as a URI scheme (``c://`` ->
    "Unrecognized filesystem type in URI: c"). Values that are already URIs
    (e.g. ``file:///C:/...``) are returned unchanged.

    The URI is built from ``PureWindowsPath.as_posix()`` rather than
    ``.as_uri()`` so the path is *not* percent-encoded: the fsspec
    ``LocalFileSystem`` behind ``FsspecFileIO`` does not URL-decode, so an
    encoded space (``C:\\Users\\John Doe`` -> ``.../John%20Doe``) would send
    writes to a literally ``%20``-named directory. ``PureWindowsPath`` keeps the
    conversion deterministic on every host OS (the result is identical off
    Windows).
    """
    text = str(warehouse)
    if _WINDOWS_DRIVE_PATH.match(text):
        return "file:///" + PureWindowsPath(text).as_posix()
    return text


# Type mappings
_ICEBERG_TO_AMBER_TYPE_MAPPING = {
    "string": "STRING",
    "int": "INT",
    "integer": "INT",
    "long": "LONG",
    "double": "DOUBLE",
    "float": "DOUBLE",
    "boolean": "BOOL",
    "timestamp": "TIMESTAMP",
    "binary": "BINARY",
}

_AMBER_TO_ICEBERG_TYPE_MAPPING = {
    AttributeType.STRING: iceberg_types.StringType(),
    AttributeType.INT: iceberg_types.IntegerType(),
    AttributeType.LONG: iceberg_types.LongType(),
    AttributeType.DOUBLE: iceberg_types.DoubleType(),
    AttributeType.BOOL: iceberg_types.BooleanType(),
    AttributeType.TIMESTAMP: iceberg_types.TimestampType(),
    AttributeType.BINARY: iceberg_types.BinaryType(),
    AttributeType.LARGE_BINARY: iceberg_types.StringType(),
    # LIST and STRUCT travel over the wire as JSON-encoded strings (see
    # TO_ARROW_MAPPING in attribute_type.py — both already collapse to
    # pa.string()). Use Iceberg's StringType so the on-disk type matches
    # the transport. Without these entries, any schema-inferred LIST or
    # STRUCT column (e.g. a UDF returning list-valued cells) crashes
    # `amber_schema_to_iceberg_schema` with `KeyError:
    # <AttributeType.LIST: 9>` when the engine creates the per-port
    # storage writer — outside user code, with no recoverable trace.
    AttributeType.LIST: iceberg_types.StringType(),
    AttributeType.STRUCT: iceberg_types.StringType(),
}


def encode_large_binary_field_name(field_name: str, attr_type) -> str:
    """Encodes LARGE_BINARY field names with suffix for Iceberg storage."""
    if attr_type == AttributeType.LARGE_BINARY:
        return f"{field_name}{LARGE_BINARY_FIELD_SUFFIX}"
    return field_name


def decode_large_binary_field_name(field_name: str) -> str:
    """Decodes field names by removing LARGE_BINARY suffix if present."""
    if field_name.endswith(LARGE_BINARY_FIELD_SUFFIX):
        return field_name[: -len(LARGE_BINARY_FIELD_SUFFIX)]
    return field_name


def iceberg_schema_to_amber_schema(iceberg_schema: Schema):
    """
    Converts PyIceberg Schema to Amber Schema.
    Decodes LARGE_BINARY field names and adds Arrow metadata.
    """
    arrow_fields = []
    for field in iceberg_schema.fields:
        decoded_name = decode_large_binary_field_name(field.name)
        is_large_binary = field.name != decoded_name

        if is_large_binary:
            attr_type = AttributeType.LARGE_BINARY
        else:
            iceberg_type_str = str(field.field_type).lower()
            attr_type_name = _ICEBERG_TO_AMBER_TYPE_MAPPING.get(
                iceberg_type_str, "STRING"
            )
            attr_type = getattr(AttributeType, attr_type_name)

        arrow_fields.append(
            pa.field(
                decoded_name,
                TO_ARROW_MAPPING[attr_type],
                metadata={b"texera_type": b"LARGE_BINARY"} if is_large_binary else None,
            )
        )

    return core.models.Schema(pa.schema(arrow_fields))


def amber_schema_to_iceberg_schema(amber_schema) -> Schema:
    """
    Converts Amber Schema to PyIceberg Schema.
    Encodes LARGE_BINARY field names with suffix.
    """
    fields = [
        iceberg_types.NestedField(
            field_id=idx,
            name=encode_large_binary_field_name(field_name, attr_type),
            field_type=_AMBER_TO_ICEBERG_TYPE_MAPPING[attr_type],
            required=False,
        )
        for idx, (field_name, attr_type) in enumerate(
            amber_schema._name_type_mapping.items(), start=1
        )
    ]

    return Schema(*fields)


def create_postgres_catalog(
    catalog_name: str,
    warehouse_path: str,
    uri_without_scheme: str,
    username: str,
    password: str,
) -> SqlCatalog:
    """
    Creates a Postgres SQL catalog instance by connecting to the database named
    "texera_iceberg_catalog".
    - The only requirement of the database is that it already exists. Once pyiceberg
    can connect to the database, it will handle the initializations.
    :param catalog_name: the name of the catalog.
    :param warehouse_path: the root path for the warehouse where the tables are stored.
    :param uri_without_scheme: the uri of the postgres database but without
            the scheme prefix since java and python use different schemes.
    :param username: the username of the postgres database.
    :param password: the password of the postgres database.
    :return: a SQLCatalog instance.
    """
    props = {
        "uri": f"postgresql+pg8000://{username}:{password}@{uri_without_scheme}",
        "warehouse": warehouse_path,
    }
    # On Windows with a local-filesystem warehouse, a bare drive path (`C:\...`)
    # crashes pyiceberg, and even a `file:///C:/...` URI is rejected by the
    # default pyarrow FileIO. Normalize the path to a `file:///` URI and switch
    # to fsspec's LocalFileSystem, which handles Windows drive paths. This is
    # the Python-worker counterpart to the Scala/JVM fix in #6488
    # (WinutilsFreeLocalFileSystem, issue #6487). Gated to warehouses that
    # actually carry a Windows drive letter, so remote object stores and POSIX
    # paths keep the default FileIO / plain-path convention (see #4409).
    if _is_windows_local_warehouse(warehouse_path):
        props["warehouse"] = _to_file_uri(warehouse_path)
        props["py-io-impl"] = _FSSPEC_FILE_IO
    return SqlCatalog(catalog_name, **props)


def create_rest_catalog(
    catalog_name: str,
    warehouse_name: str,
    rest_uri: str,
) -> Catalog:
    """
    Creates a REST catalog instance by connecting to a REST endpoint.
    - The warehouse_name parameter specifies the warehouse identifier.
    - S3 settings (endpoint, region, credentials) are supplied by the REST
      catalog server at runtime.
    :param catalog_name: the name of the catalog.
    :param warehouse_name: the warehouse identifier.
    :param rest_uri: the URI of the REST catalog endpoint.
    :return: a Catalog instance (REST catalog).
    """
    # No Windows-local normalization here (unlike create_postgres_catalog):
    # `warehouse_name` is a logical warehouse identifier resolved by the REST
    # server, whose I/O goes through S3FileIO, not the local filesystem.
    return load_catalog(
        catalog_name,
        **{
            "type": "rest",
            "uri": rest_uri,
            "warehouse": warehouse_name,
        },
    )


def create_table(
    catalog: Catalog,
    table_namespace: str,
    table_name: str,
    table_schema: Schema,
    override_if_exists: bool = False,
) -> Table:
    """
    Creates a new Iceberg table with the specified schema and properties.
    - Drops the existing table if `override_if_exists` is true and the table already
    exists.
    - Creates an unpartitioned table with custom commit retry properties.

    :param catalog: The Iceberg catalog to manage the table.
    :param table_namespace: The namespace of the table.
    :param table_name: The name of the table.
    :param table_schema: The schema of the table.
    :param override_if_exists: Whether to drop and recreate the table if it exists.
    :return: The created Iceberg table.
    """

    identifier = f"{table_namespace}.{table_name}"

    catalog.create_namespace_if_not_exists(table_namespace)

    if catalog.table_exists(identifier) and override_if_exists:
        catalog.drop_table(identifier)

    table = catalog.create_table(
        identifier=identifier,
        schema=table_schema,
        partition_spec=UNPARTITIONED_PARTITION_SPEC,
    )

    return table


def load_table_metadata(
    catalog: Catalog, table_namespace: str, table_name: str
) -> Optional[Table]:
    """
    Loads metadata for an existing Iceberg table.
    - Returns the table if it exists and is successfully loaded.
    - Returns None if the table does not exist or cannot be loaded.

    :param catalog: The Iceberg catalog to load the table from.
    :param table_namespace: The namespace of the table.
    :param table_name: The name of the table.
    :return: The table if found, or None if not found.
    """
    identifier = f"{table_namespace}.{table_name}"
    try:
        return catalog.load_table(identifier)
    except Exception:
        return None


def read_data_file_as_arrow_table(
    planfile: pyiceberg.table.FileScanTask, iceberg_table: pyiceberg.table.Table
) -> pa.Table:
    """Reads a data file as a pyarrow table and returns an iterator over its records."""
    arrow_table: pa.Table = ArrowScan(
        iceberg_table.metadata,
        iceberg_table.io,
        iceberg_table.schema(),
        AlwaysTrue(),
        True,
    ).to_table([planfile])
    return arrow_table


def amber_tuples_to_arrow_table(
    iceberg_schema: Schema, tuple_list: Iterable[Tuple]
) -> pa.Table:
    """
    Converts a list of amber tuples to a pyarrow table for serialization.
    Two cell-shape contracts the iceberg-projected Arrow schema imposes
    that the upstream amber tuples don't natively satisfy:
      - LARGE_BINARY cells (Python ``largebinary`` instances) must be
        unwrapped to their ``.uri`` string. Legacy contract.
      - Container cells (Python ``list`` / ``dict`` / ``tuple`` / ``set``
        / ``numpy.ndarray``) must be JSON-encoded because iceberg stores
        LIST / STRUCT under ``_AMBER_TO_ICEBERG_TYPE_MAPPING`` as
        ``StringType`` (which projects to PyArrow ``large_string``).
        Without this step ``pa.Table.from_pydict`` raises
        ``ArrowTypeError: Expected bytes, got a 'list' object`` when it
        tries to cast the raw list into the large_string column.

    Decision is per-cell rather than per-column: iceberg's Arrow
    projection collapses STRING / LIST / STRUCT / LARGE_BINARY to the
    same ``large_string`` Arrow type, so column type alone can't
    discriminate them. A string cell in a STRING column passes through;
    a list cell anywhere gets JSON-encoded.
    """
    import json
    from core.models.type.large_binary import largebinary

    tuple_list = list(tuple_list)  # Convert to list to allow multiple iterations

    def _encode_cell(value):
        if value is None:
            return None
        if isinstance(value, largebinary):
            return value.uri
        if isinstance(value, (list, tuple, set)):
            try:
                return json.dumps(
                    list(value) if isinstance(value, (tuple, set)) else value,
                    default=str,
                )
            except Exception:
                return str(value)
        if isinstance(value, dict):
            try:
                return json.dumps(value, default=str)
            except Exception:
                return str(value)
        # numpy.ndarray and any other tolist()-bearing array-like.
        # numpy scalars (np.int64 / np.float64 / np.bool_) also expose
        # tolist() — but tolist() on a scalar returns a Python scalar
        # (e.g. np.int64(7).tolist() → 7), and `isinstance(...,
        # (str, bytes, bool, int, float))` is unreliable across numpy
        # versions (e.g. np.int64 IS NOT a Python int subclass in
        # numpy>=2). The safe pattern is: call tolist() unconditionally
        # and inspect the result — JSON-encode iff it's a container,
        # otherwise pass the native scalar through to pyarrow (which
        # will cast it into the column's actual type, e.g. int64).
        if hasattr(value, "tolist") and not isinstance(value, (str, bytes)):
            try:
                listed = value.tolist()
            except Exception:
                return str(value)
            if isinstance(listed, (list, tuple, dict)):
                try:
                    return json.dumps(listed, default=str)
                except Exception:
                    return str(value)
            return listed
        return value

    arrow_schema = iceberg_schema.as_arrow()
    data_dict = {}
    for encoded_name in arrow_schema.names:
        decoded_name = decode_large_binary_field_name(encoded_name)
        data_dict[encoded_name] = [_encode_cell(t[decoded_name]) for t in tuple_list]

    return pa.Table.from_pydict(data_dict, schema=arrow_schema)


# Types whose stored values the per-row read returns unchanged, apart from
# NaN, which ``Tuple.cast_to_schema`` turns into null.
COLUMNAR_READ_TYPES = frozenset(
    {
        AttributeType.INT,
        AttributeType.LONG,
        AttributeType.DOUBLE,
        AttributeType.BOOL,
        AttributeType.STRING,
        AttributeType.TIMESTAMP,
    }
)


def columnar_readable(amber_schema) -> bool:
    """Whether ``arrow_table_to_amber_frame`` reproduces the per-row read for
    every column of ``amber_schema``."""
    return all(
        amber_schema.get_attr_type(name) in COLUMNAR_READ_TYPES
        for name in amber_schema.get_attr_names()
    )


def arrow_table_to_amber_frame(amber_schema, arrow_table: pa.Table) -> pa.Table:
    """The Arrow table that the per-row read builds from a data file read from
    Iceberg (``arrow_table_to_amber_tuples``, ``Tuple.cast_to_schema``, then
    one Arrow column per field): the file's columns in order, typed by
    ``amber_schema``, with NaN as null. Only for schemas that
    ``columnar_readable`` accepts."""
    import pyarrow.compute as pc

    target = amber_schema.as_arrow_schema()
    if arrow_table.num_columns != len(target):
        raise ValueError(
            f"data file has {arrow_table.num_columns} columns, "
            f"schema has {len(target)}"
        )
    columns = []
    for index, field in enumerate(target):
        column = arrow_table.column(index)
        if column.type != field.type:
            column = column.cast(field.type)
        if pa.types.is_floating(field.type) and column.null_count < len(column):
            column = pc.if_else(pc.is_nan(column), pa.scalar(None, field.type), column)
        columns.append(column)
    return pa.Table.from_arrays(columns, schema=target)


def arrow_to_stored_table(iceberg_schema: Schema, table: pa.Table) -> pa.Table:
    """The Arrow table ``amber_tuples_to_arrow_table`` stores for the same
    rows, from rows already in a plain port schema (``frame_to_arrow``):
    each column, by name, cast to its stored type."""
    arrow_schema = iceberg_schema.as_arrow()
    columns = [
        table.column(decode_large_binary_field_name(name)).cast(arrow_schema.field(name).type)
        for name in arrow_schema.names
    ]
    return pa.Table.from_arrays(columns, schema=arrow_schema)


def arrow_table_to_amber_tuples(
    iceberg_schema: Schema, arrow_table: pa.Table
) -> Iterable[Tuple]:
    """
    Converts an arrow table read from Iceberg to Amber tuples.
    Properly handles LARGE_BINARY field name decoding and type detection.
    """
    amber_schema = iceberg_schema_to_amber_schema(iceberg_schema)
    arrow_table_with_metadata = pa.Table.from_arrays(
        [arrow_table.column(name) for name in arrow_table.column_names],
        schema=amber_schema.as_arrow_schema(),
    )

    tuple_provider = ArrowTableTupleProvider(arrow_table_with_metadata)
    return (
        Tuple(
            {
                decode_large_binary_field_name(name): field_accessor
                for name in arrow_table.column_names
            },
            schema=amber_schema,
        )
        for field_accessor in tuple_provider
    )
