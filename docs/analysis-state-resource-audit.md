<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements. See the NOTICE file
distributed with this work for additional information
regarding copyright ownership. The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License. You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied. See the License for the
specific language governing permissions and limitations
under the License.
-->

**The shutdown source was the host's memory watchdog.** The system journal
records `earlyoom.service` sending SIGTERM during all three coordinated
interruptions on 2026-09-24. At 16:43:27.799 UTC it targeted PID 1669323, the
evaluation controller; the controller's wrapper then stopped its engine and
agent. No other tenant is implicated by this evidence.

The watchdog acts when available RAM is at most 8% and free swap at most 15%.
Its configured preference for Python explains why it selected even small
controllers. Earlier events also terminated Bun processes with 9,321 and
11,509 MiB RSS. These are deployment resource failures, even though they did
not appear in the kernel OOM log. The [machine-readable audit](analysis-state-resource-audit.json)
preserves 102 journal messages, process identities and configuration.

With the user's authorization, idle agent state was archived and the unused
`texera-evcomp` stack and agents on ports 3071 and 3072 were stopped through
`bin/local-dev.sh`. Docker volumes were retained. The main backend services
needed by the experiment were kept running. The watchdog remains enabled.

The remaining fourteen recovery sessions resumed from a separate, verified
frozen R3 checkout. Both engine preflights passed. The dedicated system service
`texera-analysis-dedicated.service` applies these controls:

| Control | Value |
| --- | --- |
| Experiment memory limit | 20 GiB |
| Concurrent native sessions | 3 per wave |
| Admission requirement | At least 10 GiB available RAM and 8 GiB free swap |
| Between waves | Restart the idle agent with its normal Python interpreter, then pass the engine isolation preflight |
| Session wall budget | Unchanged: 1 hour |
| Outer service lifetime | 6 hours |
| Memory sampling | Every 15 seconds |

The cgroup contains the experiment engine, agent, controllers and their
children; shared backend services are separate. Its cap limits consumption,
rather than reserving physical RAM. Resource observations and the archived
supervisor scripts are linked from the machine-readable audit. Current progress
is recorded in [campaign status](analysis-state-campaign-status.json).

The first idle restart exposed a controller configuration error: the engine-only
Python wrapper was assigned to the agent parser. Three sessions never executed
any operators, despite generic `ok` observations. They were stopped, archived
and excluded as setup failures, including the completed Los Angeles attempt.
The [dispatch audit](analysis-state-dispatch-audit.json) records the reproduced
error, preserved usage, and real results in the first tool-bearing turn of all 25 previously
completed native sessions. The controller now sets the agent interpreter
explicitly and checks isolation after every restart. Both initial preflights
passed again, and the remaining eleven sessions resumed with real operators.
The current worktree additionally fixes the driver to preserve thrown tool
exceptions; the evaluation continues to use the unchanged frozen R3 code.

All 31 unexpectedly interrupted attempts remain archived with captured spending.
The earlier isolated Python interruption has no separately matched signal
event. Under the recorded exclusion policy, these attempts are excluded from
completed-session accuracy, which is therefore conditional on surviving the
deployment resource limits. The new waves reduce contention relative to the
earlier six-native/three-Python schedule; recovery latency and cost must not be
described as measurements under identical resource conditions. The completed
first pass and its negative accuracy/cost decision remain unchanged.
