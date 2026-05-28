#!/usr/bin/env python3
"""
Analyze the 49 baseline failure traces to build targeted subsets for three levers.
Extracts per-(task, model): finalScore, totalCreateOrModify, maxEditsToOneOp,
numOperators, numRedundantLoadersSamePath, errorClass, isLoadStageFailure.
"""

import json
import os
import re
import csv
import sys
from collections import defaultdict

BASE = '/home/bob/Desktop/bobflow/failed-or-timeout-tasks'
MODELS = ['DataflowSystemGPT5MiniFullStatsOn', 'DataflowSystemGPT52FullStatsOn']
MODEL_LABELS = {
    'DataflowSystemGPT5MiniFullStatsOn': 'gpt-5-mini',
    'DataflowSystemGPT52FullStatsOn': 'gpt-5.2',
}

# Score metric priority: success > f1 > f1_approximate > llm_paraphrase > rae_score (inverted)
IGNORE_KEYS = {
    'task_id', 'model_output', 'code', 'token_usage_sut', 'token_usage_sut_input',
    'token_usage_sut_output', 'runtime', 'token_usage_metrics', 'token_usage_metrics_input',
    'token_usage_metrics_output', 'token_usage_subtask_eval', 'token_usage_subtask_eval_input',
    'token_usage_subtask_eval_output', 'precision', 'recall',
    'mean_absolute_error', 'mean_squared_error',  # raw error metrics - lower is worse, skip
}

# Error classification priority for normalizing
LOAD_ERROR_CLASSES = {'UnicodeDecodeError', 'FileNotFoundError', 'ParserError'}
PROCESS_ERROR_CLASSES = {'KeyError', 'TypeError', 'ValueError', 'AttributeError', 'NameError',
                          'Exception', 'ImportError'}

TIMEOUT_SECONDS = 900  # 15 min threshold for timeout classification


def get_final_score(ev: dict) -> float:
    """Extract a [0,1] final score from evaluation.json using metric priority."""
    if 'success' in ev:
        return float(ev['success'])
    if 'f1' in ev:
        return float(ev['f1'])
    if 'f1_approximate' in ev:
        return float(ev['f1_approximate'])
    if 'llm_paraphrase' in ev:
        return float(ev['llm_paraphrase'])
    if 'rae_score' in ev:
        # RAE score: 0=perfect, 1=bad; convert to accuracy-like [0,1]
        return max(0.0, 1.0 - float(ev['rae_score']))
    return 0.0


def count_create_or_modify(steps: list) -> tuple[int, dict]:
    """Return (total createOrModifyOperator calls, dict of operatorId -> count)."""
    total = 0
    per_op = defaultdict(int)
    for s in steps:
        for tc in s.get('toolCalls', []):
            if tc.get('toolName') == 'createOrModifyOperator':
                op_id = tc.get('input', {}).get('operatorId', '__unknown__')
                per_op[op_id] += 1
                total += 1
    return total, dict(per_op)


def get_operators_from_workflow(wf: dict) -> list:
    """Extract operators list from workflow.json."""
    try:
        return wf['workflow']['operators']
    except (KeyError, TypeError):
        return []


def get_redundant_loaders_same_path(operators: list) -> int:
    """
    Count loader operators (DataLoading) that read the same source file path under different ids.
    A path is extracted from the code using regex for read_csv/read_excel/open calls.
    """
    path_pattern = re.compile(
        r"(?:read_csv|read_excel|open|read_parquet|read_json|read_table)\s*\(\s*['\"]([^'\"]+)['\"]"
    )
    # map: canonical_path -> list of operatorIDs
    path_to_ops = defaultdict(list)
    for op in operators:
        if op.get('operatorType') != 'DataLoading':
            continue
        code = op.get('operatorProperties', {}).get('code', '')
        op_id = op.get('operatorID', '')
        paths = path_pattern.findall(code)
        for p in paths:
            # normalize: strip leading 'data/' prefix variations
            p_norm = p.strip()
            path_to_ops[p_norm].append(op_id)

    # count paths that have more than one distinct loader
    redundant = 0
    for p, ops_list in path_to_ops.items():
        if len(ops_list) > 1:
            redundant += len(ops_list) - 1  # extra loaders beyond the first
    return redundant


def get_terminal_error_class(steps: list, elapsed: float) -> str:
    """
    Scan inputMessages for [ERROR] lines and return the terminal (last-seen) error class.
    Falls back to 'timeout' if elapsed > TIMEOUT_SECONDS, else 'none'.
    """
    if elapsed > TIMEOUT_SECONDS:
        return 'timeout'

    all_errors = []
    error_re = re.compile(r'\[ERROR\]\s+(\w+)(?:Error|Exception)?(?:Error|Exception)?\s*:')
    # More precise: capture ErrorClass exactly
    error_re2 = re.compile(r'\[ERROR\]\s+(\w+Error|\w+Exception|Exception|NameError|ValueError|AttributeError|ImportError|KeyError|TypeError|FileNotFoundError|UnicodeDecodeError|ParserError|IndexError|StopIteration)\s*:')

    for s in steps:
        im = s.get('inputMessages', [])
        for m in im:
            c = str(m.get('content', ''))
            for match in error_re2.finditer(c):
                all_errors.append(match.group(1))

    if not all_errors:
        return 'none'

    last_err = all_errors[-1]
    # Normalize to requested classes
    if last_err == 'UnicodeDecodeError':
        return 'UnicodeDecodeError'
    if last_err == 'FileNotFoundError':
        return 'FileNotFoundError'
    if last_err == 'ParserError':
        return 'ParserError'
    if last_err == 'KeyError':
        return 'KeyError'
    if last_err == 'TypeError':
        return 'TypeError'
    if last_err in {'ValueError', 'AttributeError', 'NameError', 'ImportError',
                    'Exception', 'IndexError', 'StopIteration'}:
        return last_err
    return last_err


def is_load_stage_failure(steps: list, operators: list, error_class: str) -> bool:
    """
    Determine if the failure occurred in a DataLoading operator.
    Heuristic: the terminal error appeared in the execution of a DataLoading operator
    or the error class is a loader-class error (UnicodeDecodeError, FileNotFoundError, ParserError).
    """
    if error_class in LOAD_ERROR_CLASSES:
        return True

    # Try to find which operator's code was associated with the last error
    error_re = re.compile(
        r'\[ERROR\]\s+\w+.*?\n.*?Operator code:\s*\n\s*1 \| def (load|process)\s*\('
        , re.DOTALL
    )
    # Scan inputMessages for error context
    for s in reversed(steps):
        for m in s.get('inputMessages', []):
            c = str(m.get('content', ''))
            matches = list(error_re.finditer(c))
            if matches:
                last_fn = matches[-1].group(1)
                return last_fn == 'load'
    return False


def analyze_task_model(task: str, model_dir: str) -> dict | None:
    """Analyze one (task, model) pair and return metrics dict."""
    model_path = os.path.join(BASE, task, model_dir)
    if not os.path.isdir(model_path):
        return None

    try:
        ev = json.load(open(os.path.join(model_path, 'evaluation.json')))
        st = json.load(open(os.path.join(model_path, 'stats.json')))
        rs = json.load(open(os.path.join(model_path, 'react_steps.json')))
        wf = json.load(open(os.path.join(model_path, 'workflow.json')))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"  SKIP {task}/{model_dir}: {e}", file=sys.stderr)
        return None

    steps = rs.get('steps', [])
    operators = get_operators_from_workflow(wf)
    elapsed = st.get('elapsed_seconds', 0)

    final_score = get_final_score(ev)
    total_create_or_modify, per_op_counts = count_create_or_modify(steps)
    max_edits_to_one_op = max(per_op_counts.values()) if per_op_counts else 0
    num_operators = len(operators)
    num_redundant_loaders = get_redundant_loaders_same_path(operators)
    error_class = get_terminal_error_class(steps, elapsed)
    load_stage_failure = is_load_stage_failure(steps, operators, error_class)
    total_tokens = st.get('total_tokens', ev.get('token_usage_sut', 0))

    return {
        'task': task,
        'model': MODEL_LABELS.get(model_dir, model_dir),
        'finalScore': round(final_score, 4),
        'totalCreateOrModify': total_create_or_modify,
        'maxEditsToOneOp': max_edits_to_one_op,
        'numOperators': num_operators,
        'numRedundantLoadersSamePath': num_redundant_loaders,
        'errorClass': error_class,
        'isLoadStageFailure': load_stage_failure,
        'totalTokens': total_tokens,
        'per_op_counts': per_op_counts,  # internal, not in CSV
    }


def main():
    tasks = sorted(os.listdir(BASE))
    rows = []
    # gpt-5-mini for all; gpt-5.2 for highest-token tasks
    # First pass: get all gpt-5-mini data
    mini_rows = []
    for task in tasks:
        result = analyze_task_model(task, 'DataflowSystemGPT5MiniFullStatsOn')
        if result:
            mini_rows.append(result)

    # Sort by tokens to find highest-cost tasks
    sorted_by_tokens = sorted(mini_rows, key=lambda r: r['totalTokens'], reverse=True)
    high_token_tasks = {r['task'] for r in sorted_by_tokens[:15]}

    # Second pass: gpt-5.2 for high-token tasks
    gpt52_rows = []
    for task in high_token_tasks:
        result = analyze_task_model(task, 'DataflowSystemGPT52FullStatsOn')
        if result:
            gpt52_rows.append(result)

    all_rows = mini_rows + gpt52_rows

    # --- Write CSV ---
    csv_fields = ['task', 'model', 'finalScore', 'totalCreateOrModify',
                  'maxEditsToOneOp', 'numOperators', 'numRedundantLoadersSamePath',
                  'errorClass', 'isLoadStageFailure']

    csv_lines = [','.join(csv_fields)]
    for r in all_rows:
        row_vals = [
            r['task'],
            r['model'],
            str(r['finalScore']),
            str(r['totalCreateOrModify']),
            str(r['maxEditsToOneOp']),
            str(r['numOperators']),
            str(r['numRedundantLoadersSamePath']),
            r['errorClass'],
            str(r['isLoadStageFailure']),
        ]
        csv_lines.append(','.join(row_vals))

    csv_text = '\n'.join(csv_lines)
    print("\n=== CSV OUTPUT ===")
    print(csv_text)

    # --- Error class counts (gpt-5-mini only) ---
    print("\n=== ERROR CLASS COUNTS (gpt-5-mini) ===")
    error_counts = defaultdict(int)
    for r in mini_rows:
        error_counts[r['errorClass']] += 1
    for ec, cnt in sorted(error_counts.items(), key=lambda x: -x[1]):
        print(f"  {ec}: {cnt}")

    # --- Subsets ---
    print("\n=== SUBSET: loaderInspection (load-error failures) ===")
    loader_subset = [r['task'] for r in mini_rows
                     if r['isLoadStageFailure'] or r['errorClass'] in LOAD_ERROR_CLASSES]
    print(loader_subset)

    print("\n=== SUBSET: churnProliferation (many ops / same-path reloads) ===")
    # Tasks with numOperators >= 8 OR numRedundantLoadersSamePath >= 2
    churn_subset = [r['task'] for r in mini_rows
                    if r['numOperators'] >= 8 or r['numRedundantLoadersSamePath'] >= 2
                    or r['totalCreateOrModify'] >= 10]
    print(churn_subset)

    print("\n=== SUBSET: sameOpThrash (same operatorId edited >= 4 times) ===")
    thrash_subset = [r['task'] for r in mini_rows if r['maxEditsToOneOp'] >= 4]
    print(thrash_subset)

    # Print detailed stats for debugging
    print("\n=== DETAILED STATS (gpt-5-mini) ===")
    print(f"{'Task':<30} {'Score':>6} {'CrMod':>6} {'MaxEd':>6} {'NOps':>5} {'Redun':>6} {'Tokens':>8} {'ErrorClass'}")
    for r in sorted(mini_rows, key=lambda x: x['totalTokens'], reverse=True):
        print(f"{r['task']:<30} {r['finalScore']:>6.3f} {r['totalCreateOrModify']:>6} "
              f"{r['maxEditsToOneOp']:>6} {r['numOperators']:>5} {r['numRedundantLoadersSamePath']:>6} "
              f"{r['totalTokens']:>8} {r['errorClass']}")

    return csv_text, dict(error_counts), loader_subset, churn_subset, thrash_subset, all_rows


if __name__ == '__main__':
    main()
