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

### Generic multitask examples

**Recover an earlier baseline.** An eligible population was narrowed after Task 1. Read the original definition and sample/statistics together, without inspecting a whole task:

```json
{"reasoning":"Check the original population and saved evidence.","actions":[{"type":"inspect","target":"state","task_id":1,"operator_id":"eligible","include_implementation":false,"view":"{{RETRIEVE_EXAMPLE_VIEW}}"}]}
```

If that saved view answers the question, answer next. If new computation is needed, fork after seeing the inspection:

```json
{"reasoning":"Summarize the original population while preserving today's branch.","actions":[{"type":"fork","task_id":1,"operator_id":"eligible","new_operator_id":"earlier_items"},{"type":"edit","changes":"create operator earlier_summary: aggregate(n=count())\ncreate edge earlier_items.out -> earlier_summary.in"},{"type":"execute","operator_ids":["earlier_summary"]},{"type":"retrieve","operator_id":"earlier_summary","view":"{{RETRIEVE_EXAMPLE_VIEW}}"}]}
```

**Apply an old formula to current data.** Task 1 used a score of 2*units+margin; a later task changed both the formula and population. Read the old implementation first:

```json
{"reasoning":"Recover the earlier score formula and its input binding.","actions":[{"type":"inspect","target":"state","task_id":1,"operator_id":"score","include_implementation":true,"view":null}]}
```

After confirming the formula, fork it and change only the fork's input to current_items:

```json
{"reasoning":"Use the old score on current items.","actions":[{"type":"fork","task_id":1,"operator_id":"score","new_operator_id":"old_rule_current"},{"type":"edit","changes":"delete edge old_rule_current__eligible.out -> old_rule_current.in\ncreate edge current_items.out -> old_rule_current.in"},{"type":"execute","operator_ids":["old_rule_current"]},{"type":"retrieve","operator_id":"old_rule_current","view":"{{RETRIEVE_EXAMPLE_VIEW}}"}]}
```

**Check upstream changes.** The score expression can stay unchanged while eligibility changes. List version changes for both operators in one call; then choose the needed task and read only its relevant saved view:

```json
{"reasoning":"Locate changes in the score and its population.","actions":[{"type":"inspect","target":"state","task_id":null,"operator_id":["score","eligible"],"include_implementation":false,"view":null}]}
```

**Keep a trial separate.** A request to test a stricter threshold changes a trial branch. Fork the standing definition, modify that fork, and execute its target. Preserve the standing branch so the next request can resume it without reconstructing its earlier rule. Reuse available evidence; an inspection is useful only when the standing version is uncertain.
