#!/usr/bin/env bash
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

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test_state=$(mktemp -d)
# Read-only status checks: never start or stop a live service.
result=$(TEXERA_LOCAL_DEV_DIR="$test_state" TEXERA_AGENT_SERVICE_PORT=3008 \
    "$REPO_ROOT/bin/local-dev.sh" status --json) || true
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); s=next(s for s in d["services"] if s["service"]=="agent-service"); assert s["port"]==3008,s' "$result"
for invalid in 0 65536 not-a-port; do
    if TEXERA_LOCAL_DEV_DIR="$test_state" TEXERA_AGENT_SERVICE_PORT="$invalid" \
        "$REPO_ROOT/bin/local-dev.sh" version >/dev/null 2>&1; then
        printf 'Invalid agent port was accepted: %s\n' "$invalid" >&2
        exit 1
    fi
done
printf 'Agent service port override and validation passed.\n'
