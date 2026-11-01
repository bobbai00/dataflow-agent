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
"""Shared test fixtures: where the recorded fixtures are, and markers for what a test needs.

- tests/core: stdlib and the harness only; both interpreters.
- tests/kb: KramaBench's evaluator package and data (the KramaBench venv, benchmark/Kramabench on PYTHONPATH).
- tests/longds, tests/sandbox: the root .venv (smolagents, bubblewrap).
"""
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent / "fixtures"
