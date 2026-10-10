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
"""Regression coverage for receipt timestamps and measured wall boundaries."""

from datetime import datetime, timezone
import json
import sys

import pytest

from benchmark.dsbench.accounting import capture_model_accounting
from benchmark.runtime import AttemptMetrics, run_supervised
from benchmark.runtime import metrics as runtime_metrics
from benchmark.runtime.native_accounting import finish_native_metrics


BOUNDARY = "supervisor timer start before measurement setup through child-tree exit and resource finalization"


def test_live_receipt_labels_construction_separately_from_observed_lifecycle(monkeypatch):
    values = iter([datetime(2026, 1, 1, tzinfo=timezone.utc), datetime(2026, 1, 1, 0, 0, 3, tzinfo=timezone.utc)])
    class Clock:
        @staticmethod
        def now(zone):
            return next(values)
    monotonic = iter([100.0, 102.5])
    monkeypatch.setattr(runtime_metrics, "datetime", Clock)
    monkeypatch.setattr(runtime_metrics.time, "monotonic", lambda: next(monotonic))
    attempt = AttemptMetrics("fixture", benchmark="fixture", system="native", task_id="fixture")
    result = attempt.finish()
    assert result["clocks"]["wall_seconds"] == 2.5
    assert result["receipt"] == {
        "constructed_at": result["started_at"],
        "finalized_at": result["finished_at"],
        "legacy_timestamp_fields": "started_at and finished_at describe receipt construction through finalization",
    }
    assert result["clocks"]["measured_interval"] == {
        "source": "AttemptMetrics.monotonic",
        "boundary": "metrics construction through finish",
        "started_at": result["started_at"],
        "finished_at": result["finished_at"],
        "utc_status": "observed",
    }
    assert attempt.finish() is result


def _replay_fixture(directory, supervised_interval=None):
    config = {"task_id": "fixture", "model": "fixture"}
    accounting = {"version": 1, "source": "transport", "requests": [], "usageStatus": "complete"}
    values = {"config.json": config, "model-accounting.json": accounting,
              "status.json": {"completed": True, "runner_seconds": 46.77774950605817},
              "lifecycle.json": {"solve_seconds": 45.0},
              "started.json": {"started_at": "2030-01-01T00:00:00+00:00"}}
    if supervised_interval is not None:
        values["supervision.json"] = {"wall_seconds": 46.77774950605817, "wall_interval": supervised_interval}
    for name, value in values.items():
        (directory / name).write_text(json.dumps(value))


def test_historical_replay_does_not_infer_utc_from_receipt_or_wrapper_timestamp(tmp_path):
    _replay_fixture(tmp_path)
    result = capture_model_accounting(tmp_path, system="native", benchmark="fixture", resources={})
    assert result["clocks"]["wall_seconds"] == 46.77774950605817
    assert result["clocks"]["phases"] == {"solve_seconds": 45.0}
    assert result["clocks"]["measured_interval"] == {
        "source": "status.json.runner_seconds (preserved supervised wall)",
        "boundary": BOUNDARY,
        "started_at": None,
        "finished_at": None,
        "utc_status": "not_recorded",
    }
    assert result["receipt"]["constructed_at"] == result["started_at"]
    assert result["receipt"]["finalized_at"] == result["finished_at"]
    assert result["model_calls"] == {"attempted": 0, "succeeded": 0, "failed": 0}
    assert result["cost"]["cost_usd"] == 0
    assert json.loads((tmp_path / "accounting/metrics.json").read_text()) == result


def test_replay_uses_preserved_supervisor_utc_boundaries_without_changing_duration(tmp_path):
    interval = {"source": "supervision.json.wall_seconds", "boundary": BOUNDARY,
                "started_at": "2026-01-01T00:00:00+00:00",
                "finished_at": "2026-01-01T00:00:47+00:00", "utc_status": "observed"}
    _replay_fixture(tmp_path, interval)
    result = capture_model_accounting(tmp_path, system="native", benchmark="fixture", resources={})
    assert result["clocks"]["measured_interval"] == interval
    assert result["clocks"]["wall_seconds"] == 46.77774950605817
    assert result["clocks"]["phases"] == {"solve_seconds": 45.0}
    assert result["receipt"]["constructed_at"] != interval["started_at"]


def test_legacy_adapter_retains_its_explicit_grading_boundary(tmp_path):
    interval = {"source": "supervision.json.wall_seconds", "boundary": BOUNDARY,
                "started_at": "2026-01-01T00:00:00+00:00",
                "finished_at": "2026-01-01T00:00:47+00:00", "utc_status": "observed"}
    _replay_fixture(tmp_path, interval)
    boundary = "legacy adapter launch through exit; includes official grading"
    result = capture_model_accounting(tmp_path, system="native", benchmark="fixture", resources={}, wall_boundary=boundary)
    assert result["clocks"]["boundary"] == boundary
    assert result["clocks"]["measured_interval"]["boundary"] == boundary
    assert result["clocks"]["measured_interval"]["started_at"] == interval["started_at"]


def test_external_wall_interval_requires_paired_utc_and_explicit_provenance():
    attempt = AttemptMetrics("fixture", benchmark="fixture", system="native", task_id="fixture")
    with pytest.raises(ValueError, match="paired UTC"):
        attempt.finish(wall_interval={"wall_seconds": 2.5, "source": "fixture", "boundary": "fixture", "started_at": "2026-01-01T00:00:00+00:00"})
    with pytest.raises(ValueError, match="source and boundary"):
        attempt.finish(wall_interval={"wall_seconds": 2.5})
    with pytest.raises(ValueError, match="UTC timestamp"):
        attempt.finish(wall_interval={"wall_seconds": 2.5, "source": "fixture", "boundary": "fixture",
                                      "started_at": "2026-01-01T00:00:00", "finished_at": "2026-01-01T00:00:03"})


def test_native_adapter_propagates_external_wall_interval_without_changing_accounting():
    attempt = AttemptMetrics("fixture", benchmark="fixture", system="native", task_id="fixture")
    interval = {"wall_seconds": 46.77774950605817, "source": "fixture.monotonic", "boundary": "fixture"}
    result = finish_native_metrics(attempt, {"version": 1, "source": "transport", "requests": []}, wall_interval=interval)
    assert result["clocks"]["wall_seconds"] == interval["wall_seconds"]
    assert result["clocks"]["measured_interval"]["started_at"] is None
    assert result["clocks"]["measured_interval"]["utc_status"] == "not_recorded"
    assert result["model_calls"] == {"attempted": 0, "succeeded": 0, "failed": 0}
    assert result["cost"]["cost_usd"] == 0
    assert "wall_seconds" in interval  # The caller's interval remains immutable.


@pytest.mark.skipif(sys.platform != "linux", reason="Linux process supervision")
@pytest.mark.parametrize("command,expected_status", [([sys.executable, "-c", "print('fixture')"], "completed"), (["/nonexistent/timestamp-fixture-command"], "error")])
def test_supervisor_records_utc_at_existing_monotonic_boundaries(command, expected_status):
    result = run_supervised(command, 5)
    assert result.status == expected_status
    interval = result.wall_interval
    assert interval["source"] == "supervision.json.wall_seconds"
    assert interval["utc_status"] == "observed"
    start = datetime.fromisoformat(interval["started_at"])
    finish = datetime.fromisoformat(interval["finished_at"])
    assert abs((finish - start).total_seconds() - result.wall_seconds) < 0.1
    assert start.utcoffset().total_seconds() == 0
    assert result.as_dict()["wall_interval"] == interval
    if expected_status == "completed":
        assert interval["boundary"] == BOUNDARY
    else:
        assert interval["boundary"] == "supervisor timer start before measurement setup through error cleanup, before final resource capture"
