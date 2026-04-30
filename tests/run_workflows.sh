#!/usr/bin/env bash
# Drive each test workflow end-to-end through the live ComputingUnitMaster.
#
#   1. Log in as bob@test.com (texera web app on :8080) -> JWT.
#   2. For each tests/0X-*/workflow.json:
#        - Translate our compact workflow JSON into the LogicalPlanPojo +
#          SyncExecutionRequest shape /api/execution/{wid}/{cuid}/run wants.
#        - POST to the master, with the JWT.
#        - Save the response under tests/0X-*/live-result.json.
#   3. Summarize.

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

USER_EMAIL="bob@test.com"
USER_PASSWORD="123456"
WEB_BASE="http://localhost:8080/api"
EXEC_BASE="http://localhost:8085/api/execution"
CUID=1            # Bob's first computing unit
WID_BASE=5864     # 5864..5868 -> 01..05; 5869..5873 -> 06..10

PYTHON="$REPO_ROOT/.venv/bin/python"

# --- Login ----------------------------------------------------------------
echo "[1/3] Logging in as $USER_EMAIL"
TOKEN=$(curl -sS -X POST "$WEB_BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\"}" \
  | "$PYTHON" -c "import json,sys; print(json.load(sys.stdin)['accessToken'])")
if [ -z "$TOKEN" ]; then
  echo "  login failed"
  exit 1
fi
echo "  ok (token len=${#TOKEN})"

# --- Run each workflow ----------------------------------------------------
TESTS=(01-single-chain 02-two-input-join 03-three-input-merge 04-multiple-parallel-chains 05-diamond-topology 06-tree-fanout 07-wide-dag 08-deep-chain 09-balanced-tree 10-mixed-dag)

declare -a STATUSES

for i in "${!TESTS[@]}"; do
  TEST="${TESTS[$i]}"
  WID=$(( WID_BASE + i ))
  WF_JSON="$REPO_ROOT/tests/$TEST/workflow.json"
  OUT_JSON="$REPO_ROOT/tests/$TEST/live-result.json"

  echo
  echo "[2/3] Running $TEST  (wid=$WID, cuid=$CUID)"

  # Translate workflow.json -> SyncExecutionRequest
  REQ=$("$PYTHON" - <<PY
import json, sys
wf = json.load(open("$WF_JSON"))

operators = []
for op in wf["operators"]:
    operators.append({
        "operatorID": op["operatorID"],
        "operatorType": op["operatorType"],
        "operatorVersion": "live",
        "code": op["code"],
    })

links = []
for ln in wf["links"]:
    links.append({
        "fromOpId": ln["fromOpId"],
        "fromPortId": {"id": ln["fromPortIndex"], "internal": False},
        "toOpId":   ln["toOpId"],
        "toPortId": {"id": ln["toPortIndex"],   "internal": False},
    })

# Find the terminal operators (no outgoing links) for opsToViewResult / targetOperatorIds
terminal = sorted({op["operatorID"] for op in wf["operators"]} - {ln["fromOpId"] for ln in wf["links"]})

req = {
    "executionName": "$TEST",
    "logicalPlan": {
        "operators": operators,
        "links": links,
        "opsToViewResult": terminal,
        "opsToReuseResult": [],
    },
    "workflowSettings": None,
    "targetOperatorIds": terminal,
    "timeoutSeconds": 180,
    "maxOperatorResultCharLimit": 50000,
    "maxOperatorResultCellCharLimit": 5000,
}
print(json.dumps(req))
PY
)

  HTTP_CODE=$(curl -sS -o "$OUT_JSON" -w "%{http_code}" \
    -X POST "$EXEC_BASE/$WID/$CUID/run" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$REQ")

  STATUS=$("$PYTHON" - <<PY
import json
try:
    d = json.load(open("$OUT_JSON"))
    ops = d.get("operators") or {}
    have_stats = sum(1 for o in ops.values() if o.get("columnStats"))
    total_ops = len(ops)
    rows = sum((o.get("totalRowCount") or 0) for o in ops.values())
    print(f"http=$HTTP_CODE state={d.get('state')!r} success={d.get('success')!r} "
          f"ops={total_ops} rows={rows} stats={have_stats}/{total_ops}")
except Exception as e:
    print(f"http=$HTTP_CODE  parse_failed: {e}")
PY
)
  echo "  $STATUS"
  STATUSES+=("$TEST: $STATUS")
done

# --- Summary --------------------------------------------------------------
echo
echo "[3/3] Summary"
for s in "${STATUSES[@]}"; do echo "  $s"; done
