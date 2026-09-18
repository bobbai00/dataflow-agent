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
"""Read a retained Arrow table completely and print it as JSON rows.

Display budgets truncate cells and rows so the model can read a result; a
direct return must deliver the whole table, so it reads the retained copy the
engine wrote (the same file `atTask` inputs load) instead of the display
result. Verifies the recorded digest, converts with exact int64 text and
`null` for missing values, and refuses payloads over the byte limit rather
than emitting a partial answer.

    python retained_rows.py <path> <sha256> <max_bytes>
"""
import datetime as dt
import decimal
import hashlib
import json
import math
import sys


def scalar(value):
    if value is None:
        return None
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    if isinstance(value, (list, tuple)):
        return [scalar(v) for v in value]
    if isinstance(value, dict):
        return {str(k): scalar(v) for k, v in value.items()}
    return value


def main(path, digest, max_bytes):
    import pyarrow as pa
    import pyarrow.ipc as ipc

    with open(path, "rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != digest:
        raise SystemExit(json.dumps({"error": "retained table is missing or has changed"}))
    with pa.memory_map(path, "r") as stream:
        table = ipc.open_file(stream).read_all()
    rows = [{k: scalar(v) for k, v in row.items()} for row in table.to_pylist()]
    payload = json.dumps(
        {
            "rowCount": table.num_rows,
            "schema": [{"name": field.name, "type": str(field.type)} for field in table.schema],
            "rows": rows,
        },
        ensure_ascii=False,
        allow_nan=False,
    )
    if len(payload.encode("utf-8")) > max_bytes:
        raise SystemExit(json.dumps({"error": f"complete result exceeds the {max_bytes}-byte return limit"}))
    sys.stdout.write(payload)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]))
