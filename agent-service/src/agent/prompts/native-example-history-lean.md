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

### Example: change a rule in place, compute an alternative, use an earlier version

Keep each rule in one shared function whose numbers are settings, and cut
reports with `limit(table, n, by=[...])`. When a request changes the rule
from here on, change it in place: restate the call with the new setting
(`scores = unit_scores(orders, delivered_only=True)`) or redefine the `def`.
Everything built on it recomputes on the next execute, and the execute
receipt compares each recomputed table with the version the last task saved
(`changed since top3@1: 3 → 3 rows; entered (1): south; left (1): east`).
For an alternative that applies to one question, compute it alongside under a
new name, `half = unit_scores(orders, refund_weight=0.5)`, and leave the main
tables as they are.

An earlier version is one reference away: read `scores@2`, compare it
(`moves = rank_change(scores@2, scores, key=["unit"], by=[("score", "desc")], n=3)`),
answer from it, or make it current again with `scores = scores@2`. Saved
values are never recomputed from current files; if one is unavailable, the
action fails clearly. For the complete worked example, inspect reference with
topic=example and example=history.

```json
{"reasoning":"Check the earlier rule before reusing it.","actions":[{"type":"read","operator_ids":["scores@2"],"view":"sample_stats","columns":null,"include_implementation":true}]}
```

```json
{"reasoning":"Read the complete saved-version example.","actions":[{"type":"inspect","target":"reference","topic":"example","example":"history"}]}
```
