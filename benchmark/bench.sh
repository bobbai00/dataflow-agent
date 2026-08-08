#!/usr/bin/env bash
#
# bench.sh — one entry point for both benchmarks against the dataflow agent.
#
#   KramaBench  (benchmark/Kramabench, git submodule, branch `stable`)
#       104 single-question data-science tasks over 6 domain data lakes,
#       scored by the repo's own evaluate.py harness. Driven through kb.py.
#
#   LongDS-Bench  (benchmark/longds, part of this repo)
#       68 tasks / 2,225 turns of long-horizon multi-turn analysis
#       (zjunlp/DataMind). One agent + one workflow per task; judged by an
#       LLM with upstream's own judge prompt.
#
# The full Texera stack must be running first:  bin/local-dev.sh up
# (see docs/local-dev-with-agent.md — remember GUI copilot + LITELLM env).
#
# Usage:
#   benchmark/bench.sh setup [--copy-from PATH]     one-time: venv, .env, data,
#                                                   symlinks, DataMind clone,
#                                                   LongDS sample task
#   benchmark/bench.sh kb <kb.py args...>           any kb.py command, e.g.:
#       benchmark/bench.sh kb systems
#       benchmark/bench.sh kb tasks --sut DataflowSystemStableHaiku --ids "legal-easy-1"
#       benchmark/bench.sh kb scores --sut DataflowSystemStableHaiku
#   benchmark/bench.sh longds prepare [--task d/ds/t]
#   benchmark/bench.sh longds run --task <key> [--arm haiku-delta-1k] [--turn-limit N]
#   benchmark/bench.sh longds judge --sut <SUT> [--judge-model MODEL]
#   benchmark/bench.sh longds analyze --sut <SUT> --task <key>
#   benchmark/bench.sh longds download --task <domain/dataset/task>   fetch one more task from HF
#
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$BENCH_DIR/.." && pwd)"
KB="$BENCH_DIR/Kramabench"
LONGDS="$BENCH_DIR/longds"
PY="$KB/.venv/bin/python"

die() { echo "FATAL: $*" >&2; exit 1; }

need_venv() {
    [[ -x "$PY" ]] || die "no venv at $KB/.venv — run: benchmark/bench.sh setup"
}

cmd_setup() {
    local copy_from=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --copy-from) copy_from="$2"; shift 2 ;;
            *) die "unknown setup flag: $1" ;;
        esac
    done

    echo "[bench] submodule init/update (Kramabench @ stable)"
    git -C "$REPO_ROOT" submodule update --init benchmark/Kramabench

    if [[ ! -x "$PY" ]]; then
        echo "[bench] creating Kramabench venv"
        ( cd "$KB" && uv venv -q .venv && uv pip install -q -r requirements.txt --python .venv/bin/python )
        "$KB/.venv/bin/pip" install -q huggingface_hub kagglehub
    fi

    if [[ ! -f "$KB/.env" ]]; then
        echo "[bench] WARNING: $KB/.env missing — KramaBench scoring calls the real"
        echo "        OpenAI API (gpt-4o-mini) and needs OPENAI_API_KEY in that file."
    fi

    echo "[bench] symlinks"
    ln -sfn benchmark/Kramabench/data "$REPO_ROOT/data"
    ln -sfn ../../longds/DataMind/longds/dataset/data/longds "$KB/data/longds"
    # bin/local-dev.sh launches computing-unit-master with cwd=amber/, and the
    # Python UDF workers inherit it — this makes `data/...` resolve there too.
    ln -sfn ../data "$REPO_ROOT/amber/data"

    if [[ ! -d "$LONGDS/DataMind" ]]; then
        echo "[bench] cloning zjunlp/DataMind (judge prompt + dataset home)"
        git clone -q --depth 1 https://github.com/zjunlp/DataMind.git "$LONGDS/DataMind"
    fi

    echo "[bench] KramaBench data check (fetches wildfire's Kaggle csv if absent)"
    ( cd "$KB" && ./kb.py setup-data ${copy_from:+--copy-from "$copy_from"} ) || true

    if [[ ! -f "$LONGDS/DataMind/longds/dataset/task/longds/task_list.json" ]]; then
        echo "[bench] downloading LongDS sample task (nfl task1) from HF"
        cmd_longds_download --task sports/nfl_big_data_bowl_2023/task1
    fi

    echo "[bench] preparing LongDS sample task"
    "$PY" "$LONGDS/prepare.py" --task sports/nfl_big_data_bowl_2023/task1 || true

    echo "[bench] setup done. Next:"
    echo "  benchmark/bench.sh kb tasks --sut DataflowSystemStableHaiku --ids \"legal-easy-1\""
    echo "  benchmark/bench.sh longds run --task sports__nfl_big_data_bowl_2023__task1 --turn-limit 3"
}

cmd_longds_download() {
    local task=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --task) task="$2"; shift 2 ;;
            *) die "unknown download flag: $1" ;;
        esac
    done
    [[ -n "$task" ]] || die "longds download needs --task domain/dataset/task"
    need_venv
    TASK="$task" DATASET_DIR="$LONGDS/DataMind/longds/dataset" "$PY" - <<'EOF'
import os
from huggingface_hub import snapshot_download
task = os.environ["TASK"].strip("/")
snapshot_download(
    repo_id="zjunlp/LongDS", repo_type="dataset",
    local_dir=os.environ["DATASET_DIR"],
    allow_patterns=[
        "task/longds/task_list.json",
        f"task/longds/{task}/*",
        f"data/longds/{task}/*",
    ],
)
print(f"downloaded {task} into {os.environ['DATASET_DIR']}")
EOF
}

cmd_kb() {
    need_venv
    ( cd "$KB" && ./kb.py "$@" )
}

cmd_longds() {
    need_venv
    local sub="${1:-}"; shift || true
    case "$sub" in
        prepare)  "$PY" "$LONGDS/prepare.py" "$@" ;;
        run)      "$PY" -u "$LONGDS/run_longds.py" "$@" ;;
        judge)    "$PY" "$LONGDS/judge_longds.py" "$@" ;;
        analyze)  "$PY" "$LONGDS/analyze_run.py" "$@" ;;
        download) cmd_longds_download "$@" ;;
        gate)     "$PY" "$LONGDS/numeric_gate.py" "$@" ;;
        *) die "longds subcommand must be one of: prepare run judge analyze download gate" ;;
    esac
}

case "${1:-}" in
    setup)  shift; cmd_setup "$@" ;;
    kb)     shift; cmd_kb "$@" ;;
    longds) shift; cmd_longds "$@" ;;
    *)
        sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
        exit 1
        ;;
esac
