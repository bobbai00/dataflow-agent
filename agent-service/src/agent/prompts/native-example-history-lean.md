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

### Example: inspect and reuse an earlier result

The task asks for a temporary alternative to an earlier rule. First check
that rule and its table coverage:
```json
{"reasoning":"Inspect the earlier computation before choosing what to reuse.","actions":[{"type":"read","operator_ids":["scores@2"],"view":"sample_stats","columns":null,"include_implementation":true}]}
```
For an exact earlier table, connect `scores@2` directly. To change the old
computation for this task only, use `create operator variant from scores@2`,
then edit the variant. Its direct inputs remain saved references; explicitly
rewire them if the question needs today's data. Execute `["variant"]` and
answer from it. Keep the default operators unchanged.

For a permanent return to that rule, `update operator scores from scores@2`
keeps today's inputs and changes the default definition. Execute scores.
Saved values are never recomputed from current files. If unavailable, the
read fails clearly. For complete worked examples, inspect reference with
topic=example and example=history.

```json
{"reasoning":"Read the complete saved-version example.","actions":[{"type":"inspect","target":"reference","topic":"example","example":"history"}]}
```
