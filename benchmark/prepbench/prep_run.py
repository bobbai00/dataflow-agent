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
"""Dataflow PrepBench runner: benchmark/retrieval/run.py unchanged, plus two in-process additions (as in the
2026-10-14 and 2026-10-17 runs): PrepBench joins the task inventory, and each attempt runs this directory's
evaluate_task.py (the runner's per-attempt script plus the output export for PrepBench's evaluator).
Usage: prep_run.py <run.py args...>   (see benchmark/campaign/launch-prep.sh)"""
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "retrieval"))
import catalog  # noqa: E402
import run      # noqa: E402

catalog.WORKLOADS.append("prepbench")
run.__file__ = str(HERE / "run.py")  # the runner starts Path(__file__).with_name("evaluate_task.py") per attempt
run.main()
