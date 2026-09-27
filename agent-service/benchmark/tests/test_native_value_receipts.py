# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""What a custom step did to the values it kept, measured by the runtime:
the engine cannot read the function, and its silent rewrites decided turns
(an alias map sent 'Rsa' to Russia, a dict without 'District Of Columbia'
turned DC into null and out of a ranking). Also labels that differ only in
case or spacing ('Telecommunications ' counted apart)."""
import pandas as pd

from test_native_v2_relational import execute


def operations(frame):
    return frame.attrs["native_v2"]["operations"]


def process(code, *frames):
    return execute("Process", *frames, code=code, entry="process")


PEOPLE = pd.DataFrame({
    "country": ["Norway", "Rsa", "South Africa", "Norway", "Rsa", "Kenya"],
    "state": ["Texas", "Ohio", "District Of Columbia", "Texas", "Ohio", "Texas"],
    "score": [1, 2, 3, 4, 5, 6],
})


def test_an_alias_map_is_receipted_as_rewrites():
    code = "def process(t):\n    return t.assign(country=t['country'].replace({'Rsa': 'Russia'}))"
    out = process(code, PEOPLE)
    receipt = operations(out)["valueReceipts"]["country"]
    assert receipt["rewritten"] == [["Rsa", "Russia", 2]]
    assert receipt["rewrittenRows"] == 2 and receipt["rewrittenValues"] == 1
    assert "state" not in operations(out)["valueReceipts"]  # untouched columns say nothing


def test_a_mapping_that_lacks_a_key_is_receipted_as_nulls():
    code = (
        "def process(t):\n"
        "    return t.assign(state=t['state'].map({'Texas': 'TX', 'Ohio': 'OH'}))"
    )
    receipt = operations(process(code, PEOPLE))["valueReceipts"]["state"]
    assert receipt["nulled"] == [["District Of Columbia", 1]] and receipt["nulledRows"] == 1


def test_rows_a_step_drops_are_counted_by_value():
    code = "def process(t):\n    return t[t['country'] != 'Rsa']"
    receipt = operations(process(code, PEOPLE))["valueReceipts"]["country"]
    assert receipt["droppedByValue"] == [["Rsa", 2]]
    assert "rewritten" not in receipt


def test_a_whole_column_recode_is_a_rewrite():
    upper = "def process(t):\n    return t.assign(country=t['country'].str.upper())"
    receipt = operations(process(upper, PEOPLE))["valueReceipts"]["country"]
    assert receipt["rewrittenValues"] == 4 and receipt["rewrittenRows"] == 6


def test_no_claim_when_rows_cannot_be_matched():
    fresh = "def process(t):\n    return t.groupby('country', as_index=False)['score'].sum()"
    assert "valueReceipts" not in operations(process(fresh, PEOPLE))
    # Rebuilt in another order and renumbered: matching by position would pair
    # unrelated rows, so the receipt says nothing about the column.
    shuffled = "def process(t):\n    return t.sample(frac=1, random_state=3).reset_index(drop=True)"
    assert "country" not in operations(process(shuffled, PEOPLE)).get("valueReceipts", {})


def test_spellings_that_differ_only_in_case_or_spacing():
    industries = pd.DataFrame({
        "industry": ["Telecommunications"] * 3 + ["Telecommunications ", "Internet", "internet", "Higher Education"],
        "n": range(7),
    })
    grouped = execute("Aggregate", industries, groupBy=["industry"], aggregations=[{"fn": "count", "as": "rows"}])
    variants = operations(grouped)["spellingVariants"]["industry"]
    assert variants == [[["Telecommunications", 1], ["Telecommunications ", 1]], [["Internet", 1], ["internet", 1]]]
    # A custom step reports them in the columns it produced.
    code = "def process(t):\n    return t.assign(label=t['industry'])"
    assert operations(process(code, industries))["spellingVariants"]["label"][0][0][0] == "Telecommunications"
