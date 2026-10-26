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
# limitations under the License.

# An agent service of this checkout for one replay (replay-dataflow.ts), on the engine of a campaign stack
# (benchmark/campaign): its own port, trace database and workspace, the service's memory route on, and its model at
# the replayer's port. Run in the foreground; stop it with Ctrl-C or by killing the port's listener.
#
#   benchmark/tracker/start-agent.sh PORT MODEL_PORT RUN_DIR
set -euo pipefail
port="$1" model_port="$2" run="$3"
S="${STACK_DIR:-/var/tmp/texera-stable}"
W="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$run/workspace"
cd "$W/agent-service"
exec bash "$S/run-env.sh" env -u TEXERA_LLM_TRACE_DIR PORT="$port" LLM_ENDPOINT="http://localhost:$model_port" \
  AGENT_DEBUG_MEMORY=1 AGENT_TRACE_DB="$run/traces.db" NATIVE_WORKSPACE="$run/workspace" \
  MODEL_RETRIES_PER_TURN=0 UDF_PYTHON_PATH="$W/benchmark/retrieval/native_isolated_python.py" \
  bun run src/server.ts
