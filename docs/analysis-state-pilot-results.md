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

**Development diagnostics only (University and Netflix); excluded from the representative comparison.**

First-pass results are primary. Recovery trials are separate; no best-of selection.
Model costs use repository cache-aware rates. Infrastructure is excluded.
Scoring models: gpt-5.2.

| Trial | Arm | Correct / judged / planned | Task macro | Model USD | Calls |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | dsgym | 4/57/57 | excluded | 0.2821 | 158 |
| 1 | dsgym-functions | 19/57/57 | excluded | 0.1584 | 102 |
| 1 | react-analysis | 3/57/57 | excluded | 0.6123 | 260 |
| 1 | react-entries | 9/57/57 | excluded | 0.4229 | 164 |

All recorded model spending: $1.4756.
Judge spending, including archived attempts: $0.5657 provider-reported + $1.6826 estimated from recorded tokens.
Unpriced judge responses: 0; failed requests without usage: 122 (billing unavailable).

| Trial | Arm | Task | Correct / judged / planned | Model USD |
| ---: | --- | --- | ---: | ---: |
| 1 | dsgym-functions | business__netflix_movies_and_tv_shows__task3 | 3/36/36 | 0.0893 |
| 1 | dsgym-functions | education__world_university_rankings__task2 | 16/21/21 | 0.0690 |
| 1 | dsgym | business__netflix_movies_and_tv_shows__task3 | 3/36/36 | 0.1972 |
| 1 | dsgym | education__world_university_rankings__task2 | 1/21/21 | 0.0849 |
| 1 | react-analysis | business__netflix_movies_and_tv_shows__task3 | 1/36/36 | 0.4845 |
| 1 | react-analysis | education__world_university_rankings__task2 | 2/21/21 | 0.1278 |
| 1 | react-entries | business__netflix_movies_and_tv_shows__task3 | 7/36/36 | 0.3406 |
| 1 | react-entries | education__world_university_rankings__task2 | 2/21/21 | 0.0823 |
