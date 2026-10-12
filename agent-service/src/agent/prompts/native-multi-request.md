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

## 5. Working across requests

Requests in this session are tasks, numbered from 1, that share one Dataflow and its registered functions. A later request usually changes one rule of the earlier work and keeps the others, or compares two versions of a rule.

Build each rule a request states as its own step, with the rule's choices written out as settings: a built-in when the rule is one line (a threshold in a filter, weights in a map, percentiles and group cutoffs in a window, groups in an aggregate), otherwise a Python function named for what it computes, with the rule's choices as keyword settings whose defaults keep the current behavior. Before you write a function, look for a registered one that already computes the step (task entries and receipts list them with their signatures) and call it with the settings the request needs; when a request needs a variant, add a keyword setting rather than a second function. A later request that changes one rule then needs one statement: set the rule's operator again with the new setting when the change holds from now on, so everything built on it follows, or give it a new ID when it is an alternative to compare, and build only the steps the question needs on it. Earlier tables keep their IDs; build on them or `show result` them rather than rebuilding them. Keep a request's answer apart from its rules: a function that reads the rule tables and returns the answer dict serves that request alone, while the rules it reads are what later requests reuse.

For example, a first request asks for the three units with the highest score, counting only units with at least five orders and weighting the order-count and volume percentiles equally:

```text
set orders: scan(files='data/orders.csv')
set units: aggregate(orders, by=['unit'], outputs={'orders': count(), 'volume': sum('value')})
set eligible: filter(units, lambda row: row['orders'] >= 5)
set graded: window(eligible, outputs={'orders_pct': pct_rank('orders'), 'volume_pct': pct_rank('volume')})
set scores: map(graded, lambda row: {**row, 'score': 0.5 * row['orders_pct'] + 0.5 * row['volume_pct']})
set ranked: sort(scores, by=[('score', 'desc'), 'unit'])
set top: limit(ranked, n=3)
show result top
```

A later request says that from now on a unit needs ten orders. The eligibility rule changes for everything after it, so set it again; `graded`, `scores`, `ranked`, and `top` follow:

```text
set eligible: filter(units, lambda row: row['orders'] >= 10)
show result top
```

Another asks how the leaders would change if the order count weighed 70%. That is an alternative to compare, so the new weights get new IDs beside the current ones:

```text
set scores_orders70: map(graded, lambda row: {**row, 'score': 0.7 * row['orders_pct'] + 0.3 * row['volume_pct']})
set ranked_orders70: sort(scores_orders70, by=[('score', 'desc'), 'unit'])
set top_orders70: limit(ranked_orders70, n=3)
show result top, top_orders70
```

A rule the built-ins cannot express, such as each unit's longest run of orders, becomes a function whose choices are settings, so a later request passes new ones:

```python
import pandas as pd

def order_runs(orders, *, gap_days=7):
    """Each unit's longest run of orders placed at most gap_days apart."""
    rows = []
    for unit, group in orders.sort_values('date').groupby('unit'):
        breaks = group['date'].diff().dt.days.gt(gap_days).cumsum()
        rows.append({'unit': unit, 'longest_run': int(breaks.value_counts().max())})
    return pd.DataFrame(rows)
```

```text
set runs: order_runs(orders, gap_days=7)
```
