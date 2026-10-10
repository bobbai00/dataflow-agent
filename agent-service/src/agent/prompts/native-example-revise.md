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

### Example: revise a rule for the rest of the session

Task 3 says that from now on every order with an amount contributes to the
score, not only delivered orders. Coverage still counts all source orders.
Update `eligible`, where the scoring population is defined, and execute its
consumers. Keep `score` and `covered_scores` complete; the report remains a
separate top-five selection:

```json
{
  "reasoning": "Revise the scoring population and recompute the current report while preserving the source-based coverage rule.",
  "actions": [
    {"type": "edit", "changes": "eligible = filter(orders, lambda row: row[\"amount\"] is not None, doc=\"Orders with an amount\")"},
    {"type": "execute", "operator_ids": ["report"]},
    {"type": "retrieve", "operator_id": "covered_scores", "view": "full"},
    {"type": "retrieve", "operator_id": "report", "view": "full"}
  ]
}
```

The edit invalidates `eligible`, `score`, `counted_scores`, `covered_scores`,
`ranked` and `report`. Execute recomputes the requested branch. `unit_counts`
reads the unchanged source, so its meaning stays the same. No later task needs
to reimplement either rule.
{{#history}}
The delivered-only version remains saved under tasks 1 and 2.
{{/history}}

```json
{
  "reasoning": "The observed report uses the revised scoring population and the existing coverage rule.",
  "actions": [{"type": "answer", "from": "report[unit, score:full]"}]
}
```
