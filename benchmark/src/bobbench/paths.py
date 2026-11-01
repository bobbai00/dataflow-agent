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
"""Where the harness, the KramaBench fork, the interpreters and the external datasets are."""
import os
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
REPO = PACKAGE.parents[2]  # benchmark/src/bobbench -> the repository
BENCHMARK = REPO / "benchmark"
# KramaBench (submodule): its evaluator package, workloads, data, format hints and judge cache.
KB = (BENCHMARK / "Kramabench").resolve()
ENVS = BENCHMARK / "envs"
# The locked interpreter Script ReAct and its model-written code run on (envs/scriptreact/setup.sh).
SCRIPTREACT_PYTHON = ENVS / "scriptreact" / ".venv" / "bin" / "python"
# The engine's interpreter (the checkout's .venv): PrepBench's result export runs on it.
ENGINE_PYTHON = Path(os.environ.get("NATIVE_ISOLATED_PYTHON") or REPO / ".venv" / "bin" / "python")
AMBER_PYTHON = REPO / "amber" / "src" / "main" / "python"
# PrepBench (TsinghuaDatabaseGroup/prepbench at 993a313): its evaluator and gold tables.
PREPBENCH_REPO = Path(os.environ.get("PREPBENCH_REPO", "~/datasets/prepbench")).expanduser()
# LongDS: the DataMind checkout (github.com/zjunlp/DataMind) holding longds/dataset (tasks, data) and the judge prompt.
DATAMIND = Path(os.environ.get("LONGDS_DATAMIND") or BENCHMARK / "longds" / "DataMind")
# The prepared LongDS sessions (bench setup longds).
LONGDS_PREPARED = Path(os.environ.get("LONGDS_PREPARED") or BENCHMARK / "longds" / "prepared")
