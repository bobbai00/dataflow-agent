# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time

import session_budget as subject
from session_budget import budget_answers, calls_stats, find_runner, terminate_tree


def test_budget_keeps_completed_answer_and_charges_interrupted_turn(tmp_path):
    (tmp_path / "turns").mkdir()
    (tmp_path / "turns/answers.json").write_text(json.dumps([
        {"turn_id": 1, "answer": "Final Answer: {\"value\": 9}", "stats": {"llm_calls": 1, "cost_usd": 0.001}}
    ]))
    turns = [{"turn_id": i} for i in (1, 2, 3)]
    trace = [
        {"role": "user", "messageId": "m1"},
        {"role": "agent", "messageId": "m1", "usage": {"inputTokens": 100}},
        {"role": "user", "messageId": "m2"},
        {"role": "agent", "messageId": "m2", "usage": {"inputTokens": 1000, "outputTokens": 50}},
    ]
    result = budget_answers(tmp_path, turns, trace)
    assert result[0]["answer"] == '{"value": 9}'
    assert result[1]["answer"] == result[2]["answer"] == ""
    assert result[1]["attempted"] is True
    assert result[2]["attempted"] is False
    assert result[1]["stats"]["cost_usd"] == 0.00026
    assert result[2]["stats"]["llm_calls"] == 0


def test_python_checkpoint_recovers_answers_and_all_call_spending(tmp_path):
    agent = tmp_path / "agent"
    (agent / "bak").mkdir(parents=True)
    (agent / "bak/turn_1_result.json").write_text(json.dumps([
        {"role": "assistant", "content": "<answer>{\"x\":2}</answer>"}
    ]))
    calls = [{"turn_index": 0, "input_tokens": 100}, {"turn_index": 1, "input_tokens": 200}]
    (agent / "calls.jsonl").write_text("".join(json.dumps(c) + "\n" for c in calls))
    result = budget_answers(tmp_path, [{"turn_id": 1}, {"turn_id": 2}], None)
    assert result[0]["answer"] == '{"x":2}'
    assert result[1]["error"]
    assert sum(t["stats"]["input_tokens"] for t in result) == 300


def test_process_selection_requires_exact_script_task_and_sut(tmp_path):
    for pid, argv in {
        100: ["python", "/repo/run_official.py", "--sut", "ours", "--task", "task1"],
        200: ["python", "/repo/run_official.py", "--sut", "other", "--task", "task1"],
        300: ["python", "/repo/run_official_matrix.py", "--sut-prefix", "ours"],
    }.items():
        directory = tmp_path / str(pid)
        directory.mkdir()
        (directory / "cmdline").write_bytes(b"\0".join(a.encode() for a in argv) + b"\0")
    assert find_runner("ours", "task1", tmp_path) == [100]
    assert find_runner("ours", "task2", tmp_path) == []


def test_cache_aware_budget_accounting_does_not_double_count_reasoning():
    stats = calls_stats([{"input_tokens": 1000, "cached_tokens": 800, "cache_write_tokens": 100,
                          "output_tokens": 50, "reasoning_tokens": 20}])
    assert abs(stats["cost_usd"] - 0.000121) < 1e-12


def test_budget_terminates_only_the_selected_process_tree(tmp_path):
    child_file = tmp_path / "child"
    code = "import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)']); Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(120)"
    selected = subprocess.Popen([sys.executable, "-c", code, str(child_file)])
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
    try:
        deadline = time.time() + 5
        while not child_file.exists() and time.time() < deadline:
            time.sleep(0.01)
        child = int(child_file.read_text())
        terminate_tree([selected.pid])
        assert selected.wait(timeout=3) != 0
        stat = Path(f"/proc/{child}/stat")
        assert not stat.exists() or stat.read_text().split(") ", 1)[1].split()[0] == "Z"
        assert unrelated.poll() is None
    finally:
        terminate_tree([selected.pid, unrelated.pid])
        selected.wait()
        unrelated.wait()


def test_efficiency_budget_stops_only_its_matching_agent(tmp_path, monkeypatch):
    directory = tmp_path / 'sut' / 'task'
    directory.mkdir(parents=True)
    (directory / 'prompts.json').write_text(json.dumps([{'prompt': 'first question'}]))
    started = 1700000000
    created = datetime.fromtimestamp(started + 2, timezone.utc).isoformat()
    agents = [
        {'id': 'other-arm', 'createdAt': created, 'settings': {'nativeAnalysisState': True, 'nativeTaskEfficiency': False}, 'delegate': {'workflowId': 11}},
        {'id': 'ours', 'createdAt': created, 'settings': {'nativeAnalysisState': True, 'nativeTaskEfficiency': True}, 'delegate': {'workflowId': 22}},
    ]
    steps = [{'id': 'u', 'role': 'user', 'content': 'first question'}]
    stops = []
    def api(base, path, method='GET'):
        if path == '/': return {'agents': agents}
        if path.endswith('/react-steps'): return {'steps': steps}
        if path.endswith('/stop'):
            stops.append(path)
            return {}
        if path == '/ours': return {'state': 'AVAILABLE'}
        return {}
    monkeypatch.setattr(subject, 'api', api)
    monkeypatch.setattr(subject, 'find_runner', lambda sut, task: [123])
    budget = {'started': started}
    trace = subject.stop_native(directory, {'arm': 'react-efficient'}, budget, 'unused')
    assert stops == ['/ours/stop']
    assert trace == steps
    assert budget['agent'] == 'ours'
    assert budget['workflow'] == 22


def test_budget_publishes_results_before_runner_exits(tmp_path, monkeypatch):
    directory = tmp_path / 'sut' / 'task'
    directory.mkdir(parents=True)
    (directory / 'protocol.json').write_text(json.dumps({'arm': 'dsgym', 'model': 'test', 'turns': 0}))
    prepared = tmp_path / 'prepared' / 'task'
    prepared.mkdir(parents=True)
    (prepared / 'gold.json').write_text('{}')
    (prepared / 'manifest.json').write_text('{"turns":[]}')
    monkeypatch.setattr(subject, 'PREPARED', prepared.parent)
    events = []
    monkeypatch.setattr(subject, 'find_runner', lambda sut, task: [123])
    def pause(roots):
        assert roots == [123]
        events.append('pause')
        return {123: 'start-ticks'}
    def publish(directory, *args):
        (directory / 'results_with_ground_truth.json').write_text('[]')
        (directory / 'summary.json').write_text('{}')
        events.append('publish')
    def terminate(roots, expected=None):
        assert (directory / 'results_with_ground_truth.json').exists()
        assert json.loads((directory / 'summary.json').read_text())['session_budget_exceeded']
        assert expected == {123: 'start-ticks'}
        events.append('terminate')
    monkeypatch.setattr(subject, 'pause_tree', pause, raising=False)
    monkeypatch.setattr(subject, 'write_records', publish)
    monkeypatch.setattr(subject, 'terminate_tree', terminate)
    subject.expire(directory, {'seconds': 3600}, 'unused')
    assert events == ['pause', 'publish', 'terminate']


def test_budget_never_terminates_a_reused_runner_pid():
    unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
    try:
        subject.terminate_tree([unrelated.pid], expected={unrelated.pid: 'wrong-start-ticks'})
        assert unrelated.poll() is None
    finally:
        unrelated.terminate()
        unrelated.wait()
