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

from numeric_gate import reference_source, run_turns, diff


def test_nonfinite_reference_values_report_mismatch_without_crashing():
    for value in [float("nan"), float("inf"), float("-inf")]:
        mismatches = list(diff({"fraction": 0.5}, {"fraction": value}))
        assert len(mismatches) == 1 and mismatches[0][0] == ".fraction"
    assert list(diff(float("nan"), float("nan"))), "Non-finite output must not pass parity"


def test_reference_code_available_without_notebook_export(tmp_path):
    (tmp_path / "task.json").write_text(json.dumps([
        {"turn_id": 1, "code": "answers = {'1': {'count': 3}}"},
        {"turn_id": 2, "code": "answers['2'] = {'count': answers['1']['count'] + 1}"},
    ]))
    source = reference_source(tmp_path)
    produced, errors, _ = run_turns(source, tmp_path, 2)
    assert produced == {'1': {'count': 3}, '2': {'count': 4}}
    assert not errors


def test_notebook_preamble_preserves_its_actual_publishing_precision(tmp_path):
    header = "def print_json(value):\n    print(json.dumps({'value': round(value, 2)}))\n"
    (tmp_path / "task.ipynb").write_text(json.dumps({"cells": [
        {"cell_type": "code", "source": [header], "outputs": [{"text": ["MUST NOT EXECUTE"]}]},
        {"cell_type": "markdown", "source": ["###### Task 1: a question"]},
        {"cell_type": "code", "source": ["print_json(12345)"]},
    ]}))
    (tmp_path / "task.py").write_text("###### Task 1:\nprint_json(1.23456)")
    produced, errors, _ = run_turns(reference_source(tmp_path), tmp_path, 1)
    assert produced == {'1': {'value': 1.23}}
    assert not errors


def test_notebook_base_path_and_standard_import_aliases_are_available(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data/input.csv").write_text("amount\n7\n")
    source = "###### Task 1:\nassert CountVectorizer is not None\nassert sm is not None\nassert csr_matrix is not None\nassert NearestNeighbors is not None\nassert KFold is not None\nassert RandomForestRegressor is not None\nassert ExtraTreesRegressor is not None\nanswers = {'1': {'sum': int(pd.read_csv(BASE_PATH / 'input.csv')['amount'].sum())}}"
    produced, errors, _ = run_turns(source, tmp_path, 1)
    assert produced == {'1': {'sum': 7}}
    assert not errors


def test_reference_model_metrics_are_available(tmp_path):
    source = """###### Task 1:
answers = {'1': {'mae': mean_absolute_error([1, 3], [2, 3]),
                 'mse': mean_squared_error([1, 3], [2, 3]),
                 'r2': r2_score([1, 3], [2, 3])}}
"""
    produced, errors, _ = run_turns(source, tmp_path, 1)
    assert produced == {'1': {'mae': 0.5, 'mse': 0.5, 'r2': 0.5}}
    assert not errors
