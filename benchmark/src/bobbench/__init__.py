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
"""bobbench: the benchmark harness of BobFlow (the dataflow agent) and its Script ReAct baseline.

KramaBench and PrepBench runs (`kramabench`, `prepbench`), LongDS sessions (`longds`), and what they share: the agent
client, model prices, arms, the run loop, cost reconciliation, audits and the bubblewrap sandbox. `benchmark/bench` is
the command line; it picks the interpreter and PYTHONPATH each command needs.
"""
