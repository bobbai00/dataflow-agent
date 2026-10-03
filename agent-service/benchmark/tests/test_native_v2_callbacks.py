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

"""pandas and numpy are bound inside callbacks."""

import json

import pandas as pd

from test_native_v2_runtime import runtime, spec


def rows(frame):
    return json.loads(frame.to_json(orient="records", date_format="iso"))


def test_pandas_and_numpy_are_bound_inside_callbacks():
    frame = pd.DataFrame({"x": [1.0, None, 3.0]})
    mapped = runtime.execute_native(
        {**spec("Map", func="def apply(row):\n    return {**row, 'ok': bool(pd.isna(row['x'])) , 'r': float(np.round(row['x'] or 0, 1))}", entry="apply", doc="flags"), "inputs": ["t"]},
        [frame],
    )
    assert rows(mapped) == [{"x": 1.0, "ok": False, "r": 1.0}, {"x": None, "ok": True, "r": 0.0}, {"x": 3.0, "ok": False, "r": 3.0}]
    processed = runtime.execute_native(
        {**spec("Process", code="def process(df):\n    return pd.DataFrame({'n': [int(np.nansum(df['x']))]})", entry="process", doc="sum"), "inputs": ["t"]},
        [frame],
    )
    assert rows(processed) == [{"n": 4}]
