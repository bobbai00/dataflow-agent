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

import pytest

from official_protocol import build_prompts


def test_smolagents_prompt_uses_its_answer_tool():
    manifest = {
        "files": ["data/input.csv"], "data_dir": "data",
        "turns": [{"turn_id": 1, "context": "Keep the cleaned table.", "question": "How many rows?"}],
    }
    prompt = build_prompts(manifest, "smolagents")[0]["prompt"]
    assert "final_answer(" in prompt
    assert "Your last line MUST BE" not in prompt
    assert "variables you define stay available" in prompt
    assert "Keep the cleaned table.\nQuestion: How many rows?" in prompt


def test_smolagents_keeps_local_interpreter_state_and_hides_answers(tmp_path):
    from smolagents.default_tools import FinalAnswerTool
    from smolagents_executor import IsolatedSmolExecutor

    data, work = tmp_path / "data", tmp_path / "work"
    data.mkdir()
    work.mkdir()
    (data / "values.csv").write_text("x\n3\n7\n")
    gold = tmp_path / "gold.json"
    gold.write_text('{"answer": 1234567}')
    executor = IsolatedSmolExecutor(data, "data", work, ["pandas", "os", "posixpath"], 5000, timeout=30)
    try:
        executor.send_tools({"final_answer": FinalAnswerTool()})
        executor.send_variables({})
        first = executor("import pandas as pd\nvalues = pd.read_csv('data/values.csv')\nprint(values.x.sum())")
        assert "10" in first.logs
        assert not first.is_final_answer
        executor.send_tools({"final_answer": FinalAnswerTool()})
        executor.send_variables({})
        result = executor("values['y'] = values.x * 2\nfinal_answer({'sum': int(values.y.sum())})")
        assert result.is_final_answer and result.output == {"sum": 20}
        check = executor(f"import os\nprint(os.path.exists({str(gold)!r}))\nprint(os.getenv('OPENAI_API_KEY'))")
        assert "False" in check.logs and "None" in check.logs
        with pytest.raises(RuntimeError):
            executor("open('data/new.csv', 'w').write('bad')")
        assert executor("final_answer(int(values.y.sum()))").output == 20
    finally:
        executor.cleanup()


def test_smolagents_library_stdout_does_not_corrupt_transport(tmp_path):
    from smolagents_executor import IsolatedSmolExecutor

    data = tmp_path / "data"
    data.mkdir()
    executor = IsolatedSmolExecutor(data, "data", tmp_path / "work", ["pandas"], 5000, timeout=30)
    try:
        # pandas writes directly to sys.stdout instead of the interpreter's
        # print tool. That output must not become a malformed RPC response.
        executor("import pandas as pd\nframe = pd.DataFrame({'value': [3, 7]})\nframe.info()")
        result = executor("final_answer(int(frame.value.sum()))")
        assert result.is_final_answer and result.output == 10
    finally:
        executor.cleanup()
