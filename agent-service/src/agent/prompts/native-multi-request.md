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

Write each rule a request states as its own small function, with the rule's choices as keyword settings, and compose the rules with statements. A later request that changes one rule then needs one statement: set the rule's operator again with the new setting when the change holds from now on, so everything built on it follows, or give it a new ID when it is an alternative to compare, and build only the steps the question needs on it. Earlier tables keep their IDs; build on them or `show result` them rather than rebuilding them.

For example, a first request asks for the three units with the highest score, counting only units with at least five orders and weighting the order rate and the volume equally:

```python
def eligible_units(orders, *, min_orders=5):
    """Units with at least min_orders orders, with their share of orders and their volume."""
    units = orders.groupby('unit', as_index=False).agg(orders=('order_id', 'count'), volume=('value', 'sum'))
    units = units[units['orders'] >= min_orders]
    return units.assign(rate=units['orders'] / units['orders'].sum())

def unit_scores(units, *, rate_weight=0.5):
    """Score per unit: rate_weight times the rate percentile plus the rest times the volume percentile."""
    rate, volume = units['rate'].rank(pct=True), units['volume'].rank(pct=True)
    return units.assign(score=rate_weight * rate + (1 - rate_weight) * volume)
```

```text
set orders: scan(files='data/orders.csv')
set units: eligible_units(orders, min_orders=5)
set scores: unit_scores(units, rate_weight=0.5)
set ranked: sort(scores, by=[('score', 'desc')])
set top: limit(ranked, n=3)
show result top
```

A later request says that from now on a unit needs ten orders. The eligibility rule changes for everything after it, so set it again; `scores`, `ranked`, and `top` follow:

```text
set units: eligible_units(orders, min_orders=10)
show result top
```

Another asks how the leaders would change if the rate counted 70%. That is an alternative to compare, so the same function runs under new IDs beside the current ones:

```text
set scores_rate70: unit_scores(units, rate_weight=0.7)
set ranked_rate70: sort(scores_rate70, by=[('score', 'desc')])
set top_rate70: limit(ranked_rate70, n=3)
show result top, top_rate70
```
