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

import pandas as pd

from core.architecture.managers import Context
from core.models.internal_queue import InternalQueue
from core.runnables.data_processor import DataProcessor
from core.util.table_profile import PROFILE_PREFIX


def frame(values, enabled=True):
    result = pd.DataFrame({"x": pd.Series(values, dtype="Int64")})
    result.attrs["native_v2"] = {
        "version": 1,
        "operatorId": "op",
        "operatorRevision": "0123456789abcdef",
        "profileCollection": enabled,
    }
    return result


def published(context):
    stats = context.statistics_manager.get_statistics().result_statistics
    return [json.loads(value) for key, value in stats.items() if key.startswith(PROFILE_PREFIX)]


def test_opt_in_profile_survives_legacy_stats_replacement_and_accumulates_yields():
    context = Context("worker-a", InternalQueue())
    processor = DataProcessor(context)
    processor._publish_column_stats(frame([1, 2, None]))
    assert not published(context)[0]["coverage"]["complete"]
    second = frame([2, 3])
    second.attrs.clear()  # a later yield need not repeat the collection request
    processor._publish_column_stats(second)
    processor.finish_table_profile()
    result = published(context)[0]
    assert result["coverage"]["complete"] and result["rowCount"] == 5
    assert result["columns"]["x"]["distinctCount"] == 3
    assert result["native"] is None
    context.statistics_manager.set_result_statistics({"x": "legacy display"})
    assert published(context)[0] == result


def test_a_native_table_gets_no_display_stats_and_a_plain_table_keeps_them():
    # The agent renders a native table from its typed profile only; the display
    # strings are a full pass per column that nothing reads for it.
    a, b = Context("a", InternalQueue()), Context("b", InternalQueue())
    disabled, plain = frame([1, None], False), frame([1, None], False)
    plain.attrs.clear()
    DataProcessor(a)._publish_column_stats(disabled)
    DataProcessor(b)._publish_column_stats(plain)
    assert a.statistics_manager.get_statistics().result_statistics == {}
    assert "x" in b.statistics_manager.get_statistics().result_statistics
    assert published(a) == []
    pd.testing.assert_frame_equal(disabled, plain)


def test_worker_keys_do_not_collide_under_the_existing_map_transport():
    combined = {}
    for worker in ("a", "b"):
        context = Context(worker, InternalQueue())
        processor = DataProcessor(context)
        processor._publish_column_stats(frame([1]))
        processor.finish_table_profile()
        combined.update(context.statistics_manager.get_statistics().result_statistics)
    profiles = [json.loads(v) for k, v in combined.items() if k.startswith(PROFILE_PREFIX)]
    assert len(profiles) == 2 and {p["workerId"] for p in profiles} == {"a", "b"}


def test_profiler_failure_is_unavailable_metadata_not_a_data_execution_failure(monkeypatch):
    context = Context("a", InternalQueue())
    processor = DataProcessor(context)
    from core.util.table_profile import ProfileAccumulator

    monkeypatch.setattr(
        ProfileAccumulator, "add", lambda *args: (_ for _ in ()).throw(RuntimeError("private input value"))
    )
    processor._publish_column_stats(frame([1, 2]))
    processor.finish_table_profile()
    result = published(context)[0]
    assert result["status"] == "unavailable" and not result["coverage"]["complete"]
    assert "private input value" not in json.dumps(result)
    assert all(
        key.startswith(PROFILE_PREFIX)
        for key in context.statistics_manager.get_statistics().result_statistics
    )


def test_optional_collector_unavailable_does_not_break_data_or_disabled_path(monkeypatch):
    import builtins

    original = builtins.__import__
    attempts = []

    def missing(name, *args, **kwargs):
        if name == "core.util.table_profile":
            attempts.append(name)
            raise ImportError("unavailable collector")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing)
    context = Context("a", InternalQueue())
    processor = DataProcessor(context)
    processor._publish_column_stats(frame([1], False))
    assert attempts == []
    processor._publish_column_stats(frame([2], True))
    assert len(attempts) == 1
    # No collector, so no profile; a native table has no display stats either.
    assert context.statistics_manager.get_statistics().result_statistics == {}
