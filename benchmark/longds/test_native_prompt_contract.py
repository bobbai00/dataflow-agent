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

import importlib


def runner(monkeypatch):
    # The legacy runner changes cwd for its Python SUT; these are pure prompt tests.
    monkeypatch.setattr("os.chdir", lambda _: None)
    return importlib.import_module("run_longds")


def test_native_wrapper_matches_explicit_actions(monkeypatch):
    run = runner(monkeypatch)
    turn = {"context": "Keep the first reviewed subset.", "question": "Count?"}
    prompt = run.build_turn_1_prompt({"files": ["data/orders.csv"]}, turn, agent_mode="native")
    assert "answer.content" in prompt
    assert "sole action" in prompt
    assert "Final Answer:" not in prompt
    assert "explicitly execute" in prompt
    assert "Retrieval never executes" in prompt
    assert "recomputes whatever depends" not in prompt
    assert turn["context"] in prompt and turn["question"] in prompt
    followup = run.build_turn_n_prompt(turn, agent_mode="native")
    assert "answer.content" in followup and "Final Answer:" not in followup


def test_legacy_code_wrapper_retains_its_protocol(monkeypatch):
    run = runner(monkeypatch)
    turn = {"context": "Context", "question": "Count?"}
    prompt = run.build_turn_1_prompt({"files": ["data/orders.csv"]}, turn, agent_mode="code")
    assert "Final Answer:" in prompt
    assert "answer.content" not in prompt
    assert "recomputes whatever depends" in prompt
