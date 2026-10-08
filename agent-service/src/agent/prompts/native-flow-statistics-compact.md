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

### Flow statistics

Flow evidence is attached automatically within a separate {{FLOW_BUDGET}}-
character budget. It reports source parsing/selection, cast failures,
filter retention, join matches/duplication, grouping or other available
operation diagnostics. Use these counts to investigate unexpected changes
in the population or grain. Intended selections and unmatched rows can be
correct for the request; absent diagnostics are unknown, not zero.
