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
# Read-only checks: never start, stop, or join a running computing unit.
result=$(TEXERA_LOCAL_DEV_DIR="$test_state" TEXERA_CU_MASTER_PORT=8086 \
    TEXERA_CU_MASTER_ACTOR_PORT=2553 "$REPO_ROOT/bin/local-dev.sh" status --json) || true
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); s=next(s for s in d["services"] if s["service"]=="computing-unit-master"); assert s["port"]==8086,s' "$result"
for setting in TEXERA_CU_MASTER_PORT TEXERA_CU_MASTER_ACTOR_PORT; do
    for invalid in 0 65536 not-a-port; do
        if env TEXERA_LOCAL_DEV_DIR="$test_state" "$setting=$invalid" \
            "$REPO_ROOT/bin/local-dev.sh" version >/dev/null 2>&1; then
            printf 'Invalid %s was accepted: %s\n' "$setting" "$invalid" >&2
            exit 1
        fi
    done
done
printf 'Computing-unit HTTP and actor port override validation passed.\n'
