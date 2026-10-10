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

"""Bounded, structured observations over actual worker output DataFrames.

No rendered text is parsed and no task-specific statistic is calculated.
Counts/ranges are exact for the explicitly recorded processed prefix. Bounded
exact dictionaries are abandoned on overflow, never relabeled as exact sketches.
Worker contributions remain separate on the wire; operator-level coverage is
decided only with the expected worker count and execution identity.
"""

from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import math
from numbers import Integral, Real
import time
import uuid

import pandas as pd
import numpy as np


PROFILE_PREFIX = "__texera_profile_v1__:"


@dataclass(frozen=True)
class ProfileLimits:
    max_rows: int = 100_000
    max_cells: int = 1_000_000
    max_columns: int = 128
    distinct_limit: int = 256
    row_distinct_limit: int = 4096
    top_k: int = 8
    max_value_chars: int = 192
    max_payload_bytes: int = 65_536
    max_seconds: float = 0.2


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _type(column, probe_rows):
    dtype = column.dtype
    if pd.api.types.is_bool_dtype(dtype):
        return "bool"
    if pd.api.types.is_integer_dtype(dtype):
        return "int64"
    if pd.api.types.is_float_dtype(dtype):
        return "float64"
    if pd.api.types.is_datetime64_any_dtype(dtype):
        return "datetime"
    if dtype == object:
        inferred = pd.api.types.infer_dtype(column.iloc[:probe_rows], skipna=True)
        return {
            "integer": "int64",
            "floating": "float64",
            "boolean": "bool",
            "string": "str",
            "empty": "unknown",
            "datetime": "datetime",
            "datetime64": "datetime",
            "date": "datetime",
        }.get(inferred, "unsupported")
    return "str" if pd.api.types.is_string_dtype(dtype) else "unsupported"


def _missing(value):
    return value is None or value is pd.NA or value is pd.NaT or (isinstance(value, float) and math.isnan(value))


def _scalar(value, kind, limit):
    if kind == "int64":
        if isinstance(value, (bool, np.bool_)) or not isinstance(value, Integral):
            raise ValueError("unsupported_type")
        return {"type": kind, "value": str(int(value))}
    if kind == "float64":
        if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real):
            raise ValueError("unsupported_type")
        if not math.isfinite(float(value)):
            raise ValueError("nonfinite_value")
        return {"type": kind, "value": float(value)}
    if kind == "bool":
        if not isinstance(value, (bool, np.bool_)):
            raise ValueError("unsupported_type")
        return {"type": kind, "value": bool(value)}
    if kind == "datetime":
        stamp = pd.Timestamp(value)
        if stamp.tz is not None:
            stamp = stamp.tz_convert("UTC")
        return {"type": kind, "value": stamp.isoformat(timespec="nanoseconds")}
    if kind == "str" and isinstance(value, str):
        if len(value) > limit:
            raise ValueError("value_budget")
        return {"type": kind, "value": value}
    raise ValueError("unsupported_type")


def _order(value):
    return int(value["value"]) if value["type"] == "int64" else value["value"]


class ProfileAccumulator:
    def __init__(self, worker_id, metadata, *, limits=None, clock=time.perf_counter):
        self.limits = limits or ProfileLimits()
        self.clock = clock
        self.worker_id = worker_id
        self.key = PROFILE_PREFIX + hashlib.sha256(worker_id.encode()).hexdigest()[:32]
        self.producer_id = uuid.uuid4().hex
        self.metadata = deepcopy(metadata)
        self.schema = None
        self.column_count = None
        self.columns = {}
        self.row_count = 0
        self.rows_processed = 0
        self.cells_processed = 0
        self.yields = 0
        self.elapsed = 0.0
        self.finished = False
        self.unavailable = False
        self.omissions = set()
        self.rows = Counter()
        self.null_rows = 0
        # "full": exact statistics over every row, computed column by column
        # (see _add_full). Otherwise the bounded prefix walk below.
        self.full = self.metadata.get("profileScope") == "full"
        self.duplicates = None

    def _schema(self, frame, probe_rows=None):
        if probe_rows is None:
            probe_rows = min(128, max(0, self.limits.max_rows - self.rows_processed))
        return [
            {"name": str(name), "type": _type(frame.iloc[:, i], probe_rows), "dtype": str(frame.iloc[:, i].dtype)}
            for i, name in enumerate(frame.columns[: self.limits.max_columns])
        ]

    def _accept(self, frame, schema):
        """Record the first yield's schema or check a later one against it.
        Returns the schema to profile with, or None once the profile is unavailable."""
        if self.schema is None:
            self.schema = schema
            self.column_count = len(frame.columns)
            for column in schema[: self.limits.max_columns]:
                self.columns[column["name"]] = {
                    "type": column["type"],
                    "null": 0,
                    "nonnull": 0,
                    "values": {},
                    "min": None,
                    "max": None,
                    "range_valid": True,
                    "omissions": set(),
                }
        else:
            if self.column_count != len(frame.columns) or [c["name"] for c in schema] != [
                c["name"] for c in self.schema
            ]:
                self.fail("schema_changed")
            else:
                for current, incoming in zip(self.schema, schema):
                    # An all-null object yield has no inferred domain yet.
                    # A later yield may supply it without discarding nulls.
                    if incoming["type"] == "unknown" and incoming["dtype"] == current["dtype"]:
                        continue
                    if current["type"] == "unknown" and current["dtype"] == incoming["dtype"]:
                        current["type"] = incoming["type"]
                        self.columns[current["name"]]["type"] = incoming["type"]
                    elif current != incoming:
                        self.fail("schema_changed")
                        break
        if self.unavailable:
            return None
        if self.column_count > self.limits.max_columns:
            self.omissions.add("column_budget")
            self.rows = None
            self.null_rows = None
        return self.schema

    def add(self, frame):
        if self.finished:
            raise RuntimeError("Profile is already finished")
        if self.full:
            return self._add_full(frame)
        started = self.clock()
        self.row_count += len(frame)
        self.yields += 1
        try:
            schema = self._accept(frame, self._schema(frame))
            if schema is None:
                return
            width = min(len(schema), self.limits.max_columns)
            left_rows = max(0, self.limits.max_rows - self.rows_processed)
            left_cells = max(0, self.limits.max_cells - self.cells_processed) // max(1, width)
            count = min(len(frame), left_rows, left_cells)
            if len(frame) > left_rows:
                self.omissions.add("row_budget")
            if len(frame) > left_cells:
                self.omissions.add("cell_budget")
            selected = frame.iloc[:count, :width]
            for i, row in enumerate(selected.itertuples(index=False, name=None)):
                if i % 128 == 0 and self.elapsed + self.clock() - started >= self.limits.max_seconds:
                    self.omissions.add("time_budget")
                    break
                row_values, row_complete, nulls = [], True, 0
                for column, value in zip(schema, row):
                    state = self.columns[column["name"]]
                    if _missing(value):
                        state["null"] += 1
                        nulls += 1
                        row_values.append(None)
                        continue
                    state["nonnull"] += 1
                    try:
                        encoded = _scalar(value, column["type"], self.limits.max_value_chars)
                    except (ValueError, TypeError, OverflowError) as error:
                        reason = str(error)
                        state["omissions"].add(
                            reason
                            if reason in ("nonfinite_value", "value_budget", "unsupported_type")
                            else "unsupported_type"
                        )
                        state["values"] = None
                        state["range_valid"] = False
                        state["min"] = state["max"] = None
                        row_complete = False
                        continue
                    if encoded["type"] == "float64" and encoded["value"] == 0:
                        # -0.0 and 0.0 are one value, as pandas counts them.
                        encoded = {**encoded, "value": 0.0}
                    row_values.append(encoded)
                    if state["range_valid"] and encoded["type"] in ("int64", "float64", "datetime"):
                        if state["min"] is None or _order(encoded) < _order(state["min"]):
                            state["min"] = encoded
                        if state["max"] is None or _order(encoded) > _order(state["max"]):
                            state["max"] = encoded
                    if state["values"] is not None:
                        key = _json(encoded)
                        entry = state["values"].get(key)
                        if entry is not None:
                            entry["count"] += 1
                        elif len(state["values"]) < self.limits.distinct_limit:
                            state["values"][key] = {"value": encoded, "count": 1}
                        else:
                            state["values"] = None
                            state["omissions"].add("distinct_limit")
                if self.null_rows is not None and width and nulls == width:
                    self.null_rows += 1
                if self.rows is not None:
                    if not row_complete:
                        self.rows = None
                        self.omissions.add("row_values_unavailable")
                    else:
                        key = _json(row_values)
                        if key in self.rows or len(self.rows) < self.limits.row_distinct_limit:
                            self.rows[key] += 1
                        else:
                            self.rows = None
                            self.omissions.add("row_distinct_limit")
                self.rows_processed += 1
                self.cells_processed += width
        except Exception:
            # Optional profiling must never replace a valid data result with an
            # error. Do not include exception text containing arbitrary cells.
            self.fail("profiler_error")
        finally:
            self.elapsed += max(0.0, self.clock() - started)

    def _add_full(self, frame):
        """Exact statistics over every row, one vectorized pass per column.

        Counts, ranges, distinct counts and duplicate rows cover the whole
        table; value lists are still kept only for columns with at most
        distinct_limit values. There is no row, cell or time budget."""
        started = self.clock()
        self.row_count += len(frame)
        self.yields += 1
        try:
            # Types come from every value, not from the first rows.
            schema = self._accept(frame, self._schema(frame, probe_rows=len(frame)))
            if schema is None:
                return
            width = min(len(schema), self.limits.max_columns)
            selected = frame.iloc[:, :width]
            unique = False
            for i, column in enumerate(schema[:width]):
                state = self.columns[column["name"]]
                self._exact_column(state, column["type"], selected.iloc[:, i])
                unique = unique or (len(frame) > 0 and state["null"] == 0 and state.get("distinct") == len(frame))
            if self.yields > 1:
                # Rows of different yields are never compared.
                self.duplicates = None
                self.omissions.add("duplicate_rows_multi_yield")
            elif self.null_rows is not None:
                # A column unique on every row rules out duplicate rows.
                if unique:
                    self.duplicates = 0
                else:
                    try:
                        self.duplicates = int(selected.duplicated().sum())
                    except TypeError:
                        self.omissions.add("row_values_unavailable")
            if self.null_rows is not None:
                self.null_rows += int(selected.isna().all(axis=1).sum()) if width else 0
            self.rows_processed += len(frame)
            self.cells_processed += width * len(frame)
        except Exception:
            self.fail("profiler_error")
        finally:
            self.elapsed += max(0.0, self.clock() - started)

    def _exact_column(self, state, kind, column):
        """One yield of one column. A later yield keeps the counts exact and the
        value list while it stays within distinct_limit."""
        missing = column.isna()
        nulls = int(missing.sum())
        state["null"] += nulls
        state["nonnull"] += len(column) - nulls
        if self.yields > 1:
            # The exact distinct count of a single yield no longer applies.
            state.pop("distinct", None)
        values = column[~missing]
        if values.empty:
            if self.yields == 1:
                state["distinct"] = 0
            return
        reason = None
        if kind in ("unknown", "unsupported"):
            reason = "unsupported_type"
        elif kind == "float64" and not np.isfinite(values.to_numpy(dtype=float)).all():
            reason = "nonfinite_value"
        elif kind == "str" and int(values.str.len().max()) > self.limits.max_value_chars:
            reason = "value_budget"
        try:
            counts = values.value_counts(sort=False)
        except TypeError:
            counts, reason = None, reason or "unsupported_type"
        # Values outside the supported types have no equality the profile
        # vouches for; their distinct count stays unknown, as in bounded scope.
        if counts is not None and self.yields == 1 and reason != "unsupported_type":
            state["distinct"] = len(counts)
        if reason is not None:
            state["omissions"].add(reason)
            state["values"] = None
            state["range_valid"] = False
            state["min"] = state["max"] = None
            return
        try:
            if state["values"] is not None and len(counts) > self.limits.distinct_limit:
                state["values"] = None
                state["omissions"].add("distinct_limit")
            elif state["values"] is not None:
                for value, count in counts.items():
                    encoded = _scalar(value, kind, self.limits.max_value_chars)
                    if encoded["type"] == "float64" and encoded["value"] == 0:
                        # -0.0 and 0.0 are one value, as pandas counts them.
                        encoded = {**encoded, "value": 0.0}
                    key = _json(encoded)
                    entry = state["values"].get(key)
                    if entry is not None:
                        entry["count"] += int(count)
                    elif len(state["values"]) < self.limits.distinct_limit:
                        state["values"][key] = {"value": encoded, "count": int(count)}
                    else:
                        state["values"] = None
                        state["omissions"].add("distinct_limit")
                        break
            if state["range_valid"] and kind in ("int64", "float64", "datetime"):
                for value in (values.min(), values.max()):
                    encoded = _scalar(value, kind, self.limits.max_value_chars)
                    if encoded["type"] == "float64" and encoded["value"] == 0:
                        encoded = {**encoded, "value": 0.0}
                    if state["min"] is None or _order(encoded) < _order(state["min"]):
                        state["min"] = encoded
                    if state["max"] is None or _order(encoded) > _order(state["max"]):
                        state["max"] = encoded
        except (ValueError, TypeError, OverflowError):
            # A value outside the column's inferred type: keep the counts.
            state["omissions"].add("unsupported_type")
            state["values"] = None
            state["range_valid"] = False
            state["min"] = state["max"] = None

    def fail(self, reason):
        self.unavailable = True
        self.omissions.add(reason)
        self.columns = {}
        self.rows = None
        self.null_rows = None

    def finish(self):
        self.finished = True

    def snapshot(self):
        columns = {}
        for name, state in self.columns.items():
            values = state["values"]
            # Full scope keeps an exact count for one yield even without a value list.
            distinct = state["distinct"] if "distinct" in state else (len(values) if values is not None else None)
            frequencies = None
            if values is not None:
                ordered = sorted(values.items(), key=lambda item: (-item[1]["count"], item[0]))
                top = [entry for _, entry in ordered[: self.limits.top_k]]
                frequencies = {
                    "values": top,
                    "otherCount": state["nonnull"] - sum(entry["count"] for entry in top),
                    "truncated": distinct > len(top),
                }
            total = state["null"] + state["nonnull"]
            columns[name] = {
                "type": state["type"],
                "rowsProcessed": total,
                "nullCount": state["null"],
                "nonnullCount": state["nonnull"],
                "nullRatio": state["null"] / total if total else None,
                "distinctCount": distinct,
                "uniquenessRatio": distinct / state["nonnull"] if distinct is not None and state["nonnull"] else None,
                "min": state["min"],
                "max": state["max"],
                "frequencies": frequencies,
                "mergeValues": list(values.values()) if values is not None else None,
                "omissions": sorted(state["omissions"]),
            }
        schema = self.schema or []
        metadata = {k: self.metadata[k] for k in ("operatorId", "operatorRevision") if k in self.metadata}
        return deepcopy(
            {
                "protocol": "texera.table-profile",
                "version": 1,
                "workerId": self.worker_id,
                "producerId": self.producer_id,
                **metadata,
                "status": "unavailable" if self.unavailable else "available",
                "coverage": {
                    "scope": "worker",
                    "complete": self.finished and not self.unavailable and self.rows_processed == self.row_count,
                    "rowsProcessed": self.rows_processed,
                    "yields": self.yields,
                },
                "rowCount": self.row_count,
                "columnCount": self.column_count or 0,
                "schema": schema,
                "schemaComplete": len(schema) == self.column_count,
                "columns": columns,
                "native": (
                    {
                        k: self.metadata[k]
                        for k in (
                            "operatorType",
                            "inputOperators",
                            "rowEffect",
                            "inputRows",
                            "outputRows",
                            "operations",
                        )
                        if k in self.metadata
                    }
                    if self.yields == 1
                    else None
                ),
                "structure": {
                    "duplicateRows": (
                        self.duplicates
                        if self.full
                        else self.rows_processed - len(self.rows) if self.rows is not None else None
                    ),
                    "allNullRows": self.null_rows,
                    "allNullColumns": [
                        name for name, col in columns.items() if col["rowsProcessed"] and col["nonnullCount"] == 0
                    ],
                },
                "algorithm": {
                    "name": "bounded-exact-v1",
                    "rowSelection": "prefix",
                    "scope": "full" if self.full else "bounded",
                    "distinctLimit": self.limits.distinct_limit,
                    "rowDistinctLimit": self.limits.row_distinct_limit,
                    "topK": self.limits.top_k,
                },
                "omissions": sorted(self.omissions),
                "cost": {
                    "collectionMs": round(self.elapsed * 1000, 3),
                    "cellsProcessed": self.cells_processed,
                    "payloadBytes": 0,
                },
            }
        )

    def encode(self):
        started = self.clock()
        result = self.snapshot()
        # Time summary construction separately from row/column collection.
        # Encoding, payload trimming, transfer and persistence are excluded.
        result["cost"]["snapshotMs"] = round(max(0.0, self.clock() - started) * 1000, 3)

        def encode_with_size():
            for _ in range(6):
                payload = _json(result)
                size = len(payload.encode("utf-8"))
                if result["cost"]["payloadBytes"] == size:
                    return payload
                result["cost"]["payloadBytes"] = size
            return _json(result)

        payload = encode_with_size()
        if len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            # Optional value witnesses must not evict exact operation counters
            # or column measurements. snapshot() owns a deep copy, so trimming
            # this envelope does not change retained execution metadata.
            native = result.get("native") or {}
            operations = native.get("operations")
            removed = False
            if isinstance(operations, dict):
                if "conversionFailureExamples" in operations:
                    del operations["conversionFailureExamples"]
                    removed = True
                if "filterRejectedValues" in operations:
                    del operations["filterRejectedValues"]
                    removed = True
                join = operations.get("join")
                if isinstance(join, dict):
                    for port in ("left", "right"):
                        side = join.get(port)
                        if isinstance(side, dict):
                            for key in ("unmatchedExamples", "duplicateExamples"):
                                if key in side:
                                    del side[key]
                                    removed = True
            if removed:
                result["omissions"] = sorted(set(result["omissions"]) | {"native_witness_payload_budget"})
                payload = encode_with_size()
        # Source identity is independent of optional per-file findings and
        # statistics. Compact ordinary records first; never erase the only
        # source merely because a wide table's value dictionaries overflow.
        native = result.get("native") or {}
        scan = (native.get("operations") or {}).get("scan")
        if not (isinstance(scan, dict) and isinstance(scan.get("sources"), list)):
            scan = None
        if scan is not None and len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            sources = scan["sources"]
            compact = [
                (
                    s
                    if not isinstance(s, dict) or s.get("headerCheck") or s.get("outputRows") == 0
                    else {k: s[k] for k in ("path", "sizeBytes", "mtimeNs") if k in s}
                )
                for s in sources
            ]
            removed = sum(a != b for a, b in zip(sources, compact))
            if removed:
                scan["sources"] = compact
                scan["sourceDetailsOmitted"] = scan.get("sourceDetailsOmitted", 0) + removed
                result["omissions"] = sorted(set(result["omissions"]) | {"scan_source_details_payload_budget"})
                payload = encode_with_size()
            # A very large source list is itself bounded. Prefer records with
            # findings, then original order; explicitly mark incomplete identity.
            while len(scan["sources"]) > 256:
                sources = scan["sources"]
                ranked = sorted(
                    range(len(sources)),
                    key=lambda i: not (
                        isinstance(sources[i], dict)
                        and (sources[i].get("headerCheck") or sources[i].get("outputRows") == 0)
                    ),
                )
                keep = set(ranked[: len(sources) // 2])
                scan["sources"] = [s for i, s in enumerate(sources) if i in keep]
                scan["sourcesOmitted"] = scan.get("sourcesOmitted", 0) + len(sources) - len(keep)
                result["omissions"] = sorted(set(result["omissions"]) | {"scan_sources_payload_budget"})
                payload = encode_with_size()
        if len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            result["omissions"] = sorted(set(result["omissions"]) | {"payload_budget"})
            # Drop the largest value dictionaries first. A wide table should
            # not lose a two-value eligibility flag because unrelated columns
            # contain hundreds of distinct values. Keep frequencies and their
            # merge dictionaries together for exact cross-worker aggregation.
            size = len(_json(result).encode("utf-8"))
            candidates = sorted(
                (c for c in result["columns"].values() if c["mergeValues"] is not None or c["frequencies"] is not None),
                key=lambda c: len(_json([c["mergeValues"], c["frequencies"]]).encode("utf-8")),
                reverse=True,
            )
            for column in candidates:
                before = len(_json(column).encode("utf-8"))
                column["mergeValues"] = None
                column["frequencies"] = None
                column["omissions"] = sorted(
                    set(column["omissions"]) | {"frequency_payload_budget", "merge_values_payload_budget"}
                )
                size += len(_json(column).encode("utf-8")) - before
                # Leave room for the payloadBytes field to change width.
                if size + 32 <= self.limits.max_payload_bytes:
                    break
            payload = encode_with_size()
        if scan is None and len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            result["native"] = None
            result["omissions"] = sorted(set(result["omissions"]) | {"native_metadata_payload_budget"})
            payload = encode_with_size()
        if len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            result.update(
                {"schema": [], "schemaComplete": False, "columns": {}, "structure": {}, "status": "unavailable"}
            )
            result["coverage"]["complete"] = False
            payload = encode_with_size()
        while scan is not None and scan["sources"] and len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            keep = len(scan["sources"]) // 2
            scan["sourcesOmitted"] = scan.get("sourcesOmitted", 0) + len(scan["sources"]) - keep
            scan["sources"] = scan["sources"][:keep]
            result["omissions"] = sorted(set(result["omissions"]) | {"scan_sources_payload_budget"})
            payload = encode_with_size()
        if len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            result["native"] = None
            result["omissions"] = sorted(set(result["omissions"]) | {"native_metadata_payload_budget"})
            payload = encode_with_size()
        if len(payload.encode("utf-8")) > self.limits.max_payload_bytes:
            raise ValueError("Profile identity exceeds payload budget")
        return payload
