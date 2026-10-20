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
import json
import subprocess
import sys

from comparison_campaign import completed_artifacts, process_matches


def test_recovery_uses_completeness_and_preserves_incorrect_answers(tmp_path):
    source = tmp_path / 'results_eval.json'
    assert not completed_artifacts(tmp_path, 2)
    rows = [{'turn_id': 1, 'judge': {'score': 0}}, {'turn_id': 2, 'judge': {'score': 1}}]
    source.write_text(json.dumps(rows))
    assert completed_artifacts(tmp_path, 2)
    rows[1]['judge']['score'] = None
    source.write_text(json.dumps(rows))
    assert not completed_artifacts(tmp_path, 2)
    rows[1] = rows[0]
    source.write_text(json.dumps(rows))
    assert not completed_artifacts(tmp_path, 2)


def test_pid_reuse_does_not_adopt_an_unrelated_process(tmp_path):
    proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'])
    try:
        assert not process_matches(proc.pid, tmp_path)
    finally:
        proc.terminate()
        proc.wait()
