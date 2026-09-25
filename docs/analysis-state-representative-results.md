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

**Invalidated unisolated campaign. These scores are retained for audit and must not be used as accuracy evidence; see [the reference-access audit](analysis-state-reference-access-audit.json).**

First-pass results are primary. Recovery trials are separate; no best-of selection.
Model costs use repository cache-aware rates. Infrastructure is excluded.
Scoring models: gpt-5.2.

| Trial | Arm | Correct / judged / planned | Task macro | Model USD | Calls |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | dsgym | 67.0/209/209 | excluded | 0.9441 | 461 |
| 1 | dsgym-functions | 63/209/209 | excluded | 0.5828 | 360 |
| 1 | react-analysis | 0/0/65 | excluded | 0.0000 | 0 |
| 1 | react-entries | 0/0/35 | excluded | 0.0000 | 0 |
| 2 | dsgym | 83/209/209 | excluded | 0.9033 | 448 |
| 2 | dsgym-functions | 67/209/209 | excluded | 0.6423 | 392 |
| 3 | dsgym-functions | 0/35/167 | excluded | 0.1927 | 129 |

All recorded model spending: $3.2652.
Judge spending, including archived attempts: $0.9221 provider-reported + $6.8321 estimated from recorded tokens.
Unpriced judge responses: 0; failed requests without usage: 234 (billing unavailable).

| Trial | Arm | Task | Correct / judged / planned | Model USD |
| ---: | --- | --- | ---: | ---: |
| 1 | dsgym-functions | business__goodbooks_10k__task1 | 0/35/35 | 0.1483 |
| 1 | dsgym-functions | community__kaggle-survey-2022__task2 | 16/30/30 | 0.1196 |
| 1 | dsgym-functions | education__bi__task2 | 20/30/30 | 0.0344 |
| 1 | dsgym-functions | geoscience__water-potability__task3 | 7/36/36 | 0.0738 |
| 1 | dsgym-functions | social_good__data_science_for_good_city_of_los_angeles__task1 | 13/36/36 | 0.0668 |
| 1 | dsgym-functions | sports__nfl_big_data_bowl_2023__task1 | 7/42/42 | 0.1400 |
| 2 | dsgym-functions | business__goodbooks_10k__task1 | 0/35/35 | 0.2049 |
| 2 | dsgym-functions | community__kaggle-survey-2022__task2 | 14/30/30 | 0.1021 |
| 2 | dsgym-functions | education__bi__task2 | 29/30/30 | 0.0601 |
| 2 | dsgym-functions | geoscience__water-potability__task3 | 6/36/36 | 0.0555 |
| 2 | dsgym-functions | social_good__data_science_for_good_city_of_los_angeles__task1 | 0/36/36 | 0.0190 |
| 2 | dsgym-functions | sports__nfl_big_data_bowl_2023__task1 | 18/42/42 | 0.2009 |
| 3 | dsgym-functions | business__goodbooks_10k__task1 | 0/35/35 | 0.1537 |
| 3 | dsgym-functions | community__kaggle-survey-2022__task2 | 0/0/30 | 0.0000 |
| 3 | dsgym-functions | education__bi__task2 | 0/0/30 | 0.0390 |
| 3 | dsgym-functions | geoscience__water-potability__task3 | 0/0/36 | 0.0000 |
| 3 | dsgym-functions | social_good__data_science_for_good_city_of_los_angeles__task1 | 0/0/36 | 0.0000 |
| 1 | dsgym | business__goodbooks_10k__task1 | 0/35/35 | 0.2437 |
| 1 | dsgym | community__kaggle-survey-2022__task2 | 19/30/30 | 0.1232 |
| 1 | dsgym | education__bi__task2 | 24/30/30 | 0.0382 |
| 1 | dsgym | geoscience__water-potability__task3 | 11.0/36/36 | 0.1689 |
| 1 | dsgym | social_good__data_science_for_good_city_of_los_angeles__task1 | 9/36/36 | 0.2312 |
| 1 | dsgym | sports__nfl_big_data_bowl_2023__task1 | 4/42/42 | 0.1388 |
| 2 | dsgym | business__goodbooks_10k__task1 | 2/35/35 | 0.2486 |
| 2 | dsgym | community__kaggle-survey-2022__task2 | 18/30/30 | 0.0987 |
| 2 | dsgym | education__bi__task2 | 25/30/30 | 0.0464 |
| 2 | dsgym | geoscience__water-potability__task3 | 10/36/36 | 0.0781 |
| 2 | dsgym | social_good__data_science_for_good_city_of_los_angeles__task1 | 25/36/36 | 0.1221 |
| 2 | dsgym | sports__nfl_big_data_bowl_2023__task1 | 3/42/42 | 0.3094 |
| 1 | react-analysis | business__goodbooks_10k__task1 | 0/0/35 | 0.0000 |
| 1 | react-analysis | community__kaggle-survey-2022__task2 | 0/0/30 | 0.0000 |
| 1 | react-entries | business__goodbooks_10k__task1 | 0/0/35 | 0.0000 |
