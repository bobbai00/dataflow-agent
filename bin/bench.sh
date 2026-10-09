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
#   bin/bench.sh setup [--copy-from PATH]     one-time: venv, .env, data,
#                                                   symlinks, DataMind clone,
#                                                   LongDS sample task
#   bin/bench.sh kb <kb.py args...>           any kb.py command, e.g.:
#       bin/bench.sh kb systems
#       bin/bench.sh kb tasks --sut DataflowSystemStableHaiku --ids "legal-easy-1"
#       bin/bench.sh kb scores --sut DataflowSystemStableHaiku
#   bin/bench.sh longds prepare [--task d/ds/t]
#   bin/bench.sh longds run --task <key> [--arm haiku-delta-1k] [--turn-limit N]
#   bin/bench.sh longds judge --sut <SUT> [--judge-model MODEL]
#   bin/bench.sh longds analyze --sut <SUT> --task <key>
#   bin/bench.sh longds download --task <domain/dataset/task>   fetch one more task from HF
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BENCH_DIR="$REPO_ROOT/benchmark"
KB="$BENCH_DIR/Kramabench"
LONGDS="$BENCH_DIR/longds"
PY="$KB/.venv/bin/python"

# Root .env: OPENAI_API_KEY (KramaBench scoring + gpt models), ANTHROPIC key,
# JUDGE_* overrides. Shell-exported values win — only unset variables are
# taken from the file. See .env.example.
if [[ -f "$REPO_ROOT/.env" ]]; then
    while IFS= read -r _envline; do
        _envline="${_envline#export }"
        [[ "$_envline" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
        _k="${_envline%%=*}"
        if [[ -z "${!_k:-}" ]]; then
            _v="${_envline#*=}"
            _v="${_v%\"}"; _v="${_v#\"}"; _v="${_v%\'}"; _v="${_v#\'}"
            export "$_k=$_v"
        fi
    done < "$REPO_ROOT/.env"
fi

die() { echo "FATAL: $*" >&2; exit 1; }

need_venv() {
    [[ -x "$PY" ]] || die "no venv at $KB/.venv — run: bin/bench.sh setup"
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
    # --remote follows the branch .gitmodules declares (stable) instead of the
    # SHA the parent happens to pin. Without it a fresh setup silently lands on
    # whatever commit was current when the pointer was last committed, missing
    # SUTs added since (this is how ClaudeCodeSystem went absent from a clean
    # checkout). Fall back to the pinned SHA when the remote is unreachable.
    git -C "$REPO_ROOT" submodule update --init --remote benchmark/Kramabench \
        || git -C "$REPO_ROOT" submodule update --init benchmark/Kramabench
    echo "[bench]   Kramabench @ $(git -C "$KB" log --oneline -1 2>/dev/null)"

    if [[ ! -x "$PY" ]]; then
        echo "[bench] creating Kramabench venv"
        ( cd "$KB" && uv venv -q .venv && uv pip install -q -r requirements.txt --python .venv/bin/python )
        # uv venvs ship no pip binary — install through uv against the venv.
        uv pip install -q huggingface_hub kagglehub --python "$PY"
    fi

    # KramaBench's evaluate.py does not load the root .env, so the scoring
    # metrics (llm_paraphrase / f1_approximate, both gpt-4o-mini) read
    # OPENAI_API_KEY from the submodule's own .env. Seed it from the root value
    # we already exported; a dummy/absent key silently zeroes those metrics.
    if [[ ! -f "$KB/.env" ]]; then
        if [[ -n "${OPENAI_API_KEY:-}" ]]; then
            echo "[bench] writing $KB/.env (OPENAI_API_KEY from the root .env)"
            printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" > "$KB/.env"
        else
            echo "[bench] WARNING: $KB/.env missing and OPENAI_API_KEY unset — KramaBench"
            echo "        scoring calls the real OpenAI API (gpt-4o-mini) and needs it."
        fi
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
    # Run kb.py through the venv interpreter, NOT ./kb.py — its shebang is
    # `#!/usr/bin/env python3`, which picks up whatever python3 is on PATH and
    # therefore lacks kagglehub, so the Kaggle fetch dies with
    # "FATAL: pip install kagglehub".
    ( cd "$KB" && "$PY" kb.py setup-data ${copy_from:+--copy-from "$copy_from"} ) || true

    if [[ ! -f "$LONGDS/DataMind/longds/dataset/task/longds/task_list.json" ]]; then
        echo "[bench] downloading LongDS sample task (nfl task1) from HF"
        cmd_longds_download --task sports/nfl_big_data_bowl_2023/task1
    fi

    echo "[bench] preparing LongDS sample task"
    "$PY" "$LONGDS/prepare.py" --task sports/nfl_big_data_bowl_2023/task1 || true

    echo "[bench] setup done. Next:"
    echo "  bin/bench.sh kb tasks --sut DataflowSystemStableHaiku --ids \"legal-easy-1\""
    echo "  bin/bench.sh longds run --task sports__nfl_big_data_bowl_2023__task1 --turn-limit 3"
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
    # Run kb.py WITH the venv interpreter, not via its `#!/usr/bin/env python3`
    # shebang. Most subcommands shell out to `$PY` and so were unaffected, but
    # anything kb.py imports in-process (setup-data's kagglehub) resolved
    # against the system python and failed with a misleading
    # "pip install kagglehub".
    ( cd "$KB" && "$PY" kb.py "$@" )
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
