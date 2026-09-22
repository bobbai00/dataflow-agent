#!/usr/bin/env bash
# Judge every SUT of a trial with the paper's own judge model and print the table.
set -euo pipefail
set -a
source /home/bob/Desktop/dataflow-agent/.env
set +a
export JUDGE_BASE_URL="$OPENROUTER_BASE_URL" JUDGE_API_KEY="$OPENROUTER_API_KEY"
cd "$(dirname "$0")"
TRIAL=${1:-1}
for sut in $(ls system_scratch/ | grep "LongDS_Official_.*_t${TRIAL}$"); do
  echo "=== $sut ==="
  /home/bob/Desktop/dataflow-agent/.venv/bin/python judge_longds.py \
    --sut "$sut" --judge-model deepseek/deepseek-v4-pro "${@:2}"
done
