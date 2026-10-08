# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Model selection and frozen pricing must reach both DSBench workers."""

from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

from benchmark.dsbench import run as runner

LUNA = "gpt-5.6-luna"
TERRA = "gpt-5.6-terra"
SOL = "gpt-5.6-sol"


def schedule(model, multiplier=1):
    return {
        "version": 1,
        "kind": "token_estimate",
        "model": model,
        "source": {"table": "offline-test-only"},
        "currency": "USD",
        "unit": "per_token",
        "rates": {
            "input": 2e-7 * multiplier,
            "output": 1.2e-6 * multiplier,
            "cache_read": 2e-8 * multiplier,
            "cache_creation": 2.5e-7 * multiplier,
        },
        "input_includes_cached": True,
        "output_includes_reasoning": True,
    }


@pytest.fixture
def environment(tmp_path, monkeypatch):
    task = {
        "task_id": "00000001-question1",
        "introduction": "Background",
        "question": "Sum x.",
        "input_path": str(tmp_path / "inputs"),
        "allowed_files": ["introduction.txt", "question1.txt", "data.csv"],
        "files": [],
    }
    principles = tmp_path / "principles.txt"
    principles.write_text("## Analysis principles\nUse the available evidence.\n")
    prices = {LUNA: schedule(LUNA), TERRA: schedule(TERRA, 10)}
    real_cost = runner.cost_module().compute_cost
    price_queries, cost_queries, workers = [], [], []

    def price_schedule(model):
        price_queries.append(model)
        return deepcopy(prices.get(model))

    def compute_cost(model, **kwargs):
        cost_queries.append((model, deepcopy(kwargs)))
        return real_cost(model, **kwargs)

    class Worker:
        returncode = 0

        def __init__(self, command, **kwargs):
            config = json.loads(Path(command[-1]).read_text())
            workers.append(config)
            directory = Path(config["output_dir"])
            (directory / "stats.json").write_text(
                json.dumps(
                    {
                        "input_tokens": 1000,
                        "output_tokens": 100,
                        "cached_tokens": 200,
                        "cache_creation_tokens": 0,
                    }
                )
            )
            (directory / "response.txt").write_text("3")
            (directory / "status.json").write_text(json.dumps({"completed": True}))

        def wait(self, **kwargs):
            return 0

    monkeypatch.setattr(runner, "load_tasks", lambda root, ids: ({}, [task]))
    monkeypatch.setattr(runner, "verify_native_inputs", lambda task: None)

    def supervise(command, **kwargs):
        worker = Worker(command)
        return SimpleNamespace(
            returncode=worker.returncode,
            timed_out=False,
            wall_seconds=0.1,
            resources={},
            as_dict=lambda: {"returncode": 0, "wall_seconds": 0.1, "resources": {}},
        )

    monkeypatch.setattr(runner, "run_supervised", supervise)
    monkeypatch.setattr(
        runner, "cost_module", lambda: SimpleNamespace(price_schedule=price_schedule, compute_cost=compute_cost)
    )

    def invoke(*options, arm="data0_flow0"):
        command = [
            "run.py",
            "--arm",
            arm,
            "--task-ids",
            task["task_id"],
            "--prepared-root",
            str(tmp_path / "prepared"),
            "--output-root",
            str(tmp_path / "runs"),
            "--shared-principles",
            str(principles),
            *options,
        ]
        monkeypatch.setattr(sys, "argv", command)
        runner.main()

    return SimpleNamespace(
        root=tmp_path,
        task=task,
        prices=prices,
        price_queries=price_queries,
        cost_queries=cost_queries,
        workers=workers,
        invoke=invoke,
    )


@pytest.mark.parametrize("arm", ["data0_flow0", "smol_custom"])
def test_terra_selection_changes_worker_model_and_uses_terra_prices(environment, arm):
    environment.invoke("--model", TERRA, arm=arm)
    config = environment.workers[0]
    assert config["model"] == TERRA
    assert environment.price_queries == [TERRA]
    assert environment.cost_queries[0][0] == TERRA
    assert config["pricing"] == schedule(TERRA, 10)
    assert config["reasoning_effort"] == "medium"
    assert config["prompt"] == runner.build_prompt(environment.task, arm)
    assert config["settings"] == (
        runner.SMOL_SETTINGS if arm == "smol_custom" else {**runner.NATIVE_SETTINGS, **runner.ARMS[arm]}
    )
    stats = json.loads((Path(config["output_dir"]) / "stats.json").read_text())
    assert stats["pricing"]["model"] == TERRA
    assert stats["cost_usd"] == pytest.approx(0.00284)


def test_omitting_model_keeps_the_existing_luna_default(environment):
    environment.invoke()
    assert environment.workers[0]["model"] == LUNA
    assert environment.price_queries == [LUNA]
    assert environment.cost_queries[0][0] == LUNA


@pytest.mark.parametrize("arm", ["data1_flow1", "smol_custom"])
def test_future_common_model_request_timeout_is_frozen_in_both_worker_configs(environment, arm):
    environment.invoke(arm=arm)
    assert environment.workers[0]["model_request_timeout_seconds"] == 240


@pytest.mark.parametrize("arm", ["data1_flow1", "smol_custom"])
def test_explicit_common_request_timeout_cli_preserves_model_and_prompt(environment, arm):
    environment.invoke("--model-request-timeout-seconds", "125", arm=arm)
    config = environment.workers[0]
    assert config["model_request_timeout_seconds"] == 125
    assert config["model"] == LUNA
    assert config["prompt"] == runner.build_prompt(environment.task, arm)


@pytest.mark.parametrize("arm", ["data1_flow1", "smol_custom"])
def test_explicit_sol_schedule_is_frozen_and_used_without_price_lookup(environment, arm):
    price_file = environment.root / "sol-pricing.json"
    price_file.write_text(json.dumps(schedule(SOL, 20)))
    environment.invoke("--model", SOL, "--pricing-json", str(price_file), arm=arm)
    config = environment.workers[0]
    assert config["model"] == SOL
    assert config["pricing"] == schedule(SOL, 20)
    assert environment.price_queries == []
    assert environment.cost_queries[0][0] == SOL
    assert environment.cost_queries[0][1]["pricing"] == schedule(SOL, 20)
    stats = json.loads((Path(config["output_dir"]) / "stats.json").read_text())
    assert stats["cost_usd"] == pytest.approx(0.00568)


def test_unknown_unpriced_model_fails_before_starting_any_worker(environment):
    with pytest.raises(RuntimeError, match="price schedule"):
        environment.invoke("--model", SOL)
    assert environment.workers == []


@pytest.mark.parametrize("mutation", ["model", "unit", "missing_rate", "negative", "nan", "infinite", "bool"])
def test_invalid_explicit_price_schedule_fails_before_workers(environment, mutation):
    pricing = schedule(SOL)
    if mutation == "model":
        pricing["model"] = LUNA
    elif mutation == "unit":
        pricing["unit"] = "per_million_tokens"
    elif mutation == "missing_rate":
        del pricing["rates"]["cache_read"]
    else:
        pricing["rates"]["input"] = {"negative": -1, "nan": float("nan"), "infinite": float("inf"), "bool": True}[
            mutation
        ]
    price_file = environment.root / "invalid-pricing.json"
    price_file.write_text(json.dumps(pricing))
    with pytest.raises(ValueError, match="pricing|rate"):
        environment.invoke("--model", SOL, "--pricing-json", str(price_file))
    assert environment.workers == []


def test_dry_run_records_the_selected_model_and_matching_price_without_workers(environment, capsys):
    environment.invoke("--model", TERRA, "--dry-run")
    protocol = json.loads(capsys.readouterr().out)
    assert protocol["model"] == TERRA
    assert protocol["pricing"] == schedule(TERRA, 10)
    assert protocol["settings"] == {**runner.NATIVE_SETTINGS, **runner.ARMS["data0_flow0"]}
    assert environment.workers == []
