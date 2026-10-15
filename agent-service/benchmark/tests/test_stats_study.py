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

"""Study build (study/stats-overhead): the runtime-checks switch, per-check records and lifted caps."""

import importlib.util
from pathlib import Path

import pandas as pd


RUNTIME = Path(__file__).resolve().parents[2] / "src/agent/native/python/runtime.py"


def load():
    module_spec = importlib.util.spec_from_file_location("native_v2_stats_study", RUNTIME)
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    records = []
    module._study_write = records.append
    return module, records


def spec(kind, inputs=("source",), **properties):
    return {"id": "candidate", "revision": "r-test", "version": "v2", "type": kind, "inputs": list(inputs),
            "properties": properties}


DEDUPE = '''
def process(frame):
    return frame.drop_duplicates(subset=["id"], keep="first").merge(frame[["id"]].drop_duplicates(), on="id")
'''
FRAME = pd.DataFrame({"id": ["a", "a", "b"], "name": ["THE CROWN", "HANGMAN", "X"], "elev": [1, 2, 3]})


def test_without_a_tag_nothing_is_recorded_and_checks_follow_collection():
    runtime, records = load()
    result = runtime.execute_native({**spec("Process", code=DEDUPE, entry="process"), "profileCollection": True}, [FRAME])
    assert result.attrs["native_v2"]["operations"]["process"]["events"][0]["issue"] == "differs"
    assert records == [] and "studyTag" not in result.attrs["native_v2"]


def test_checks_off_runs_no_check_and_installs_no_hooks():
    runtime, records = load()
    off = {**spec("Process", code=DEDUPE, entry="process"), "profileCollection": True, "runtimeChecks": False,
           "studyTag": "t-off"}
    result = runtime.execute_native(off, [FRAME])
    assert "process" not in result.attrs["native_v2"]["operations"]
    assert "repeatedValues" not in result.attrs["native_v2"]["operations"]
    record = records[-1]
    assert (record["tag"], record["phase"], record["checks"], record["profileCollection"]) == ("t-off", "operator", False, True)
    assert record["phases"] == {} and record["hookCalls"] == {}
    # The table profile still runs: the tag reaches the worker's profile metadata.
    assert result.attrs["native_v2"]["studyTag"] == "t-off"
    filtered = runtime.execute_native(
        {**spec("Filter", func="def apply(row):\n    return row['name'] == 'HANGMEN'\n"), "runtimeChecks": False,
         "studyTag": "t-off"}, [FRAME])
    assert "filterNoMatch" not in filtered.attrs["native_v2"]["operations"]
    keys = runtime.execute_native(
        {**spec("Aggregate", groupBy=["id"], aggregations=[{"fn": "count", "col": "elev", "as": "n"}]),
         "runtimeChecks": False, "studyTag": "t-off"}, [FRAME])
    assert "keyDependencies" not in keys.attrs["native_v2"]["operations"]


def test_checks_on_without_collection_times_each_check_and_lifts_the_caps():
    runtime, records = load()
    on = {**spec("Process", code=DEDUPE, entry="process"), "runtimeChecks": True, "studyTag": "t-on"}
    result = runtime.execute_native(on, [FRAME])
    assert result.attrs["native_v2"]["operations"]["process"]["events"][0]["issue"] == "differs"
    assert "profileCollection" not in result.attrs["native_v2"]
    record = records[-1]
    assert record["checks"] is True and record["profileCollection"] is False
    assert {"hook:drop_duplicates", "hook:merge", "processFinish", "repeatedValues"} <= set(record["phases"])
    assert record["phases"]["hook:drop_duplicates"]["calls"] == 2
    assert record["totalMs"] >= record["checksMs"] >= 0 and record["outputRows"] == 2
    assert runtime._CHECK_ROW_LIMIT == 10**15 and runtime._NEAR_LIMIT == 10**15
    # Where stable's cap would have stopped a check, the record says so.
    runtime._STUDY.update(on=True, caps=[])
    assert runtime._over(3_000_000, "_CHECK_ROW_LIMIT") is False and runtime._STUDY["caps"] == ["_CHECK_ROW_LIMIT"]
