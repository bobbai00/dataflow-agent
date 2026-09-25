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

Updated 2026-09-24T21:05:55Z.
Benchmark rollout and judge usage for this implementation campaign, including pilots, invalidated attempts, first pass, and recovery trials. Older user experiments and unmetered development-assistant usage are excluded.
Repository cache-aware model rates; provider-reported judge charges where available, otherwise recorded GPT-5.2 usage at documented local proxy rates. Infrastructure excluded.
Recorded spending is a lower bound: some earlier cancelled Python/provider and judge requests returned no captured usage. Unknown charges are not represented as zero.

| Campaign | Sessions | Model USD | Judge USD |
| --- | ---: | ---: | ---: |
| LongDS_AnalysisPilot_20260924 | 8 | 1.4756 | 2.2483 |
| LongDS_Analysis_20260924 | 32 | 3.3494 | 7.7542 |
| LongDS_AnalysisInterrupted_20260924 | 3 | 0.0947 | 0.0000 |
| LongDS_IsolationSetup_20260924 | 9 | 0.1132 | 0.8895 |
| LongDS_IsolationIPC_20260924 | 3 | 0.0209 | 0.0000 |
| LongDS_IsolationInterrupted_20260924 | 26 | 3.1928 | 0.1153 |
| LongDS_IsolationInterrupted3_20260924 | 5 | 1.0046 | 0.0000 |
| LongDS_Isolated_20260924 | 70 | 13.4583 | 17.6217 |
| LongDS_IsolationDispatch_20260924 | 3 | 0.6874 | 0.2540 |

Total accounted spending: $52.2797; model $23.3968, judge provider-reported $1.4879, judge estimated $27.3950.
Unpriced judge responses: 0; failed requests without usage: 356.
