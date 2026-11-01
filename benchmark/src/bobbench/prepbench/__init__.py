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
"""PrepBench (clarified mode) as a KramaBench workload: `prepbench`, one task `prepbench-hard-<n>` per case.

The workload, data and BobFlow's format hints live in the KramaBench fork (built by build_workload.py); this package
holds the case index and Script ReAct's format hints. An agent builds the output tables; PrepBench's own evaluator scores
them offline (score.py)."""
