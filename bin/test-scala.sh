#!/usr/bin/env bash
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
# Run the Scala tests the way CI does: a throwaway Postgres in Docker and no other service. A running stack is fine.
# The REST catalog spec needs a Lakekeeper, so it reports as canceled here.
#
# Usage: bin/test-scala.sh [sbt tasks...]     (default: test; for example "WorkflowOperator/testOnly *ArrowUtilsSpec")
set -uo pipefail
cd "$(dirname "$0")/.."
PG=texera-scala-test-postgres PORT=${TEXERA_TEST_POSTGRES_PORT:-55439}
docker rm -f "$PG" >/dev/null 2>&1
docker run -d --rm --name "$PG" -p "$PORT:5432" -e POSTGRES_PASSWORD=postgres groonga/pgroonga:4.0.1-debian-15 >/dev/null || exit 1
trap 'docker rm -f "$PG" >/dev/null 2>&1' EXIT
until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 2
for ddl in sql/texera_ddl.sql sql/iceberg_postgres_catalog.sql sql/texera_lakefs.sql; do
  docker exec -i "$PG" psql -q -U postgres -f - < "$ddl" >/dev/null 2>&1
done
docker exec -i "$PG" psql -q -U postgres -v DB_NAME=texera_db_for_test_cases -f - < sql/texera_ddl.sql >/dev/null 2>&1
[ $# -gt 0 ] || set -- test
STORAGE_JDBC_URL="jdbc:postgresql://localhost:$PORT/texera_db?currentSchema=texera_db,public" \
STORAGE_JDBC_URL_FOR_TEST_CASES="jdbc:postgresql://localhost:$PORT/texera_db_for_test_cases?currentSchema=texera_db,public" \
STORAGE_JDBC_USERNAME=postgres STORAGE_JDBC_PASSWORD=postgres \
STORAGE_ICEBERG_CATALOG_TYPE=postgres \
STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME="localhost:$PORT/texera_iceberg_catalog" \
STORAGE_ICEBERG_CATALOG_POSTGRES_USERNAME=postgres STORAGE_ICEBERG_CATALOG_POSTGRES_PASSWORD=postgres \
FILE_SERVICE_UPLOAD_ONE_FILE_TO_DATASET_ENDPOINT="http://localhost:59092/api/dataset/did/upload" \
UDF_PYTHON_PATH="$PWD/.venv/bin/python" TEXERA_HOME="$PWD" \
TEXERA_SERVICE_LOG_LEVEL=WARN UDF_PYTHON_LOG_STREAMHANDLER_LEVEL=WARNING \
  sbt --no-colors -Dsbt.supershell=false --batch "$@"
