#!/usr/bin/env bash
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with this
# work for additional information regarding copyright ownership. Licensed
# under the Apache License, Version 2.0 (the "License").
#
# Top-level test runner for the DataProcessing/DataLoading port. Runs:
#
#   1. Slice A unit tests (PythonCodeValidatorSpec)
#   2. Slice C descriptor + Jackson tests (DataProcessingOpDescSpec)
#   3. Workflow JSON validation across all 5 test folders
#      (CodeOperatorWorkflowsSpec) — produces tests/<test>/result.json
#   4. Python runtime tests for UDFMultiTableOperator with real datasets
#      (python_runtime_test.py) — produces tests/<test>/python-runtime-result.json

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

LOG_DIR="$REPO_ROOT/tests/.logs"
mkdir -p "$LOG_DIR"

scala_status=0
python_status=0

echo "==============================================================="
echo " Stage 1: Scala test suite"
echo "==============================================================="
sbt "project WorkflowOperator" \
  "testOnly org.apache.texera.amber.operator.PythonCodeValidatorSpec \
            org.apache.texera.amber.operator.udf.python.DataProcessingOpDescSpec \
            org.apache.texera.amber.operator.udf.python.CodeOperatorWorkflowsSpec" \
  > "$LOG_DIR/scala.log" 2>&1
scala_status=$?

# Print compact summary from sbt's log
grep -E "Tests:|Total number of tests|SUCCESS|FAILED|All tests passed" "$LOG_DIR/scala.log" | head -20

echo
echo "==============================================================="
echo " Stage 2: Python runtime test"
echo "==============================================================="
"$REPO_ROOT/.venv/bin/python" tests/python_runtime_test.py > "$LOG_DIR/python.log" 2>&1
python_status=$?
tail -25 "$LOG_DIR/python.log"

echo
echo "==============================================================="
echo " Aggregate"
echo "==============================================================="
echo "Scala  exit=$scala_status   (full log: $LOG_DIR/scala.log)"
echo "Python exit=$python_status  (full log: $LOG_DIR/python.log)"

if [ $scala_status -eq 0 ] && [ $python_status -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
