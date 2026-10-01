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

Choose what the request carries forward: a saved output, an earlier population, an earlier formula, or a standing baseline. Use history when the needed version is no longer visible or has changed. Task numbers, operator names and formulas below are illustrative; choose actual references from your conversation and inspections. Each JSON block is a separate model call. Wait for its observations before a dependent call; compose Answer in a later call after reading the requested result.

**1. Read an earlier result without recomputing.** Task 1 produced `regional_totals`; Task 2 changed the calculation. Task 3 asks what the original totals were. With that saved operator ID already known, read Task 1 directly:

```json
{"reasoning":"Read the original regional totals.","actions":[{"type":"retrieve","task_id":1,"operator_id":"regional_totals","view":"{{RETRIEVE_EXAMPLE_VIEW}}"}]}
```

Check the saved identity and completeness. If the requested result is unavailable, inspect its historical definition before deciding whether a fork and recomputation can reproduce it. Do not substitute the latest totals or assume an earlier answer was correct.

**2. Continue from an earlier full population.** Task 1 selected eligible items; Task 2 narrowed eligibility. Task 3 asks for a new summary of the original eligible items. If the original operator ID is unknown, find it:

```json
{"reasoning":"Find the population used in Task 1.","actions":[{"type":"inspect","target":"state","task_id":1,"operator_id":null,"include_implementation":false}]}
```

Suppose the overview identifies `eligible` and a limited display report. Inspect the population, including its input definitions:

```json
{"reasoning":"Check the original eligibility gates and inputs.","actions":[{"type":"inspect","target":"state","task_id":1,"operator_id":"eligible","include_implementation":true}]}
```

After confirming that `eligible` is the full population and `margin` is numeric, copy its historical ancestry and build the requested summary. Preserve all original gates; branch from the full population rather than the display report:

```json
{"reasoning":"Summarize the original eligible population.","actions":[{"type":"fork","task_id":1,"operator_id":"eligible","new_operator_id":"earlier_items"},{"type":"edit","changes":"create operator earlier_summary: aggregate(n=count(), avg_margin=mean(\"margin\"))\ncreate edge earlier_items.out -> earlier_summary.in"},{"type":"execute","operator_ids":["earlier_summary"]},{"type":"retrieve","operator_id":"earlier_summary","view":"{{RETRIEVE_EXAMPLE_VIEW}}"}]}
```

**3. Apply an earlier formula to current data.** Task 1 defined `score`; Task 2 changed the formula and the prepared population. Task 3 requests the original formula on `current_items`, retaining current eligibility. Inspect the old computation:

```json
{"reasoning":"Recover the original scoring expression.","actions":[{"type":"inspect","target":"state","task_id":1,"operator_id":"score","include_implementation":true}]}
```

Suppose it shows `score = 2*units + margin`, and the current input has the required numeric, nonmissing fields. Create the old computation with current edges:

```json
{"reasoning":"Apply the recovered formula to the current population.","actions":[{"type":"edit","changes":"create operator old_rule_current: map(lambda row: {**row, \"score\": 2*row[\"units\"]+row[\"margin\"]}, doc=\"Original priority formula on current items\")\ncreate edge current_items.out -> old_rule_current.in"},{"type":"execute","operator_ids":["old_rule_current"]},{"type":"retrieve","operator_id":"old_rule_current","view":"{{RETRIEVE_EXAMPLE_VIEW}}"}]}
```

Forking the entire old branch would also restore old input definitions. If the formula uses ranks, denominators or global anchors from other operators, inspect those dependencies too and decide which must be current. Copying only its last blend can omit part of the calculation.

**4. Make a temporary change and preserve the baseline.** Task 2's standing `qualified` filter requires at least 10 units; Task 3 asks for a temporary 20-unit check. Suppose its definition and inputs have already been inspected: other eligibility gates are upstream. Copy the standing branch:

```json
{"reasoning":"Preserve the standing population while preparing a temporary branch.","actions":[{"type":"fork","task_id":2,"operator_id":"qualified","new_operator_id":"trial_qualified"}]}
```

After the fork succeeds, update only its threshold. The copied upstream gates remain connected:

```json
{"reasoning":"Run the temporary threshold check.","actions":[{"type":"edit","changes":"update operator trial_qualified: filter(lambda row: row[\"units\"] is not None and row[\"units\"] >= 20, doc=\"Temporary twenty-unit threshold\")"},{"type":"execute","operator_ids":["trial_qualified"]},{"type":"retrieve","operator_id":"trial_qualified","view":"{{RETRIEVE_EXAMPLE_VIEW}}"}]}
```

If Task 4 says to continue the main analysis, use `qualified`, whose standing definition remains intact. Adopt `trial_qualified` only if the user adopts that change. A saved observation of the fork cannot answer the changed threshold; Execute must precede its Retrieve.

When a formula looks unchanged but its result differs, inspect that operator with `task_id:null` and its actual operator ID. Compare dependency hashes and input definitions across completed tasks: a changed population, parent formula or aggregation denominator can change the output without changing this operator's expression. Follow the relevant input IDs rather than fetching every task or rebuilding the analysis from prose.
