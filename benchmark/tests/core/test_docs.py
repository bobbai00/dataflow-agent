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
"""Every harness path and bench command the benchmark READMEs name exists."""
import re

import pytest

from bobbench.paths import BENCHMARK, REPO

READMES = ["README.md", "campaign/README.md", "tracker/README.md", "tests/gate/README.md",
           "src/bobbench/longds/README.md"]
# Made by bench setup or a run, not part of the checkout's tracked files.
UNTRACKED = ("benchmark/Kramabench/", "benchmark/longds/", "benchmark/envs/kramabench/.venv",
             "benchmark/envs/scriptreact/.venv")


def header():
    return (BENCHMARK / "bench").read_text()


@pytest.mark.parametrize("readme", READMES)
def test_named_paths_exist(readme):
    text = (BENCHMARK / readme).read_text()
    for path in set(re.findall(r"(?<![\w/.])benchmark/[\w./-]*\w", text)):
        if not path.startswith(UNTRACKED):
            assert (REPO / path).exists(), f"{readme} names {path}"


@pytest.mark.parametrize("readme", READMES)
def test_relative_links_resolve(readme):
    folder = (BENCHMARK / readme).parent
    for link in re.findall(r"\]\((?!https?:)([^)#]+)\)", (BENCHMARK / readme).read_text()):
        assert (folder / link).exists(), f"{readme} links {link}"


@pytest.mark.parametrize("readme", READMES)
def test_named_bench_commands_exist(readme):
    commands = set(re.findall(r"^#   bench (\w+)", header(), re.M))
    longds = set(re.search(r"bench longds \{([\w|]+)\}", header()).group(1).split("|"))
    assert {"setup", "run", "score", "longds", "report", "compare", "recost", "audit", "test"} == commands
    text = (BENCHMARK / readme).read_text()
    for command in re.findall(r"benchmark/bench (\w+)", text):
        assert command in commands, f"{readme} runs bench {command}"
    for command in re.findall(r"bench longds (\w+)", text):
        assert command in longds, f"{readme} runs bench longds {command}"


@pytest.mark.parametrize("arm", re.findall(r"`(evidence_\w+)`", (BENCHMARK / "README.md").read_text()))
def test_the_readmes_arms_are_the_harness_arms(arm):
    from bobbench.arms import ARMS
    assert arm in ARMS


def test_the_readmes_model_tags_are_the_harness_tags():
    from bobbench.models import MODEL_TYPES
    table = (BENCHMARK / "README.md").read_text().split("| Model tag |")[1].split("\n\n")[0]
    tags = re.findall(r"`(\w+)`", table)
    assert len(tags) >= 8 and set(tags) <= set(MODEL_TYPES)
