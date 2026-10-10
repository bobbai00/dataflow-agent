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

#### Start from an earlier task

Use `resumeFrom(turn)` when the request should build on the graph at the end
of a particular earlier task. This changes the graph used as the starting
point for the current task. Choose the task whose state the request means,
including an earlier version when the request refers to an original rule.
Call it before creating or editing any operator; the starting point becomes
locked once you build. Earlier tasks remain available for later navigation.
