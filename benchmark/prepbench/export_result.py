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
"""Write one operator's full result table, exactly as the engine stored it, to CSV.

The agent names an operator; the snapshot says which execution produced that operator's current result. This looks up
the stored result in the engine's registry (operator_port_executions, else operator_port_cache, the engine's own two
lookups) and reads the Iceberg table with the engine's Python storage code. Rows keep the stored order; the CSV is
written the way pandas writes a DataFrame (df.to_csv(index=False)), as a script agent would write it.

The stack comes from the environment the stack profile sets (run-env.sh): STORAGE_JDBC_URL,
STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME, STORAGE_S3_ENDPOINT and TEXERA_HOME; the defaults are the
texera-stable stack's. Credentials default to the repository's local-dev values.

Usage: export_result.py --workflow-id W --execution-id E --operator-id OP [--port 0] --out file.csv
Run with the engine's Python (the checkout's .venv) and PYTHONPATH=<checkout>/amber/src/main/python."""
import argparse, json, os, re, sys
from pathlib import Path
import pyarrow as pa
import sqlalchemy as sa

HOME = os.environ.get("TEXERA_HOME") or str(Path(__file__).resolve().parents[2])
JDBC = os.environ.get("STORAGE_JDBC_URL", "jdbc:postgresql://localhost:61432/texera_db")
TEXERA_DB = re.match(r"jdbc:postgresql://([^/?]+)/([^?]+)", JDBC.strip("'\""))
PG_USER = os.environ.get("STORAGE_JDBC_USERNAME", "texera")
PG_PASSWORD = os.environ.get("TEXERA_PG_PASSWORD") or os.environ.get("STORAGE_JDBC_PASSWORD", "password")
STACK = {  # the stack, as the engine passes it to its Python workers
    "catalog_type": "postgres",
    "postgres_uri_without_scheme": os.environ.get("STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME",
                                                  "localhost:61432/texera_iceberg_catalog"),
    "postgres_username": os.environ.get("STORAGE_ICEBERG_CATALOG_POSTGRES_USERNAME", "texera"),
    "postgres_password": os.environ.get("TEXERA_PG_PASSWORD") or os.environ.get("STORAGE_ICEBERG_CATALOG_POSTGRES_PASSWORD", "password"),
    "rest_catalog_uri": "", "rest_catalog_warehouse_name": "",
    "table_result_namespace": "operator-port-result", "table_state_namespace": "operator-port-state",
    "directory_path": f"{HOME}/amber/user-resources/workflow-results",
    "commit_batch_size": "4096", "s3_endpoint": os.environ.get("STORAGE_S3_ENDPOINT", "http://localhost:65000"),
    "s3_region": "us-west-2", "s3_auth_username": os.environ.get("STORAGE_S3_AUTH_USERNAME", "texera_minio"),
    "s3_auth_password": os.environ.get("TEXERA_S3_PASSWORD") or os.environ.get("STORAGE_S3_AUTH_PASSWORD", "password"),
    "s3_large_binaries_base_uri": "s3://texera-large-binaries/objects/export/",
}


def port_id(operator, port):
    return f"(logicalOpId={operator},layerName=main,portId={port},isInternal=false,isInput=false)"


def result_uri(workflow, execution, operator, port):
    engine = sa.create_engine(f"postgresql+pg8000://{PG_USER}:{PG_PASSWORD}@{TEXERA_DB.group(1)}/{TEXERA_DB.group(2)}")
    with engine.connect() as db:
        row = db.execute(sa.text("select result_uri from texera_db.operator_port_executions "
                                 "where workflow_execution_id = :e and global_port_id = :g"),
                         {"e": int(execution), "g": port_id(operator, port)}).fetchone()
        if row and row[0]:
            return row[0], "operator_port_executions"
        # The engine's fallback: execution rows are cleaned up, cached documents stay (keyed by the producing execution).
        row = db.execute(sa.text("select result_uri from texera_db.operator_port_cache where workflow_id = :w "
                                 "and global_port_id = :g and source_execution_id = :e order by updated_at desc limit 1"),
                         {"w": int(workflow), "e": int(execution), "g": port_id(operator, port)}).fetchone()
        return (row[0], "operator_port_cache") if row else (None, None)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--workflow-id", required=True); p.add_argument("--execution-id", required=True)
    p.add_argument("--operator-id", required=True); p.add_argument("--port", type=int, default=0)
    p.add_argument("--out", required=True); p.add_argument("--uri")
    a = p.parse_args()
    uri, source = (a.uri, "given") if a.uri else result_uri(a.workflow_id, a.execution_id, a.operator_id, a.port)
    if not uri:
        print(json.dumps({"ok": False, "error": "no stored result for this operator and execution"})); return 2
    from core.storage.storage_config import StorageConfig
    StorageConfig.initialize(**STACK)
    from core.storage.document_factory import DocumentFactory
    document, _ = DocumentFactory.open_document(uri)
    tables = list(document.get_arrow_tables())
    table = pa.concat_tables(tables) if tables else None
    if table is None:
        print(json.dumps({"ok": False, "error": "stored result has no data files", "uri": uri})); return 2
    frame = table.to_pandas(integer_object_nulls=True)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    frame.to_csv(a.out, index=False)
    print(json.dumps({"ok": True, "uri": uri, "registry": source, "rows": len(frame), "columns": list(frame.columns),
                      "count": document.get_count()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
