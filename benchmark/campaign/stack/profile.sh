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
# Stack profile template (rendered by render.py into the stack directory): bin/local-dev.sh reads it
# through TEXERA_LOCAL_DEV_PROFILE, and run-env.sh exports it for agents, runners and engine workers.
# Ports are the texera-stable set (local-dev port offset 56000, agent 3130).
export AMBER_MASTER_PORT=58552
export CODE_AGENT_API_BASE=http://localhost:60000
export FILE_SERVICE_GET_PRESIGNED_URL_ENDPOINT=http://localhost:65092/api/dataset/presign-download
export FILE_SERVICE_UPLOAD_ONE_FILE_TO_DATASET_ENDPOINT=http://localhost:65092/api/dataset/did/upload
export GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true
export LITELLM_BASE_URL=http://localhost:60000
export LLM_ENDPOINT=http://localhost:65096
export STORAGE_ICEBERG_CATALOG_POSTGRES_URI_WITHOUT_SCHEME=localhost:61432/texera_iceberg_catalog
export STORAGE_ICEBERG_CATALOG_TYPE=postgres
export STORAGE_JDBC_URL='jdbc:postgresql://localhost:61432/texera_db?currentSchema=texera_db,public'
export STORAGE_JDBC_URL_FOR_TEST_CASES='jdbc:postgresql://localhost:61432/texera_db_for_test_cases?currentSchema=texera_db,public'
export STORAGE_LAKEFS_ENDPOINT=http://localhost:64000/api/v1
export STORAGE_S3_ENDPOINT=http://localhost:65000
export TEXERA_ACCESS_CONTROL_SERVICE_PORT=65096
export TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3130
export TEXERA_AGENT_SERVICE_PORT=3130
export TEXERA_COMPOSE_S3_ENDPOINT=http://minio:9000
export TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:64888
export TEXERA_COMPUTING_UNIT_MANAGER_ADMIN_PORT=64082
export TEXERA_COMPUTING_UNIT_MANAGER_PORT=64888
export TEXERA_CONFIG_SERVICE_PORT=65094
export TEXERA_DASHBOARD_SERVICE_ENDPOINT=http://localhost:64080
export TEXERA_DOCKER_COMPOSE_FILE=@STACK_DIR@/compose.json
export TEXERA_DOCKER_ENV_FILE=@STACK_DIR@/infra.env
export TEXERA_DOCKER_OVERLAY_FILE=@STACK_DIR@/empty-overlay.yml
export TEXERA_DOCKER_PROJECT=@PROJECT@
export TEXERA_FILE_SERVICE_ENDPOINT=http://localhost:65092
export TEXERA_FILE_SERVICE_PORT=65092
export TEXERA_HOME=@TEXERA_HOME@
export TEXERA_LOCAL_CU_URI=http://localhost:64085
export TEXERA_LOCAL_DEV_DIR=@STACK_DIR@
export TEXERA_LOCAL_DEV_PORT_OFFSET=56000
export TEXERA_MASTER_PORT=64085
export TEXERA_POSTGRES_CONTAINER=@PROJECT@-postgres
export TEXERA_WEB_ADMIN_PORT=64081
export TEXERA_WEB_PORT=64080
export TEXERA_WORKFLOW_COMPILING_SERVICE_PORT=65090
export UDF_PYTHON_PATH=@TEXERA_HOME@/.venv/bin/python
export WORKFLOW_COMPILING_SERVICE_ENDPOINT=http://localhost:65090
export WORKFLOW_EXECUTION_SERVICE_ENDPOINT=http://localhost:64085
# Model-written Python runs in bubblewrap: no repository, git history or reports (network is not isolated).
export UDF_PYTHON_PATH=@TEXERA_HOME@/benchmark/retrieval/native_isolated_python.py
export NATIVE_ISOLATED_PYTHON=@TEXERA_HOME@/.venv/bin/python
export NATIVE_SOURCE_DATA=@KB_DATA@
export NATIVE_WORKSPACE=@STACK_DIR@/native-workspaces
# Agent and engine settings carried over from the single-task-final stack (via texera-gemini).
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export JAVA_OPTS='-Xms256m -Xmx3g -XX:ActiveProcessorCount=3'
export MODEL_MAX_OUTPUT_TOKENS=8192
export MODEL_SDK_RETRIES=0
export MODEL_RETRIES_PER_TURN=0
export OMP_NUM_THREADS=2
export OPENBLAS_NUM_THREADS=2
export MKL_NUM_THREADS=2
export PYTHONDONTWRITEBYTECODE=1
export TEXERA_SERVICE_LOG_LEVEL=ERROR
export TEXERA_LLM_TRACE_DIR=@STACK_DIR@/wire
# sbt only (applied after JAVA_OPTS): the build needs more than the services.
export SBT_OPTS="-Xmx6g -XX:ActiveProcessorCount=8"
# Registered loaders read files; the bubblewrap sandbox is the guard, not the static open()/Path() scan.
export UDF_PYTHON_ALLOW_FILE_IO=true

# 2026-10-11: let long-thinking models (Qwen 3.8) run up to 15 min per request; agents still send their own deadline.
export LLM_PROXY_MAX_DURATION_MS=900000
