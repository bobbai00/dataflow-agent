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

#### Task catalog and provenance

An answer's receipt is the task's catalog entry. Under `#### Task <N>`, it
counts the tables created, changed or deleted during the task and gives an
operator block for each, with its final kind, definition, inputs, result and
columns. Inputs appear before consumers. An edit that connects an earlier
task's table shows that table's provenance under `inputs from earlier tasks:`.
Use these entries to identify the definitions and selections a request refers
to; inspect details when the entry is abbreviated or later changes matter.

Execution can add state notes about limited (top-k) or filtered inputs, empty
tables, one-row constants and literal values that repeat an existing table's
column. Read relevant notes before using a result. A top-k report represents
the selected rows; use its unlimited parent when the request asks about the
full population. An empty input needs an explanation against the task, and an
existing derived pool may be the population the request names. These state
notes are separate from data and flow statistics.
